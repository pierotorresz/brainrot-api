// index.js — Brainrot API with claim/locks (Render ready)
// by Piero + Joszz (adapt) — Zero-collision feed for 100+ bots

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== In-memory store (Render free plan: 1 dyno) =====
// Si usas varios dynos, necesitarás un KV/DB central (Upstash/Redis, etc.)
let SERVERS = [];              // { jobId, players, maxPlayers, ts }
const LOCKS = new Map();       // jobId -> { bot, until: epoch_ms }
const DEFAULT_TTL_MS = 30_000; // 30s reserva por default

function now() { return Date.now(); }
function isLocked(jobId) {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (lk.until <= now()) { LOCKS.delete(jobId); return false; }
  return true;
}
function claim(jobId, bot, ttlMs = DEFAULT_TTL_MS) {
  if (!jobId) return false;
  if (isLocked(jobId)) return false;
  LOCKS.set(jobId, { bot: String(bot || "unknown"), until: now() + ttlMs });
  return true;
}
function release(jobId, bot) {
  const lk = LOCKS.get(jobId);
  if (!lk) return false;
  if (!bot || lk.bot === String(bot)) {
    LOCKS.delete(jobId);
    return true;
  }
  return false;
}

// ===== Helpers =====
function selectServer({ maxPlayersCap = 40, minSlotsFree = 0, avoid = [] }) {
  const avoidSet = new Set((avoid || []).filter(Boolean));
  for (const s of SERVERS) {
    if (!s?.jobId) continue;
    if (avoidSet.has(s.jobId)) continue;
    if (isLocked(s.jobId)) continue;

    // filtros opcionales
    const players = Number(s.players ?? 0);
    const maxP    = Number(s.maxPlayers ?? 40);
    if (maxP > maxPlayersCap) continue;
    if ((maxP - players) < minSlotsFree) continue;

    return s;
  }
  return null;
}

// ===== Endpoints legacy =====
app.get("/api/all", (_req, res) => {
  res.json({ ok: true, total: SERVERS.length, servers: SERVERS });
});

app.post("/api/add", (req, res) => {
  // admite 1 o lista
  const items = Array.isArray(req.body) ? req.body : [req.body];
  let added = 0;
  for (const it of items) {
    const jobId = it?.jobId || it?.serverId || it?.id || it?.jobid;
    if (!jobId) continue;
    if (!SERVERS.find(x => x.jobId === jobId)) {
      SERVERS.push({
        jobId,
        players: it?.players ?? null,
        maxPlayers: it?.maxPlayers ?? null,
        ts: now()
      });
      added++;
    } else {
      // opcional: refrescar meta
      const ref = SERVERS.find(x => x.jobId === jobId);
      ref.players = it?.players ?? ref.players;
      ref.maxPlayers = it?.maxPlayers ?? ref.maxPlayers;
      ref.ts = now();
    }
  }
  res.json({ ok: true, added, total: SERVERS.length });
});

// ===== Nuevo: /next con reserva (claim) =====
// GET /next?claim=1&bot=MyBot123&ttl=30000&minSlots=1&maxP=40&avoid=job1,job2
app.get("/next", (req, res) => {
  try {
    const wantClaim = String(req.query.claim || "0") === "1";
    const bot       = req.query.bot || "unknown";
    const ttl       = Math.max(1000, Math.min(120000, Number(req.query.ttl || DEFAULT_TTL_MS)));
    const minSlots  = Math.max(0, Number(req.query.minSlots || 0));
    const maxP      = Math.max(1, Number(req.query.maxP || 40));
    const avoid     = (req.query.avoid || "").toString().split(",").map(s => s.trim()).filter(Boolean);

    const s = selectServer({ maxPlayersCap: maxP, minSlotsFree: minSlots, avoid });
    if (!s) return res.status(204).send(); // sin contenido ahora

    if (wantClaim) {
      if (!claim(s.jobId, bot, ttl)) {
        return res.status(409).json({ ok: false, reason: "claimed_by_other" });
      }
    }
    return res.json({ ok: true, jobId: s.jobId, players: s.players, maxPlayers: s.maxPlayers, ttl });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// Liberar manualmente una reserva (si aborta hop, etc.)
// POST /release { jobId, bot }
app.post("/release", (req, res) => {
  const { jobId, bot } = req.body || {};
  if (!jobId) return res.status(400).json({ ok: false, error: "missing jobId" });
  const ok = release(jobId, bot);
  res.json({ ok });
});

// ===== Limpieza: expirar locks viejos y podar feed viejo =====
setInterval(() => {
  // expirar locks
  for (const [k, v] of LOCKS.entries()) if (v.until <= now()) LOCKS.delete(k);
  // podar feed muy viejo (opcional)
  const cutoff = now() - 60_000 * 30; // 30 min
  SERVERS = SERVERS.filter(s => (s.ts || 0) >= cutoff);
}, 2_000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log("Brainrot API running on :"+PORT));
