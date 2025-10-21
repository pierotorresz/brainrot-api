// Brainrot API — claim/locks anti-colisión para 100+ bots
// Endpoints: /            (health)
//            /api/all     (listar feed)
//            /api/add     (agregar al feed)
//            /next        (siguiente con claim)
//            /release     (liberar claim)

import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== Almacen en memoria (1 instancia en Render) =====
let SERVERS = [];              // { jobId, players, maxPlayers, ts }
const LOCKS = new Map();       // jobId -> { bot, until }
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
  if (!bot || lk.bot === String(bot)) {
    LOCKS.delete(jobId);
    return true;
  }
  return false;
};

const selectServer = ({ maxPlayersCap = 40, minSlotsFree = 0, avoid = [] }) => {
  const avoidSet = new Set((avoid || []).filter(Boolean));
  for (const s of SERVERS) {
    if (!s?.jobId) continue;
    if (avoidSet.has(s.jobId)) continue;
    if (isLocked(s.jobId)) continue;

    const players = Number(s.players ?? 0);
    const maxP    = Number(s.maxPlayers ?? 40);
    if (maxP > maxPlayersCap) continue;
    if ((maxP - players) < minSlotsFree) continue;

    return s;
  }
  return null;
};

// ---------- Rutas ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, msg: "Brainrot API OK" });
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
    const cur = SERVERS.find(x => x.jobId === jobId);
    if (!cur) {
      SERVERS.push({
        jobId,
        players: it?.players ?? null,
        maxPlayers: it?.maxPlayers ?? null,
        ts: now()
      });
      added++;
    } else {
      cur.players = it?.players ?? cur.players;
      cur.maxPlayers = it?.maxPlayers ?? cur.maxPlayers;
      cur.ts = now();
    }
  }
  res.json({ ok: true, added, total: SERVERS.length });
});

// GET /next?claim=1&bot=Bot123&ttl=30000&minSlots=1&maxP=40&avoid=abc,def
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
        return res.status(409).json({ ok: false, reason: "claimed_by_other" });
      }
    }
    res.json({ ok: true, jobId: s.jobId, players: s.players, maxPlayers: s.maxPlayers, ttl });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "server_error" });
  }
});

// POST /release { jobId, bot }
app.post("/release", (req, res) => {
  const { jobId, bot } = req.body || {};
  if (!jobId) return res.status(400).json({ ok: false, error: "missing_jobId" });
  res.json({ ok: release(jobId, bot) });
});

// Limpieza periódica
setInterval(() => {
  for (const [k, v] of LOCKS.entries()) if (v.until <= now()) LOCKS.delete(k);
  const cutoff = now() - 30 * 60 * 1000; // 30 min
  SERVERS = SERVERS.filter(s => (s.ts || 0) >= cutoff);
}, 2000);

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log("Brainrot API running on :" + PORT));
