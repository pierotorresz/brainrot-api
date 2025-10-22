// Brainrot API — ULTRA FEEDER + CLAIM/LOCKS + (FIX) poda rápida + filtrar vacíos
// PlaceId fijo: 109983668079237

import express from "express";
import cors from "cors";
import http from "node:http";
import https from "node:https";

const PLACE_ID  = 109983668079237;
const POLL_MS   = Math.max(200, Number(process.env.POLL_MS || 350)); // ~0.35s
const MAX_PAGES = Math.max(1, Math.min(6, Number(process.env.MAX_PAGES || 3)));

// ✅ FIX 1: reducir retención de servers en memoria (antes 30 min → ahora 5 min)
const KEEP_MIN  = 5 * 60 * 1000; // 5 min

const httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });
const gfetch = (url, opts={}) => {
  const agent = url.startsWith("https:") ? httpsAgent : httpAgent;
  return fetch(url, { ...opts, agent });
};

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let SERVERS = [];                 // [{jobId, players, maxPlayers, ts}]
const IDX   = new Map();          // jobId -> index
const LOCKS = new Map();          // jobId -> { bot, until }
let nextCursor = null;
let PREVIEW_IDX = 0;              // para rotar en preview (inspección desde el navegador)

const DEFAULT_TTL_MS = 30_000;
const now = () => Date.now();

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
  return true;
};

const release = (jobId, bot) => {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (!bot || lk.bot === String(bot)) { LOCKS.delete(jobId); return true; }
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
      s.players    = (players ?? s.players);
      s.maxPlayers = (maxPlayers ?? s.maxPlayers);
      s.ts         = now();
    }
  }
};

const selectServer = ({ maxPlayersCap = 40, minSlotsFree = 0, avoid = [] }) => {
  const avoidSet = new Set((avoid || []).filter(Boolean));
  for (let i = 0; i < SERVERS.length; i++) {
    const s = SERVERS[i]; if (!s) continue;
    const jid = s.jobId; if (!jid) continue;
    if (avoidSet.has(jid)) continue;
    if (isLocked(jid)) continue;

    const players = Number(s.players ?? 0);
    const maxP    = Number(s.maxPlayers ?? 40);
    if (maxP > maxPlayersCap) continue;
    if ((maxP - players) < minSlotsFree) continue;

    return s;
  }
  return null;
};

// Modo preview: rota circularmente y no mira locks (solo para inspección en navegador)
const selectServerPreview = ({ maxPlayersCap = 40, minSlotsFree = 0 }) => {
  if (!SERVERS.length) return null;
  let tries = 0;
  const start = PREVIEW_IDX % Math.max(1, SERVERS.length);
  let idx = start;
  while (tries < SERVERS.length) {
    const s = SERVERS[idx];
    if (s && s.jobId) {
      const players = Number(s.players ?? 0);
      const maxP    = Number(s.maxPlayers ?? 40);
      if (maxP <= maxPlayersCap && (maxP - players) >= minSlotsFree) {
        PREVIEW_IDX = (idx + 1) % Math.max(1, SERVERS.length);
        return s;
      }
    }
    idx = (idx + 1) % Math.max(1, SERVERS.length);
    tries++;
  }
  return null;
};

// ---------- Rutas ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, msg: "Brainrot API OK", placeId: PLACE_ID, pollMs: POLL_MS, maxPages: MAX_PAGES });
});

app.get("/stats", (_req, res) => {
  res.json({ ok: true, total: SERVERS.length, locks: LOCKS.size, pollMs: POLL_MS, cursorCached: !!nextCursor });
});

app.get("/api/all", (_req, res) => {
  res.json({ ok: true, total: SERVERS.length, servers: SERVERS });
});

app.post("/api/add", (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  let added = 0;
  for (const it of items) {
    const jobId = it?.jobId || it?.serverId || it?.id || it?.jobid;
    if (!jobId) continue;
    upsert(jobId, it?.players ?? null, it?.maxPlayers ?? null);
    added++;
  }
  res.json({ ok: true, added, total: SERVERS.length });
});

// GET /next?claim=1&bot=X&ttl=30000&minSlots=1&maxP=40&avoid=a,b
// GET /next?preview=1&minSlots=1&maxP=40   <-- rota sin claim ni locks (para inspección desde el navegador)
app.get("/next", (req, res) => {
  try {
    const preview   = String(req.query.preview || "0") === "1";
    const wantClaim = String(req.query.claim   || "0") === "1";
    const bot       = req.query.bot || "unknown";
    const ttl       = Math.max(1000, Math.min(120000, Number(req.query.ttl || DEFAULT_TTL_MS)));
    const minSlots  = Math.max(0, Number(req.query.minSlots  || 0));
    const maxP      = Math.max(1, Number(req.query.maxP      || 40));
    const avoid     = (req.query.avoid || "").toString().split(",").map(s => s.trim()).filter(Boolean);

    let s = null;
    if (preview) {
      s = selectServerPreview({ maxPlayersCap: maxP, minSlotsFree: minSlots });
    } else {
      s = selectServer({ maxPlayersCap: maxP, minSlotsFree: minSlots, avoid });
    }

    if (!s) return res.status(204).send();
    if (!preview && wantClaim) {
      if (!claim(s.jobId, bot, ttl)) return res.status(409).json({ ok: false, reason: "claimed_by_other" });
    }
    res.json({ ok: true, jobId: s.jobId, players: s.players, maxPlayers: s.maxPlayers, ttl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

app.post("/release", (req, res) => {
  const { jobId, bot } = req.body || {};
  if (!jobId) return res.status(400).json({ ok: false, error: "missing_jobId" });
  res.json({ ok: release(jobId, bot) });
});

// ---------- Mantenimiento (locks + poda) ----------
setInterval(() => {
  // Expirar locks vencidos
  for (const [k, v] of LOCKS.entries()) if (v.until <= now()) LOCKS.delete(k);

  // ✅ FIX 2: poda rápida de servers viejos (KEEP_MIN = 5 min)
  const cutoff = now() - KEEP_MIN;
  for (let i = 0; i < SERVERS.length; i++) {
    const s = SERVERS[i]; if (!s) continue;
    if ((s.ts || 0) < cutoff) {
      IDX.delete(s.jobId);
      SERVERS[i] = null;
    }
  }

  // Compactar si hay muchos huecos
  if (SERVERS.length > 4000) {
    const fresh = [];
    for (const s of SERVERS) if (s) fresh.push(s);
    SERVERS = fresh;
    IDX.clear();
    for (let i = 0; i < SERVERS.length; i++) IDX.set(SERVERS[i].jobId, i);
    PREVIEW_IDX = PREVIEW_IDX % Math.max(1, SERVERS.length);
  }
}, 1500);

// ---------- FEEDER ultra-rápido (Roblox Public Servers) ----------
async function fetchServersPage(placeId, cursor) {
  const base = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100`;
  const url  = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
  const r    = await gfetch(url, { method: "GET" });
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

        // ✅ FIX 3: ignorar servers vacíos o llenos
        if (playing <= 0) continue;      // evita vacíos o cerrados
        if (playing >= maxP) continue;   // evita llenos

        upsert(it.id, playing, maxP);
      }

      cursor = json?.nextPageCursor || null;
      pages++;
      if (!cursor) break;
    }
    nextCursor = cursor || null; // cursor rotativo
  } catch (_e) { /* silencioso */ }
}

setInterval(ultraPoll, POLL_MS);
ultraPoll();

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Brainrot API :${PORT} | place=${PLACE_ID} | poll=${POLL_MS}ms | pages=${MAX_PAGES}`));
