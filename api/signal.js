// api/signal.js
// Vercel serverless function - receives TradingView webhook alerts from all
// 3 strategies. Handles two event types:
//   1. Entry signals (default) - full message with entry/SL/TP1/TP2 levels
//   2. "tp1_hit" events - a short follow-up notification when price actually
//      touches the TP1 level during an open trade (fired separately by the
//      Pine script's TP1-hit detection block)
// Posts both types to that strategy's own "master" channel AND the shared
// combined target channel (GoldMine).
 
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SHARED_SECRET = process.env.WEBHOOK_SECRET;
 
// ---- Per-strategy config: chat IDs and display identity ----
const STRATEGY_CONFIG = {
  "464": {
    label: "Strategy 464",
    emoji_buy: "🟢",
    emoji_sell: "🔴",
    master_chat_id: "-1003935839699",
  },
  "500": {
    label: "Strategy 500",
    emoji_buy: "🟩",
    emoji_sell: "🟥",
    master_chat_id: "-1004405511675",
  },
  "101": {
    label: "Strategy 101",
    emoji_buy: "🔵",
    emoji_sell: "🟠",
    master_chat_id: "-1004465983581",
  },
};
 
const TARGET_CHAT_ID = "-1004395242257"; // GoldMine - the combined channel
 
// XAUUSD pip convention for VT Markets / HeroFX: the first decimal place is
// the pip (e.g. 4368.89 -> the "8" is the pip digit). So 1 pip = $0.10.
const PIP_SIZE = 0.1;
 
function toPips(priceDiff) {
  return Math.round(priceDiff / PIP_SIZE);
}
 
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
 
function formatEntryMessage(payload, config) {
  const isBuy = payload.direction?.toLowerCase() === "buy";
  const dirWord = isBuy ? "BUY" : "SELL";
 
  const entry = Number(payload.entry);
  const sl = Number(payload.sl);
  const slPips = toPips(Math.abs(entry - sl));
 
  // Hardcode XAUUSD for display regardless of the chart's ticker prefix
  // (e.g. "VANTAGE:XAUUSD"), since gold is the only instrument this is
  // built and validated on.
  const symbolDisplay = "XAUUSD";
 
  const hasTwoTargets = payload.tp1 !== undefined && payload.tp2 !== undefined;
 
  if (hasTwoTargets) {
    const tp1 = Number(payload.tp1);
    const tp2 = Number(payload.tp2);
    return (
      `${dirWord} ${symbolDisplay}\n` +
      `SL - ${sl.toFixed(2)} (${slPips} pips)\n\n` +
      `TP1 - ${tp1.toFixed(2)}\n` +
      `TP2 - ${tp2.toFixed(2)}`
    );
  }
 
  const tp = Number(payload.tp);
  return (
    `${dirWord} ${symbolDisplay}\n` +
    `SL - ${sl.toFixed(2)} (${slPips} pips)\n\n` +
    `TP - ${tp.toFixed(2)}`
  );
}
 
const TP1_HIT_PHRASES = [
  () => `TP1 hit 🎯`,
  () => `First target smashed 😶‍🌫️`,
];
 
function formatTp1HitMessage(payload) {
  const base = pick(TP1_HIT_PHRASES)();
  const entry = Number(payload.entry);
  const tp1 = Number(payload.tp1);
  if (Number.isNaN(entry) || Number.isNaN(tp1)) return base;
  const pips = toPips(Math.abs(tp1 - entry));
  return `${base} (+${pips} pips)`;
}
 
// Multiple phrasings per outcome, picked at random, so the channel doesn't
// read like a bot repeating the exact same line every time. Losses stay
// matter-of-fact rather than apologetic; wins get a touch more energy but
// nothing over the top - this is a serious product, not hype.
const TP2_HIT_PHRASES = [
  () => `FULL TP HIT 🚀`,
  () => `Full target reached, TP2 smashed 💰`,
  () => `TP2 hit 🤑`,
];
 
const SL_HIT_PHRASES = [
  () => `Stopped out, onto the next`,
  () => `Out by market, part of the process`,
  () => `SL hit 🙏`,
];
 
const EARLY_EXIT_PHRASES = [
  () => `Close position fully`,
];
 
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
 
function formatTradeClosedMessage(payload) {
  if (payload.outcome === "early_exit") {
    return pick(EARLY_EXIT_PHRASES)();
  }
 
  const phraseSet = payload.outcome === "tp2_hit" ? TP2_HIT_PHRASES : SL_HIT_PHRASES;
  const base = pick(phraseSet)();
 
  const entry = Number(payload.entry_price);
  const exit = Number(payload.exit_price);
  if (Number.isNaN(entry) || Number.isNaN(exit)) return base;
 
  const rawPips = toPips(exit - entry); // positive = profit, negative = loss (long-only)
  const sign = rawPips >= 0 ? "+" : "";
  return `${base} (${sign}${rawPips} pips)`;
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
 
  // --- Branch: TP1-hit notification (no entry/SL/TP fields to validate) ---
  if (payload.event === "tp1_hit") {
    const dedupeKey = `${payload.source}-${payload.symbol}-tp1hit-${payload.time}`;
    if (isDuplicate(dedupeKey)) {
      return res.status(200).json({ status: "duplicate ignored" });
    }
    const text = formatTp1HitMessage(payload);
    const results = await Promise.all([
      sendToTelegram(config.master_chat_id, text),
      sendToTelegram(TARGET_CHAT_ID, text),
    ]);
    return res.status(200).json({ status: "sent (tp1_hit)", results });
  }
 
  // --- Branch: trade closed (SL / TP2 / early exit) ---
  if (payload.event === "trade_closed") {
    const dedupeKey = `${payload.source}-${payload.symbol}-closed-${payload.time}`;
    if (isDuplicate(dedupeKey)) {
      return res.status(200).json({ status: "duplicate ignored" });
    }
    const text = formatTradeClosedMessage(payload);
    const results = await Promise.all([
      sendToTelegram(config.master_chat_id, text),
      sendToTelegram(TARGET_CHAT_ID, text),
    ]);
    return res.status(200).json({ status: "sent (trade_closed)", results });
  }
 
  // --- Default branch: entry signal ---
 
  // Sanity checks on the trade levels before anything gets sent. Handles
  // both payload shapes: two-target (tp1 + tp2) and single-target (tp only).
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
 
  const dedupeKey = `${payload.source}-${payload.symbol}-${payload.direction}-${payload.time}`;
  if (isDuplicate(dedupeKey)) {
    return res.status(200).json({ status: "duplicate ignored" });
  }
 
  const text = formatEntryMessage(payload, config);
  const results = await Promise.all([
    sendToTelegram(config.master_chat_id, text),
    sendToTelegram(TARGET_CHAT_ID, text),
  ]);
 
  // --- TODO: log to Supabase here (entry, sl, tp1, tp2, source, fired_at) ---
  // This is what becomes your published track record - see Phase 4 of the
  // build plan. Wire this in before this goes anywhere near real members.
 
  return res.status(200).json({ status: "sent", results });
}
