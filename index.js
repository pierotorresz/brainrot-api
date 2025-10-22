// index.js
// ✅ API estable, sin dependencias externas: /next, /report, /confirm, /release, /stats, /all, /health
// Con locks anti-duplicado, frescura (TTL), y "quarantine" si un bot reporta full/restricted/etc.

const http = require("http");
const { URL } = require("url");

// ================== CONFIG ==================
const PORT                   = process.env.PORT || 8000;
const API_KEY                = process.env.API_KEY || "changeme";       // ⛔ cámbialo en Render
const MAX_PER_PLACE          = Number(process.env.MAX_PER_PLACE || 500);
const LOCK_LEASE_SEC         = Number(process.env.LOCK_LEASE_SEC || 90);
const IGNORE_IF_PLAYERS_GE   = Number(process.env.IGNORE_IF_PLAYERS_GE || 7); // “>6” => 7
const MIN_FREE_SLOTS_REQ     = Number(process.env.MIN_FREE_SLOTS_REQ || 1);

// Frescura: descartar viejos y preferir nuevos
const MAX_AGE_MIN            = Number(process.env.MAX_AGE_MIN || 6);     // TTL duro (minutos)
const PREFER_NEWER_BONUS_SEC = Number(process.env.PREFER_NEWER_BONUS_SEC || 120);

// Quarantine al liberar por fallo
const Q_COOLDOWN_FULL_SEC        = Number(process.env.Q_COOLDOWN_FULL_SEC || 60);
const Q_COOLDOWN_RESTRICTED_SEC  = Number(process.env.Q_COOLDOWN_RESTRICTED_SEC || 120);
const Q_COOLDOWN_UNAVAILABLE_SEC = Number(process.env.Q_COOLDOWN_UNAVAILABLE_SEC || 90);
const Q_COOLDOWN_GENERIC_SEC     = Number(process.env.Q_COOLDOWN_GENERIC_SEC || 45);

// ================== STATE ==================
const state = Object.create(null);
const now = () => Date.now();
function getPlace(placeId) {
  if (!state[placeId]) {
    state[placeId] = {
      items: new Map(),
      metrics: {
        totalAdded: 0, totalIgnored: 0, totalLocks: 0,
        totalConfirms: 0, totalReleases: 0, totalQuarantine: 0
      }
    };
  }
  return state[placeId];
}
function n(v, d = 0) { const x = Number(v); return Number.isFinite(x) ? x : d; }
function sweepPlace(placeId) {
  const p = getPlace(placeId);
  const maxAgeMs = MAX_AGE_MIN * 60_000;
  const t = now();
  for (const [jobId, rec] of p.items) {
    if ((t - (rec.lastSeen || rec.ts || 0)) > maxAgeMs) { p.items.delete(jobId); continue; }
    if (rec.lock && rec.lock.until <= t) rec.lock = null;
    if (rec.coolUntil && rec.coolUntil <= t) delete rec.coolUntil;
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
  return new Promise((resolve) => {
    let data = ""; req.on("data", c => data += c);
    req.on("end", () => { try { resolve(JSON.parse(data||"{}")); } catch { resolve({}); } });
  });
}
function checkKey(req, urlObj) {
  const key = req.headers["x-api-key"] || urlObj.searchParams.get("api_key");
  return key === API_KEY;
}
function pickNextRecord(p) {
  const t = now();
  const candidates = [];
  for (const rec of p.items.values()) {
    if (!rec.lock && !(rec.coolUntil && rec.coolUntil > t)) candidates.push(rec);
  }
  if (candidates.length === 0) {
    for (const rec of p.items.values()) {
      if (rec.lock && rec.lock.until <= t) candidates.push(rec);
      if (rec.coolUntil && rec.coolUntil <= t && !rec.lock) candidates.push(rec);
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const freeA = (a.maxPlayers || 0) - (a.players || 0);
    const freeB = (b.maxPlayers || 0) - (b.players || 0);
    if (freeB !== freeA) return freeB - freeA;

    const ageA = t - (a.lastSeen || a.ts || 0);
    const ageB = t - (b.lastSeen || b.ts || 0);
    const bonusA = ageA <= PREFER_NEWER_BONUS_SEC * 1000 ? 1 : 0;
    const bonusB = ageB <= PREFER_NEWER_BONUS_SEC * 1000 ? 1 : 0;
    if (bonusB !== bonusA) return bonusB - bonusA;

    return (b.lastSeen || b.ts || 0) - (a.lastSeen || a.ts || 0);
  });
  return candidates[0];
}
async function handleReport(req, res, urlObj) {
  if (!checkKey(req, urlObj)) return unauthorized(res);
  const body = await parseBody(req);
  const placeId = (body.placeId || "").toString();
  const jobId   = (body.jobId || "").toString();
  if (!placeId || !jobId) return send(res, 400, { ok: false, error: "placeId and jobId are required" });

  const players    = n(body.players);
  const maxPlayers = n(body.maxPlayers);
  const restricted = !!body.restricted;
  const region     = (body.region ?? "").toString();
  const ping       = Number.isFinite(Number(body.ping)) ? Number(body.ping) : null;

  const p = getPlace(placeId);

  if (restricted === true) { p.metrics.totalIgnored++; return send(res, 200, { ok: true, ignored: true, reason: "restricted" }); }
  if ((maxPlayers && players >= maxPlayers) || players >= IGNORE_IF_PLAYERS_GE) {
    p.metrics.totalIgnored++; return send(res, 200, { ok: true, ignored: true, reason: "server_full_or_players_ge_threshold" });
  }
  if (maxPlayers && (maxPlayers - players) < MIN_FREE_SLOTS_REQ) {
    p.metrics.totalIgnored++; return send(res, 200, { ok: true, ignored: true, reason: "not_enough_free_slots" });
  }

  sweepPlace(placeId);

  if (p.items.size >= MAX_PER_PLACE && !p.items.has(jobId)) {
    let victim = null, oldest = Infinity, t = now();
    for (const [jid, rec] of p.items) {
      if (rec.lock) continue;
      if (rec.coolUntil && rec.coolUntil > t) continue;
      const ts = rec.ts || rec.lastSeen || 0;
      if (ts < oldest) { oldest = ts; victim = jid; }
    }
    if (victim) p.items.delete(victim);
  }

  const t = now();
  const rec = p.items.get(jobId) || {
    jobId, placeId, players, maxPlayers, restricted: false, region, ping,
    ts: t, lastSeen: t, lock: null, badCount: 0
  };
  rec.players = players;
  rec.maxPlayers = maxPlayers || rec.maxPlayers;
  rec.region = region || rec.region;
  rec.ping = (ping ?? rec.ping);
  rec.lastSeen = t;
  p.items.set(jobId, rec);
  if (!rec._added) { p.metrics.totalAdded++; rec._added = true; }

  return send(res, 200, { ok: true, stored: true });
}
async function handleNext(req, res, urlObj) {
  if (!checkKey(req, urlObj)) return unauthorized(res);
  const placeId = (urlObj.searchParams.get("placeId") || "").toString();
  const botId   = (urlObj.searchParams.get("botId") || "").toString() || ("bot_" + Math.random().toString(36).slice(2));
  const peek    = String(urlObj.searchParams.get("peek") || "false").toLowerCase() === "true";
  if (!placeId) return send(res, 400, { ok: false, error: "placeId is required" });

  sweepPlace(placeId);
  const p = getPlace(placeId);
  const rec = pickNextRecord(p);
  if (!rec) return send(res, 200, { ok: true, jobId: null, reason: "empty_pool" });

  if (!peek) {
    rec.lock = { by: botId, until: now() + LOCK_LEASE_SEC * 1000 };
    p.metrics.totalLocks++;
  }
  send(res, 200, {
    ok: true,
    jobId: rec.jobId,
    placeId,
    lock: peek ? null : rec.lock,
    players: rec.players,
    maxPlayers: rec.maxPlayers,
    region: rec.region,
    ping: rec.ping
  });
}
async function handleConfirm(req, res, urlObj) {
  if (!checkKey(req, urlObj)) return unauthorized(res);
  const body = await parseBody(req);
  const placeId = (body.placeId || "").toString();
  const jobId   = (body.jobId || "").toString();
  if (!placeId || !jobId) return send(res, 400, { ok: false, error: "placeId and jobId are required" });

  const p = getPlace(placeId);
  sweepPlace(placeId);
  if (p.items.has(jobId)) {
    p.items.delete(jobId);
    p.metrics.totalConfirms++;
    return send(res, 200, { ok: true, removed: true });
  } else {
    return send(res, 200, { ok: true, removed: false, reason: "not_found" });
  }
}
function applyQuarantine(rec, p, reason) {
  const t = now();
  let cool = Q_COOLDOWN_GENERIC_SEC;
  if (reason === "Full") cool = Q_COOLDOWN_FULL_SEC;
  else if (reason === "Restricted") cool = Q_COOLDOWN_RESTRICTED_SEC;
  else if (reason === "Unavailable") cool = Q_COOLDOWN_UNAVAILABLE_SEC;
  rec.coolUntil = t + cool * 1000;
  rec.badCount = (rec.badCount || 0) + 1;
  p.metrics.totalQuarantine++;
}
async function handleRelease(req, res, urlObj) {
  if (!checkKey(req, urlObj)) return unauthorized(res);
  const body = await parseBody(req);
  const placeId = (body.placeId || "").toString();
  const jobId   = (body.jobId || "").toString();
  const reason  = (body.reason || "").toString();
  if (!placeId || !jobId) return send(res, 400, { ok: false, error: "placeId and jobId are required" });

  const p = getPlace(placeId);
  sweepPlace(placeId);
  const rec = p.items.get(jobId);
  if (!rec) return send(res, 200, { ok: true, released: false, reason: "not_found" });

  rec.lock = null;
  if (reason) applyQuarantine(rec, p, reason);
  p.metrics.totalReleases++;
  return send(res, 200, { ok: true, released: true, coolUntil: rec.coolUntil || null, badCount: rec.badCount || 0 });
}
async function handleStats(req, res, urlObj) {
  if (!checkKey(req, urlObj)) return unauthorized(res);
  const placeId = urlObj.searchParams.get("placeId");
  if (placeId) {
    sweepPlace(placeId);
    const p = getPlace(placeId);
    return send(res, 200, {
      ok: true,
      placeId,
      pool: p.items.size,
      metrics: p.metrics,
      config: { MAX_PER_PLACE, LOCK_LEASE_SEC, IGNORE_IF_PLAYERS_GE, MIN_FREE_SLOTS_REQ, MAX_AGE_MIN, PREFER_NEWER_BONUS_SEC }
    });
  } else {
    const out = Object.keys(state).map(pid => {
      sweepPlace(pid);
      const p = getPlace(pid);
      return { placeId: pid, pool: p.items.size, metrics: p.metrics };
    });
    return send(res, 200, { ok: true, places: out });
  }
}
async function handleAll(req, res, urlObj) {
  if (!checkKey(req, urlObj)) return unauthorized(res);
  const placeId = urlObj.searchParams.get("placeId");
  if (!placeId) return send(res, 400, { ok: false, error: "placeId is required" });

  sweepPlace(placeId);
  const p = getPlace(placeId);
  const rows = [];
  for (const rec of p.items.values()) {
    rows.push({
      jobId: rec.jobId,
      players: rec.players,
      maxPlayers: rec.maxPlayers,
      hasLock: !!rec.lock,
      lockBy: rec.lock?.by || null,
      lockUntil: rec.lock?.until || null,
      coolUntil: rec.coolUntil || null,
      badCount: rec.badCount || 0,
      ts: rec.ts,
      lastSeen: rec.lastSeen
    });
  }
  return send(res, 200, { ok: true, total: rows.length, rows });
}

// ================== ROUTER ==================
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const path = urlObj.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,x-api-key",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }

  try {
    if (method === "GET"  && (path === "/health" || path === "/api/health"))  return send(res, 200, { ok: true, status: "healthy", time: new Date().toISOString() });
    if (method === "POST" && (path === "/report" || path === "/api/report"))  return await handleReport(req, res, urlObj);
    if (method === "GET"  && (path === "/next"   || path === "/api/next"))    return await handleNext(req, res, urlObj);
    if (method === "POST" && (path === "/confirm"|| path === "/api/confirm")) return await handleConfirm(req, res, urlObj);
    if (method === "POST" && (path === "/release"|| path === "/api/release")) return await handleRelease(req, res, urlObj);
    if (method === "GET"  && (path === "/stats"  || path === "/api/stats"))   return await handleStats(req, res, urlObj);
    if (method === "GET"  && (path === "/all"    || path === "/api/all"))     return await handleAll(req, res, urlObj);

    return send(res, 404, { ok: false, error: "Not found" });
  } catch (e) {
    return send(res, 500, { ok: false, error: "Server error", details: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`[roblox-jobid-api] listening on :${PORT}`);
});
