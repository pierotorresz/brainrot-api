// Brainrot API — ULTRA FEEDER + CLAIM/LOCKS
// Sticky lock 3m + preferir más huecos + frescura agresiva + blacklist de llenos
// PlaceId: 109983668079237

import express from "express";
import cors from "cors";
import http from "node:http";
import https from "node:https";

const PLACE_ID  = 109983668079237;

// --------- Timings / políticas ----------
const POLL_MS   = 350;                 // feed cada 0.35s
const MAX_PAGES = 3;                   // páginas por vuelta

const KEEP_MIN  = 2 * 60 * 1000;       // mantener servers en memoria 2 min
const FRESH_MS  = 45 * 1000;           // seleccionar sólo servers vistos <= 45s
const RECENT_USED_TTL = 3 * 60 * 1000; // sticky lock: no reasignar por 3 min
const BAD_TTL   = 60 * 1000;           // “lleno/restringido” → blacklist 60s

const DEFAULT_TTL_MS = 30_000;         // claim TTL (hopper usa 30–45s)

// --------- Infra ----------
const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const gfetch = (url, opts={}) => {
  const agent = url.startsWith("https:") ? httpsAgent : httpAgent;
  return fetch(url, { ...opts, agent });
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --------- Estado en memoria (1 instancia!) ----------
let SERVERS = [];               // [{ jobId, players, maxPlayers, ts }]
const IDX = new Map();          // jobId -> index
const LOCKS = new Map();        // jobId -> { bot, until }
const RECENT_USED = new Map();  // jobId -> until (sticky 3m)
const RECENT_BAD  = new Map();  // jobId -> until (lleno/restringido 60s)
let nextCursor = null;

const now = () => Date.now();

// --------- Helpers lock/claim ----------
const isLocked = (jobId) => {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (lk.until <= now()) { LOCKS.delete(jobId); return false; }
  return true;
};

const claim = (jobId, bot, ttlMs = DEFAULT_TTL_MS) => {
  if (!jobId) return false;
  // si ya está sticky o en blacklist → no asignar
  const t = now();
  if ((RECENT_USED.get(jobId) || 0) > t) return false;
  if ((RECENT_BAD.get(jobId)  || 0) > t) return false;
  if (isLocked(jobId)) return false;
  LOCKS.set(jobId, { bot: String(bot || "unknown"), until: t + ttlMs });
  // STICKY: marque que esta jobId no se puede entregar a nadie por 3 min
  RECENT_USED.set(jobId, t + RECENT_USED_TTL);
  return true;
};

// Nota: ¡NO borramos RECENT_USED en release! → sticky real
const release = (jobId, bot, why) => {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (!bot || lk.bot === String(bot)) {
    LOCKS.delete(jobId);
    // si fue full/restricted → blacklist temporal
    if (why && String(why).includes("restricted_or_full")) {
      RECENT_BAD.set(jobId, now() + BAD_TTL);
    }
    return true;
  }
  return false;
};

const upsert = (jobId, players, maxPlayers) => {
  if (!jobId) return;
  const i = IDX.get(jobId);
  if (i == null) {
    IDX.set(jobId, SERVERS.length);
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

// --------- Selector: frescura + más huecos + evita sticky/bad/locks ----------
const selectServer = ({ maxPlayersCap = 40, minSlotsFree = 0, avoid = [] }) => {
  const avoidSet = new Set((avoid || []).filter(Boolean));
  let best = null;
  let bestScore = -1;
  const tNow = now();

  for (const s of SERVERS) {
    if (!s || !s.jobId) continue;
    const jid = s.jobId;

    if (avoidSet.has(jid)) continue;
    if ((RECENT_USED.get(jid) || 0) > tNow) continue; // sticky 3m
    if ((RECENT_BAD.get(jid)  || 0) > tNow) continue; // blacklist 60s
    if (isLocked(jid)) continue;

    // frescura
    const age = tNow - (s.ts || 0);
    if (age > FRESH_MS) continue;

    const players = Number(s.players ?? 0);
    const maxP    = Number(s.maxPlayers ?? 40);
    if (maxP > maxPlayersCap) continue;

    const free = maxP - players;
    if (free < minSlotsFree) continue;

    // score: prioriza más huecos; a igualdad, el más reciente
    const score = free * 100000 + (FRESH_MS - age);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
};

// --------- Rutas ----------
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    msg: "Brainrot API OK",
    placeId: PLACE_ID,
    pollMs: POLL_MS,
    instance: process.env.RENDER_INSTANCE_ID || process.pid
  });
});

app.get("/stats", (_req, res) => {
  res.json({
    ok: true,
    total: SERVERS.length,
    locks: LOCKS.size,
    recentUsed: RECENT_USED.size,
    bad: RECENT_BAD.size,
    pollMs: POLL_MS,
    cursorCached: !!nextCursor,
    instance: process.env.RENDER_INSTANCE_ID || process.pid
  });
});

app.get("/api/all", (_req, res) => {
  res.json({ ok: true, total: SERVERS.length, servers: SERVERS });
});

// GET /next?claim=1&bot=BOT&ttl=30000&minSlots=2&maxP=40&avoid=a,b
app.get("/next", (req, res) => {
  try {
    const wantClaim = String(req.query.claim || "0") === "1";
    const bot       = req.query.bot || "unknown";
    const ttl       = Math.max(1000, Math.min(120000, Number(req.query.ttl || DEFAULT_TTL_MS)));
    const minSlots  = Math.max(0, Number(req.query.minSlots || 0));
    const maxP      = Math.max(1, Number(req.query.maxP || 40));
    const avoid     = (req.query.avoid || "").toString().split(",").map(s => s.trim()).filter(Boolean);

    const s = selectServer({ maxPlayersCap: maxP, minSlotsFree: minSlots, avoid });
    if (!s) return res.status(204).send();

    if (wantClaim) {
      if (!claim(s.jobId, bot, ttl)) {
        return res.status(409).json({ ok: false, reason: "claimed_by_other_or_sticky" });
      }
    }
    res.json({ ok: true, jobId: s.jobId, players: s.players, maxPlayers: s.maxPlayers, ttl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// POST /release { jobId, bot, why }
app.post("/release", (req, res) => {
  const { jobId, bot, why } = req.body || {};
  if (!jobId) return res.status(400).json({ ok: false, error: "missing_jobId" });
  res.json({ ok: release(jobId, bot, why) });
});

// --------- Limpieza periódica ----------
setInterval(() => {
  const t = now();
  for (const [k,v] of LOCKS.entries()) if (v.until <= t) LOCKS.delete(k);
  for (const [k,v] of RECENT_USED.entries()) if (v <= t) RECENT_USED.delete(k);
  for (const [k,v] of RECENT_BAD.entries())  if (v <= t) RECENT_BAD.delete(k);

  const cutoff = t - KEEP_MIN;
  for (let i = 0; i < SERVERS.length; i++) {
    const s = SERVERS[i];
    if (!s) continue;
    if ((s.ts || 0) < cutoff) { IDX.delete(s.jobId); SERVERS[i] = null; }
  }
  // Compactar si se infla mucho
  if (SERVERS.length > 3000) {
    const fresh = SERVERS.filter(Boolean);
    SERVERS = fresh;
    IDX.clear();
    for (let i = 0; i < SERVERS.length; i++) IDX.set(SERVERS[i].jobId, i);
  }
}, 1500);

// --------- FEEDER Roblox ----------
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
        const maxP    = Number(it.maxPlayers ?? 40);
        if (playing <= 0) continue;     // evita vacíos
        if (playing >= maxP) continue;  // evita llenos
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

// --------- Start ----------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Brainrot API :${PORT} | place=${PLACE_ID} | poll=${POLL_MS}ms | sticky=3m fresh=45s keep=2m`);
});
