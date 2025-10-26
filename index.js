// index.js — EN+ Brainrot Pool API (Render/Railway ready)
// Autor: JOSZZ | 2025
// ✔ Compatible con tu hopper.lua y external_scanner_node.js
// ✔ Endpoints: /api/report, /api/next, /api/confirm, /api/release, /api/stats
// ✔ Lease/locks + recentUsed (veto) + filtros <players & edad máxima>

"use strict";

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

// ===== ENV =====
const PORT                      = Number(process.env.PORT || 10000);
const API_KEY                   = process.env.API_KEY || "changeme";

const MAX_PER_PLACE             = Number(process.env.MAX_PER_PLACE || 1000);

const LOCK_LEASE_SEC            = Number(process.env.LOCK_LEASE_SEC || 45);
const LOCK_HEARTBEAT_EXTEND_SEC = Number(process.env.LOCK_HEARTBEAT_EXTEND_SEC || 20);
const HEARTBEAT_MAX_SEC         = Number(process.env.HEARTBEAT_MAX_SEC || 120);

const MAX_AGE_MIN               = Number(process.env.MAX_AGE_MIN || 10);
const ACCEPT_IF_PLAYERS_LT      = Number(process.env.ACCEPT_IF_PLAYERS_LT || 6);
const MIN_FREE_SLOTS_REQ        = Number(process.env.MIN_FREE_SLOTS_REQ || 0);

const RECENT_USED_TTL_MIN       = Number(process.env.RECENT_USED_TTL_MIN || 10);
const RECENT_USED_MIN_POOL      = Number(process.env.RECENT_USED_MIN_POOL || 0);

const MIN_REASSIGN_DELAY_SEC    = Number(process.env.MIN_REASSIGN_DELAY_SEC || 8);
const PREFER_NEWER_BONUS_SEC    = Number(process.env.PREFER_NEWER_BONUS_SEC || 240);

// ===== APP =====
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ===== IN-MEMORY STATE =====
/**
 * places: Map<placeId, {
 *   pool: Map<jobId, { jobId, players, maxPlayers, region, ping, reportedAt, lastAssignedAt, lock?: {...} }>
 *   recentUsed: Map<jobId, expiresAt>
 *   metrics: {...}
 * }>
 */
const places = new Map();

function now() { return Date.now(); }
function sec(ms) { return Math.floor(ms / 1000); }

function ensurePlace(placeId) {
  if (!places.has(placeId)) {
    places.set(placeId, {
      pool: new Map(),
      recentUsed: new Map(),
      metrics: {
        totalAdded: 0,
        totalIgnored: 0,
        totalLocks: 0,
        totalConfirms: 0,
        totalReleases: 0,
        totalQuarantine: 0
      }
    });
  }
  return places.get(placeId);
}

function auth(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

function cleanupPlaceState(place) {
  // 1) Expirar recentUsed
  const t = now();
  for (const [jobId, exp] of place.recentUsed) {
    if (exp <= t) place.recentUsed.delete(jobId);
  }
  // 2) Expirar locks vencidos y servidores viejos
  for (const [jobId, entry] of place.pool) {
    // drop too old
    const ageMin = (t - entry.reportedAt) / 60000;
    if (ageMin > MAX_AGE_MIN) {
      place.pool.delete(jobId);
      continue;
    }
    // expire lock
    if (entry.lock && entry.lock.expiresAt <= t) {
      entry.lock = undefined;
      entry.lastAssignedAt = t; // evita re-bucle inmediato
    }
  }
}

// ====== HELPERS ======
function scoreEntry(entry) {
  // Menos jugadores = mejor. Más nuevo = mejor (bonus).
  const t = now();
  const ageSec = (t - entry.reportedAt) / 1000;
  const base = 1000 - (entry.players || 0) * 10;
  const freshnessBonus = Math.max(0, PREFER_NEWER_BONUS_SEC - ageSec);
  return base + freshnessBonus;
}

function canAccept(entry) {
  const players = entry.players || 0;
  const max = entry.maxPlayers || 8;
  if (players >= ACCEPT_IF_PLAYERS_LT) return false;
  if ((max - players) < MIN_FREE_SLOTS_REQ) return false;
  return true;
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.json({ ok: true, service: "brainrot-api", time: now() });
});

// Reporta un server descubierto por el scanner
app.post("/api/report", auth, (req, res) => {
  const { placeId, jobId, players = 0, maxPlayers = 8, region = "", ping = 0, restricted = false } = req.body || {};
  if (!placeId || !jobId) return res.status(400).json({ ok: false, error: "missing placeId/jobId" });

  const place = ensurePlace(String(placeId));
  cleanupPlaceState(place);

  if (restricted) {
    place.metrics.totalIgnored++;
    return res.json({ ok: true, stored: false, reason: "restricted" });
  }

  // Descarta si no cumple filtros mínimos
  if (!canAccept({ players, maxPlayers })) {
    place.metrics.totalIgnored++;
    return res.json({ ok: true, stored: false, reason: "players_filter" });
  }

  // Cap de tamaño
  if (place.pool.size >= MAX_PER_PLACE && !place.pool.has(jobId)) {
    place.metrics.totalIgnored++;
    return res.json({ ok: true, stored: false, reason: "pool_full" });
  }

  // Insert / update
  const existed = place.pool.has(jobId);
  place.pool.set(jobId, {
    jobId,
    players,
    maxPlayers,
    region,
    ping,
    reportedAt: now(),
    lastAssignedAt: 0,
    lock: existed ? place.pool.get(jobId).lock : undefined
  });

  if (!existed) place.metrics.totalAdded++;
  res.json({ ok: true, stored: !existed, poolSize: place.pool.size });
});

// Hopper pide un server
app.post("/api/next", auth, (req, res) => {
  const { placeId, botId = "unknown" } = req.body || {};
  if (!placeId) return res.status(400).json({ ok: false, error: "missing placeId" });

  const place = ensurePlace(String(placeId));
  cleanupPlaceState(place);

  const t = now();
  const candidates = [];

  for (const entry of place.pool.values()) {
    // No bloqueados
    if (entry.lock) continue;

    // Evita re-asignar el mismo server inmediatamente
    if (entry.lastAssignedAt && (t - entry.lastAssignedAt) / 1000 < MIN_REASSIGN_DELAY_SEC) continue;

    // Filtro jugadores / slots
    if (!canAccept(entry)) continue;

    // Veto recentUsed (siempre y cuando haya pool suficiente)
    const inRecent = place.recentUsed.has(entry.jobId);
    if (inRecent && place.pool.size >= RECENT_USED_MIN_POOL) continue;

    candidates.push(entry);
  }

  if (!candidates.length) {
    return res.json({ ok: true, empty_pool: true });
  }

  // Pick best by score
  candidates.sort((a, b) => scoreEntry(b) - scoreEntry(a));
  const picked = candidates[0];
  picked.lock = {
    botId,
    assignedAt: t,
    expiresAt: t + LOCK_LEASE_SEC * 1000,
    heartbeats: 0
  };
  picked.lastAssignedAt = t;

  const placeStats = ensurePlace(String(placeId));
  placeStats.metrics.totalLocks++;

  res.json({
    ok: true,
    placeId: String(placeId),
    jobId: picked.jobId,
    players: picked.players,
    maxPlayers: picked.maxPlayers,
    region: picked.region,
    ping: picked.ping,
    leaseSec: LOCK_LEASE_SEC
  });
});

// Hopper confirma (heartbeat) cuando llega
app.post("/api/confirm", auth, (req, res) => {
  const { placeId, jobId, botId = "unknown" } = req.body || {};
  if (!placeId || !jobId) return res.status(400).json({ ok: false, error: "missing placeId/jobId" });

  const place = ensurePlace(String(placeId));
  cleanupPlaceState(place);

  const entry = place.pool.get(jobId);
  if (!entry || !entry.lock || entry.lock.botId !== botId) {
    return res.status(409).json({ ok: false, error: "no_lock_or_wrong_bot" });
  }

  const t = now();
  // Heartbeat window
  const ageSec = (t - entry.lock.assignedAt) / 1000;
  if (ageSec > HEARTBEAT_MAX_SEC) {
    entry.lock = undefined;
    return res.status(410).json({ ok: false, error: "heartbeat_window_expired" });
  }

  // Extiende lease
  entry.lock.expiresAt = t + LOCK_HEARTBEAT_EXTEND_SEC * 1000;
  entry.lock.heartbeats += 1;

  // Marca como recentUsed (veto)
  const ruTTL = RECENT_USED_TTL_MIN * 60000;
  place.recentUsed.set(jobId, t + ruTTL);

  place.metrics.totalConfirms++;
  res.json({ ok: true, extendedLeaseSec: LOCK_HEARTBEAT_EXTEND_SEC });
});

// Hopper libera explícitamente (full/restricted/unavailable)
app.post("/api/release", auth, (req, res) => {
  const { placeId, jobId, reason = "unknown", quarantine = false } = req.body || {};
  if (!placeId || !jobId) return res.status(400).json({ ok: false, error: "missing placeId/jobId" });

  const place = ensurePlace(String(placeId));
  cleanupPlaceState(place);

  const entry = place.pool.get(jobId);
  if (!entry) return res.json({ ok: true, existed: false });

  // Si quarantine => bórralo del pool y cuenta
  if (quarantine) {
    place.pool.delete(jobId);
    place.metrics.totalQuarantine++;
  } else {
    // Quita lock y lo deja re-evaluable más tarde
    entry.lock = undefined;
    entry.lastAssignedAt = now();
  }

  place.metrics.totalReleases++;
  res.json({ ok: true, existed: true, quarantined: Boolean(quarantine) });
});

// Stats/debug (útil para monitorear)
app.get("/api/stats", auth, (req, res) => {
  const out = {};
  for (const [pid, place] of places.entries()) {
    out[pid] = {
      pool: place.pool.size,
      recentUsed: place.recentUsed.size,
      metrics: place.metrics,
      config: {
        MAX_PER_PLACE,
        LOCK_LEASE_SEC,
        LOCK_HEARTBEAT_EXTEND_SEC,
        HEARTBEAT_MAX_SEC,
        MAX_AGE_MIN,
        ACCEPT_IF_PLAYERS_LT,
        MIN_FREE_SLOTS_REQ,
        RECENT_USED_TTL_MIN,
        RECENT_USED_MIN_POOL,
        MIN_REASSIGN_DELAY_SEC,
        PREFER_NEWER_BONUS_SEC
      }
    };
  }
  res.json({ ok: true, places: out });
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`[brainrot-api] listening on :${PORT}`);
});
