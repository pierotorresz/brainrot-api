// =====================================================
//  Brainrot Pool API v3.1 — DEDUPE + COMPAT EDITION
//  ✔ Dedupe últimos 5 min (SEEN_TTL = 300s)
//  ✔ Limpia jobIds viejos (JOB_TTL)
//  ✔ Limpia jobIds con muchos fallos (MAX_FAILS)
//  ✔ Limpia locks antiguos automáticamente (LOCK_TTL)
//  ✔ Evita bots usando el mismo jobId al mismo tiempo
//  ✔ Compatible con external scanner + hopper (/server & /remove)
//  ✔ Mantiene endpoints /api/* antiguos
// =====================================================

"use strict";

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "bR4nR0t-9f3a2c7b-6d1e-4a2b-8c3d-5f6a7b8c9d0e";

// =====================
// Stores
// =====================
const pools = {};         // placeId -> [jobId]
const locks = {};         // jobId -> { botId, timestamp }
const recentUsed = {};    // jobId -> timestamp (anti-spam corto)
const failCount = {};     // jobId -> fails
const createdAt = {};     // jobId -> timestamp cuando se agregó al pool
const pointers = {};      // placeId -> índice RR

// NUEVO: Dedupe “visto recientemente”
const seenRecent = {};    // key(placeId|jobId) -> timestamp

// =====================
// Config
// =====================
const JOB_TTL = Number(process.env.JOB_TTL || 300);         // segundos
const LOCK_TTL = Number(process.env.LOCK_TTL || 12);        // segundos
const MAX_FAILS = Number(process.env.MAX_FAILS || 3);
const RECENT_USED_TTL = Number(process.env.RECENT_USED_TTL || 8); // segundos
const SEEN_TTL = Number(process.env.SEEN_TTL || 300);       // 5 min dedupe

// Default placeId opcional (para /server)
const DEFAULT_PLACE_ID = process.env.DEFAULT_PLACE_ID ? String(process.env.DEFAULT_PLACE_ID) : null;

function now() {
  return Math.floor(Date.now() / 1000);
}

function ensurePlace(placeId) {
  if (!pools[placeId]) pools[placeId] = [];
  if (pointers[placeId] === undefined) pointers[placeId] = 0;
}

function seenKey(placeId, jobId) {
  return `${placeId}|${jobId}`;
}

function isValidJobId(jobId) {
  return typeof jobId === "string" && jobId.length > 5;
}

// =====================================================
// /api/report  (scanner -> API)
// body: { placeId, servers: [jobId] OR "jobid" }
// =====================================================
app.post("/api/report", (req, res) => {
  const { placeId, servers } = req.body || {};

  if (!placeId) return res.status(400).json({ ok: false, error: "missing_placeId" });
  ensurePlace(String(placeId));

  if (!servers) return res.json({ ok: false, error: "no_servers" });

  let arr = servers;
  if (typeof arr === "string") arr = [arr];
  if (!Array.isArray(arr)) return res.json({ ok: false, error: "servers_not_array" });

  const list = pools[String(placeId)];
  const t = now();

  let added = 0;
  let dupRecent = 0;
  let invalid = 0;

  for (const jobId of arr) {
    if (!isValidJobId(jobId)) {
      invalid++;
      continue;
    }

    // DEDUPE últimos SEEN_TTL segundos
    const sk = seenKey(String(placeId), jobId);
    const lastSeen = seenRecent[sk];
    if (lastSeen && (t - lastSeen) < SEEN_TTL) {
      dupRecent++;
      continue;
    }
    seenRecent[sk] = t;

    // No volver a meter si ya está en el pool
    if (!list.includes(jobId)) {
      list.push(jobId);
      createdAt[jobId] = t;
      failCount[jobId] = failCount[jobId] || 0;
      added++;
    }
  }

  return res.json({ ok: true, added, dupRecent, invalid, poolSize: list.length });
});

// =====================================================
// Core selector: obtiene 1 jobId "bueno" para un bot
// =====================================================
function pickNextJobId(placeId, botId) {
  ensurePlace(placeId);
  const list = pools[placeId];
  if (!list.length) return null;

  const L = list.length;
  const t = now();

  // start RR con un poco de random
  const start = (pointers[placeId] + Math.floor(Math.random() * 5)) % L;

  for (let i = 0; i < L; i++) {
    const idx = (start + i) % L;
    const jobId = list[idx];

    // Purge por viejo
    if (createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL)) {
      list.splice(idx, 1);
      delete createdAt[jobId];
      delete failCount[jobId];
      delete locks[jobId];
      delete recentUsed[jobId];
      i--; // ajuste por splice
      continue;
    }

    // Purge por demasiados fails
    if ((failCount[jobId] || 0) >= MAX_FAILS) {
      list.splice(idx, 1);
      delete createdAt[jobId];
      delete failCount[jobId];
      delete locks[jobId];
      delete recentUsed[jobId];
      i--;
      continue;
    }

    // Anti-spam corto
    if (recentUsed[jobId] && (t - recentUsed[jobId] < RECENT_USED_TTL)) continue;

    // Lock activo
    const lock = locks[jobId];
    if (lock && (t - lock.timestamp < LOCK_TTL)) continue;

    // OK -> lock + recent
    locks[jobId] = { botId: botId || "unknown", timestamp: t };
    recentUsed[jobId] = t;
    pointers[placeId] = idx;

    return jobId;
  }

  return null;
}

// =====================================================
// /api/next  (hopper viejo)
// body: { placeId, botId }
// header: x-api-key
// =====================================================
app.post("/api/next", (req, res) => {
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).json({ ok: false, error: "unauthorized" });
  }

  const { placeId, botId } = req.body || {};
  if (!placeId) return res.status(400).json({ ok: false, error: "missing_placeId" });

  const jobId = pickNextJobId(String(placeId), botId);
  if (!jobId) return res.json({ ok: true, empty_pool: true });

  return res.json({ ok: true, jobId });
});

// =====================================================
// /api/confirm  (bot llegó)
// body: { jobId }
// =====================================================
app.post("/api/confirm", (req, res) => {
  const { jobId } = req.body || {};
  if (isValidJobId(jobId)) delete locks[jobId];
  return res.json({ ok: true });
});

// =====================================================
// /api/release  (server muerto / teleport fail)
// body: { jobId }
// =====================================================
app.post("/api/release", (req, res) => {
  const { jobId } = req.body || {};
  if (!isValidJobId(jobId)) return res.json({ ok: false, error: "invalid_jobId" });

  delete locks[jobId];
  failCount[jobId] = (failCount[jobId] || 0) + 1;

  return res.json({ ok: true, fails: failCount[jobId] });
});

// =====================================================
// COMPAT: /server?size=1&placeId=xxxxx
// Devuelve SOLO texto jobId (como tu hopper actual)
// Header opcional: Username (para botId)
// =====================================================
app.get("/server", (req, res) => {
  const placeId = String(req.query.placeId || DEFAULT_PLACE_ID || "");
  if (!placeId) return res.status(400).send("missing_placeId");

  const botId = (req.headers["username"] || req.headers["x-bot-id"] || "unknown").toString();
  const jobId = pickNextJobId(placeId, botId);

  if (!jobId) return res.status(200).send(""); // tu hopper maneja body vacío

  return res.status(200).send(jobId);
});

// =====================================================
// COMPAT: /remove  (blacklist server)
// body: { jobid }
// Header opcional: Username
// Responde { ok:true, removed:true, new_jobid?: string }
// =====================================================
app.post("/remove", (req, res) => {
  const botId = (req.headers["username"] || req.headers["x-bot-id"] || "unknown").toString();
  const jobId = (req.body && (req.body.jobid || req.body.jobId)) ? String(req.body.jobid || req.body.jobId) : null;

  if (!isValidJobId(jobId)) return res.json({ ok: false, error: "invalid_jobid" });

  // Encuentra en qué placeId está (si existe)
  let foundPlace = null;
  for (const pid in pools) {
    const idx = pools[pid].indexOf(jobId);
    if (idx !== -1) {
      pools[pid].splice(idx, 1);
      foundPlace = pid;
      break;
    }
  }

  // Marca fail y suelta lock
  delete locks[jobId];
  failCount[jobId] = (failCount[jobId] || 0) + 1;

  // Intenta dar reemplazo si sabemos el place
  let new_jobid = null;
  if (foundPlace) {
    new_jobid = pickNextJobId(foundPlace, botId);
  }

  return res.json({ ok: true, removed: Boolean(foundPlace), fails: failCount[jobId], new_jobid });
});

// =====================================================
// /api/stats
// =====================================================
app.get("/api/stats", (req, res) => {
  return res.json({
    pools,
    locks,
    recentUsed,
    failCount,
    createdAt,
    pointers,
    seenRecentCount: Object.keys(seenRecent).length,
    cfg: { JOB_TTL, LOCK_TTL, MAX_FAILS, RECENT_USED_TTL, SEEN_TTL }
  });
});

// =====================================================
// Auto-clean every 20s
// =====================================================
setInterval(() => {
  const t = now();

  // Limpia pools por TTL / fails
  for (const placeId in pools) {
    const list = pools[placeId];
    pools[placeId] = list.filter(jobId => {
      const tooOld = createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL);
      const tooManyFails = (failCount[jobId] || 0) >= MAX_FAILS;

      if (tooOld || tooManyFails) {
        delete createdAt[jobId];
        delete failCount[jobId];
        delete locks[jobId];
        delete recentUsed[jobId];
        return false;
      }
      return true;
    });
  }

  // Limpieza de locks vencidos
  for (const jobId in locks) {
    if (t - locks[jobId].timestamp > LOCK_TTL) {
      delete locks[jobId];
    }
  }

  // Limpieza de seenRecent (dedupe cache)
  for (const k in seenRecent) {
    if (t - seenRecent[k] > SEEN_TTL) {
      delete seenRecent[k];
    }
  }

  // Limpieza de recentUsed viejo (por orden)
  for (const jobId in recentUsed) {
    if (t - recentUsed[jobId] > (RECENT_USED_TTL * 5)) {
      delete recentUsed[jobId];
    }
  }
}, 20000);

// Start
app.listen(PORT, () => {
  console.log("API Brainrot v3.1 DEDUPE+COMPAT running on port", PORT);
});
