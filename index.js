// Brainrot API — ULTRA FEEDER + CLAIM/LOCKS + 3min cooldown + blacklist + frescura
// PlaceId fijo: 109983668079237

import express from "express";
import cors from "cors";
import http from "node:http";
import https from "node:https";

const PLACE_ID  = 109983668079237;
const POLL_MS   = 350; // cada 0.35s
const MAX_PAGES = 3;

// 🔧 Mantener servers recientes (2 min)
const KEEP_MIN  = 2 * 60 * 1000; 
// 🔧 Frescura máxima para seleccionar (solo servers detectados hace ≤60s)
const FRESH_MS  = 60 * 1000;
// 🔧 Cooldown 3 minutos: un JobId no puede ser reasignado antes de esto
const RECENT_USED_TTL = 3 * 60 * 1000;
// 🔧 Blacklist temporal de servers llenos/restringidos (60s)
const BAD_TTL = 60 * 1000;

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const gfetch = (url, opts={}) => {
  const agent = url.startsWith("https:") ? httpsAgent : httpAgent;
  return fetch(url, { ...opts, agent });
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------- Estado ----------
let SERVERS = [];
const IDX = new Map();
const LOCKS = new Map();
const RECENT_USED = new Map(); // jobId -> until (3 min)
const RECENT_BAD  = new Map(); // jobId -> until (60s)
let nextCursor = null;

const now = () => Date.now();
const DEFAULT_TTL_MS = 30000;

const isLocked = (jobId) => {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (lk.until <= now()) { LOCKS.delete(jobId); return false; }
  return true;
};
const claim = (jobId, bot, ttlMs = DEFAULT_TTL_MS) => {
  if (!jobId) return false;
  if (isLocked(jobId)) return false;
  LOCKS.set(jobId, { bot: String(bot || "unknown"), until: now() + ttlMs });
  RECENT_USED.set(jobId, now() + RECENT_USED_TTL); // registrar uso reciente (3min)
  return true;
};
const release = (jobId, bot, why) => {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (!bot || lk.bot === String(bot)) {
    LOCKS.delete(jobId);
    // si fue full/restricted, añadir al blacklist
    if (why && why.includes("restricted_or_full")) {
      RECENT_BAD.set(jobId, now() + BAD_TTL);
    }
    return true;
  }
  return false;
};
const upsert = (jobId, players, maxPlayers) => {
  if (!jobId) return;
  let i = IDX.get(jobId);
  if (i == null) {
    i = SERVERS.length;
    IDX.set(jobId, i);
    SERVERS.push({ jobId, players, maxPlayers, ts: now() });
  } else {
    const s = SERVERS[i];
    if (s) {
      s.players = players ?? s.players;
      s.maxPlayers = maxPlayers ?? s.maxPlayers;
      s.ts = now();
    }
  }
};

// ---------- Selectores ----------
const selectServer = ({ maxPlayersCap = 40, minSlotsFree = 0, avoid = [] }) => {
  const avoidSet = new Set(avoid.filter(Boolean));
  let best = null;
  let bestFree = -1;
  const tNow = now();

  for (const s of SERVERS) {
    if (!s || !s.jobId) continue;
    const jid = s.jobId;
    if (avoidSet.has(jid)) continue;
    if (isLocked(jid)) continue;
    if (RECENT_USED.get(jid) && RECENT_USED.get(jid) > tNow) continue; // cooldown 3min
    if (RECENT_BAD.get(jid) && RECENT_BAD.get(jid) > tNow) continue; // blacklist

    const age = tNow - (s.ts || 0);
    if (age > FRESH_MS) continue; // server viejo (>60s)
    const players = Number(s.players ?? 0);
    const maxP = Number(s.maxPlayers ?? 40);
    if (maxP > maxPlayersCap) continue;
    const free = maxP - players;
    if (free < minSlotsFree) continue;
    if (free > bestFree) { best = s; bestFree = free; }
  }
  return best;
};

// ---------- Rutas ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, msg: "Brainrot API OK", placeId: PLACE_ID, pollMs: POLL_MS });
});
app.get("/stats", (_req, res) => {
  res.json({
    ok: true,
    total: SERVERS.length,
    locks: LOCKS.size,
    recentUsed: RECENT_USED.size,
    bad: RECENT_BAD.size,
    pollMs: POLL_MS,
    cursorCached: !!nextCursor
  });
});
app.get("/api/all", (_req, res) => {
  res.json({ ok: true, total: SERVERS.length, servers: SERVERS });
});
app.get("/next", (req, res) => {
  try {
    const wantClaim = String(req.query.claim || "0") === "1";
    const bot = req.query.bot || "unknown";
    const ttl = Math.max(1000, Math.min(120000, Number(req.query.ttl || DEFAULT_TTL_MS)));
    const minSlots = Math.max(0, Number(req.query.minSlots || 0));
    const maxP = Math.max(1, Number(req.query.maxP || 40));
    const avoid = (req.query.avoid || "").toString().split(",").map(s => s.trim()).filter(Boolean);

    const s = selectServer({ maxPlayersCap: maxP, minSlotsFree: minSlots, avoid });
    if (!s) return res.status(204).send();
    if (wantClaim && !claim(s.jobId, bot, ttl)) return res.status(409).json({ ok: false, reason: "claimed_by_other" });
    res.json({ ok: true, jobId: s.jobId, players: s.players, maxPlayers: s.maxPlayers, ttl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});
app.post("/release", (req, res) => {
  const { jobId, bot, why } = req.body || {};
  if (!jobId) return res.status(400).json({ ok: false, error: "missing_jobId" });
  res.json({ ok: release(jobId, bot, why) });
});

// ---------- Limpieza periódica ----------
setInterval(() => {
  const tNow = now();
  for (const [k,v] of LOCKS.entries()) if (v.until <= tNow) LOCKS.delete(k);
  for (const [k,v] of RECENT_USED.entries()) if (v <= tNow) RECENT_USED.delete(k);
  for (const [k,v] of RECENT_BAD.entries()) if (v <= tNow) RECENT_BAD.delete(k);

  const cutoff = tNow - KEEP_MIN;
  for (let i = 0; i < SERVERS.length; i++) {
    const s = SERVERS[i];
    if (!s) continue;
    if ((s.ts || 0) < cutoff) { IDX.delete(s.jobId); SERVERS[i] = null; }
  }
  if (SERVERS.length > 3000) {
    const fresh = SERVERS.filter(Boolean);
    SERVERS = fresh;
    IDX.clear();
    for (let i = 0; i < SERVERS.length; i++) IDX.set(SERVERS[i].jobId, i);
  }
}, 1500);

// ---------- FEEDER ----------
async function fetchServersPage(placeId, cursor) {
  const base = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100`;
  const url  = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
  const r = await gfetch(url);
  if (!r.ok) throw new Error(`Roblox API ${r.status}`);
  return r.json();
}
async function ultraPoll() {
  try {
    let cursor = nextCursor || null;
    let pages = 0;
    while (pages < MAX_PAGES) {
      const json = await fetchServersPage(PLACE_ID, cursor);
      const arr = Array.isArray(json?.data) ? json.data : [];
      for (const it of arr) {
        const playing = Number(it.playing ?? 0);
        const maxP = Number(it.maxPlayers ?? 40);
        if (playing <= 0) continue;
        if (playing >= maxP) continue;
        upsert(it.id, playing, maxP);
      }
      cursor = json?.nextPageCursor || null;
      pages++;
      if (!cursor) break;
    }
    nextCursor = cursor || null;
  } catch {}
}
setInterval(ultraPoll, POLL_MS);
ultraPoll();

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Brainrot API on :${PORT} | place=${PLACE_ID} | poll=${POLL_MS}ms`));
