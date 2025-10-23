// index.js — API con "recent used" (evitar reusar el mismo server por X minutos)
// Endpoints: /health, /report, /next, /confirm, /release, /stats, /all
// Seguridad por x-api-key. Sin dependencias externas (usa http nativo).

const http = require("http");
const { URL } = require("url");

// ================== CONFIG ==================
const PORT                   = process.env.PORT || 8000;
const API_KEY                = process.env.API_KEY || "changeme";

const MAX_PER_PLACE          = Number(process.env.MAX_PER_PLACE || 500);
const LOCK_LEASE_SEC         = Number(process.env.LOCK_LEASE_SEC || 90);

const IGNORE_IF_PLAYERS_GE   = Number(process.env.IGNORE_IF_PLAYERS_GE || 7);
const MIN_FREE_SLOTS_REQ     = Number(process.env.MIN_FREE_SLOTS_REQ || 1);

const MAX_AGE_MIN            = Number(process.env.MAX_AGE_MIN || 6);
const PREFER_NEWER_BONUS_SEC = Number(process.env.PREFER_NEWER_BONUS_SEC || 120);

// Quarantine al liberar por fallo
const Q_COOLDOWN_FULL_SEC        = Number(process.env.Q_COOLDOWN_FULL_SEC || 60);
const Q_COOLDOWN_RESTRICTED_SEC  = Number(process.env.Q_COOLDOWN_RESTRICTED_SEC || 120);
const Q_COOLDOWN_UNAVAILABLE_SEC = Number(process.env.Q_COOLDOWN_UNAVAILABLE_SEC || 90);
const Q_COOLDOWN_GENERIC_SEC     = Number(process.env.Q_COOLDOWN_GENERIC_SEC || 45);

// 🔸 NUEVO: evitar reusar por X minutos (p.ej. 30)
const RECENT_USED_TTL_MIN        = Number(process.env.RECENT_USED_TTL_MIN || 30);
// (opcional) si no hay candidatos por el veto, permitir fallback si el pool
// visible es bajo (para no quedarnos sin servers en horas muertas)
const RECENT_USED_MIN_POOL       = Number(process.env.RECENT_USED_MIN_POOL || 50);

// ================== STATE ==================
const state = Object.create(null);
const now = () => Date.now();

function getPlace(placeId) {
  if (!state[placeId]) {
    state[placeId] = {
      items: new Map(),        // jobId -> record
      recentUsed: new Map(),   // jobId -> expireTs
      metrics: {
        totalAdded: 0,
        totalIgnored: 0,
        totalLocks: 0,
        totalConfirms: 0,
        totalReleases: 0,
        totalQuarantine: 0
      }
    };
  }
  return state[placeId];
}

function n(v, d = 0) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}

function markRecentUsed(p, jobId) {
  if (RECENT_USED_TTL_MIN <= 0) return;
  p.recentUsed.set(jobId, now() + RECENT_USED_TTL_MIN * 60_000);
}

function sweepPlace(placeId) {
  const p = getPlace(placeId);
  const maxAgeMs = MAX_AGE_MIN * 60_000;
  const t = now();

  // Expira items viejos y locks vencidos
  for (const [jobId, rec] of p.items) {
    const seen = rec.lastSeen || rec.ts || 0;
    if ((t - seen) > maxAgeMs) { p.items.delete(jobId); continue; }
    if (rec.lock && rec.lock.until <= t) rec.lock = null;
    if (rec.coolUntil && rec.coolUntil <= t) delete rec.coolUntil;
  }

  // Expira recentUsed
  if (p.recentUsed.size) {
    for (const [jid, exp] of p.recentUsed) {
      if (exp <= t) p.recentUsed.delete(jid);
    }
  }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key",
  });
  res.end(body);
}
function unauthorized(res) { send(res, 401, { ok: false, error: "Unauthorized" }); }

function parseBody(req) {
  return new Promise(resolve => {
    let data = "";
    req.on("data", c => data += c);
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}
function checkKey(req, urlObj) {
  const key = req.headers["x-api-key"] || urlObj.searchParams.get("api_key");
  return key === API_KEY;
}

// ================== PICKER ==================
function pickNextRecord(p) {
  const t = now();
  const candidates = [];
  let visiblePool = 0;

  // 1) Candidatos que no estén lockeados, ni en cooldown, ni en recentUsed
  for (const rec of p.items.values()) {
    const inRecent = RECENT_USED_TTL_MIN > 0 && p.recentUsed.has(rec.jobId) && p.recentUsed.get(rec.jobId) > t;
    const inCool = !!(rec.coolUntil && rec.coolUntil > t);
    const locked = !!rec.lock;
    if (!locked) visiblePool++;
    if (!locked && !inCool && !inRecent) candidates.push(rec);
  }

  // 2) Si no hay (o son muy pocos) y el pool visible es chico, permitir fallback ignorando recentUsed
  if (candidates.length === 0 && visiblePool < RECENT_USED_MIN_POOL) {
    for (const rec of p.items.values()) {
      const locked = !!rec.lock;
      const inCool = !!(rec.coolUntil &&
