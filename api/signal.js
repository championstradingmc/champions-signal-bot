// api/signal.js
// Vercel serverless function - receives TradingView webhook alerts from all
// 3 strategies, formats a message per strategy's style, and posts to BOTH
// that strategy's own "master" channel AND the shared combined target channel.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHARED_SECRET = process.env.WEBHOOK_SECRET;

// ---- Per-strategy config: chat IDs and display identity ----
// Fill in the real channel IDs once you've created them in Telegram
// (see Phase 1 of the build plan for how to get a channel's chat_id).
const STRATEGY_CONFIG = {
  "464": {
    label: "Strategy A",
    emoji_buy: "🟢",
    emoji_sell: "🔴",
    master_chat_id: "-100XXXXXXXXX1",   // Strategy 464's own channel
  },
  "500": {
    label: "Strategy B",
    emoji_buy: "🟩",
    emoji_sell: "🟥",
    master_chat_id: "-100XXXXXXXXX2",   // Strategy 500's own channel
  },
  "101": {
    label: "Strategy C",
    emoji_buy: "🔵",
    emoji_sell: "🟠",
    master_chat_id: "-100XXXXXXXXX3",   // Strategy 101's own channel
  },
};

const TARGET_CHAT_ID = "-100XXXXXXXXX0"; // the combined channel every signal also goes to

// Simple in-memory de-dupe (resets on cold start - fine for catching
// TradingView's occasional duplicate fires within the same request burst).
const recentSignals = new Map();
const DEDUPE_WINDOW_MS = 60 * 1000;

function isDuplicate(key) {
  const now = Date.now();
  for (const [k, t] of recentSignals) {
    if (now - t > DEDUPE_WINDOW_MS) recentSignals.delete(k);
  }
  if (recentSignals.has(key)) return true;
  recentSignals.set(key, now);
  return false;
}

function formatMessage(payload, config) {
  const isBuy = payload.direction?.toLowerCase() === "buy";
  const emoji = isBuy ? config.emoji_buy : config.emoji_sell;
  const dirWord = isBuy ? "BUY" : "SELL";

  const entry = Number(payload.entry);
  const sl = Number(payload.sl);
  const slDist = Math.abs(entry - sl).toFixed(2);

  // Two-target strategies (e.g. 464, 500) send tp1 + tp2.
  // Single-target strategies (e.g. 101, where RR is too thin to split
  // usefully) send just tp. Format each shape accordingly.
  const hasTwoTargets = payload.tp1 !== undefined && payload.tp2 !== undefined;

  if (hasTwoTargets) {
    const tp1 = Number(payload.tp1);
    const tp2 = Number(payload.tp2);
    const tp1Dist = Math.abs(tp1 - entry).toFixed(2);
    const tp2Dist = Math.abs(tp2 - entry).toFixed(2);

    return (
      `${emoji} ${dirWord} ${payload.symbol} — ${config.label}\n\n` +
      `Entry: ${entry.toFixed(2)}\n` +
      `SL:    ${sl.toFixed(2)}   (-${slDist})\n` +
      `TP1:   ${tp1.toFixed(2)}   (+${tp1Dist}, 1R)\n` +
      `TP2:   ${tp2.toFixed(2)}   (+${tp2Dist})\n\n` +
      `Risk 1R. TP1 is an early exit for banking profit early — TP2 is the system's actual validated target for the full position.`
    );
  }

  // Single-target format
  const tp = Number(payload.tp);
  const tpDist = Math.abs(tp - entry).toFixed(2);

  return (
    `${emoji} ${dirWord} ${payload.symbol} — ${config.label}\n\n` +
    `Entry: ${entry.toFixed(2)}\n` +
    `SL:    ${sl.toFixed(2)}   (-${slDist})\n` +
    `TP:    ${tp.toFixed(2)}   (+${tpDist})\n\n` +
    `Risk 1R, single target.`
  );
}

async function sendToTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`Telegram send failed for chat ${chatId}:`, body);
  }
  return res.ok;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const payload = req.body;

  // --- Auth check ---
  if (!payload || payload.secret !== SHARED_SECRET) {
    return res.status(401).json({ error: "Invalid or missing secret" });
  }

  const config = STRATEGY_CONFIG[payload.source];
  if (!config) {
    console.error("Unknown strategy source:", payload.source);
    return res.status(400).json({ error: "Unknown source strategy" });
  }

  // --- Sanity checks on the trade levels before anything gets sent ---
  // Handles both payload shapes: two-target (tp1 + tp2, e.g. 464/500) and
  // single-target (tp only, e.g. 101).
  const entry = Number(payload.entry);
  const sl = Number(payload.sl);
  const hasTwoTargets = payload.tp1 !== undefined && payload.tp2 !== undefined;
  const targets = hasTwoTargets
    ? [Number(payload.tp1), Number(payload.tp2)]
    : [Number(payload.tp)];

  if ([entry, sl, ...targets].some((v) => Number.isNaN(v))) {
    return res.status(400).json({ error: "Non-numeric price levels" });
  }
  const isBuy = payload.direction?.toLowerCase() === "buy";
  const slOnWrongSide = isBuy ? sl >= entry : sl <= entry;
  const anyTargetOnWrongSide = targets.some((tp) => (isBuy ? tp <= entry : tp >= entry));
  if (slOnWrongSide || anyTargetOnWrongSide) {
    console.error("Malformed signal rejected:", payload);
    return res.status(400).json({ error: "SL/TP on wrong side of entry" });
  }

  // --- De-duplicate ---
  const dedupeKey = `${payload.source}-${payload.symbol}-${payload.direction}-${payload.time}`;
  if (isDuplicate(dedupeKey)) {
    return res.status(200).json({ status: "duplicate ignored" });
  }

  // --- Format and send: this strategy's own channel + the combined target ---
  const text = formatMessage(payload, config);
  const results = await Promise.all([
    sendToTelegram(config.master_chat_id, text),
    sendToTelegram(TARGET_CHAT_ID, text),
  ]);

  // --- TODO: log to Supabase here (entry, sl, tp1, tp2, source, fired_at) ---
  // This is what becomes your published track record - see Phase 4 of the
  // build plan. Wire this in before this goes anywhere near real members.

  return res.status(200).json({ status: "sent", results });
}
