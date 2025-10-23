// index.js — EN+ JobId API (desde cero)
// - Evita reusar servers por 10 min (TTL global).
// - Locks por botId (no asigna el mismo JobId a dos bots a la vez).
// - Preferencia: servidores frescos y con < 6 jugadores.
// - Si un bot libera por "Full/Restricted/Unavailable", se enfría ese job (cooldown).
// - Endpoints: /api/health, /api/report, /api/next, /api/confirm, /api/release, /api/stats, /api/all
// HTTP nativo (sin dependencias). Autenticación por x-api-key.

"use strict";
const http = require("http");
const { URL } = require("url");

// ========================= CONFIG (via ENV) =========================
const PORT                        = Number(process.env.PORT || 8000);
const API_KEY                     = process.env.API_KEY || "changeme";

const MAX_PER_PLACE               = Number(process.env.MAX_PER_PLACE || 1000);
const LOCK_LEASE_SEC              = Number(process.env.LOCK_LEASE_SEC || 45);
const LOCK_HEARTBEAT_EXTEND_SEC   = Number(process.env.LOCK_HEARTBEAT_EXTEND_SEC || 20);
const HEARTBEAT_MAX_SEC           = Number(process.env.HEARTBEAT_MAX_SEC || 120);

const MAX_AGE_MIN                 = Number(process.env.MAX_AGE_MIN || 10); // descarta reportes viejos
const ACCEPT_IF_PLAYERS_LT        = Number(process.env.ACCEPT_IF_PLAYERS_LT || 6); // preferimos <6
const MIN_FREE_SLOTS_REQ          = Number(process.env.MIN_FREE_SLOTS_REQ || 0);   // no exigimos hueco extra

const RECENT_USED_TTL_MIN         = Number(process.env.RECENT_USED_TTL_MIN || 10); // *** 10 min ***
const RECENT_USED_MIN_POOL        = Number(process.env.RECENT_USED_MIN_POOL || 0); // 0 = nunca bypass
const MIN_REASSIGN_DELAY_SEC      = Number(process.env.MIN_REASSIGN_DELAY_SEC || 8);
const PREFER_NEWER_BONUS_SEC      = Number(process.env.PREFER_NEWER_BONUS_SEC || 240);

// Quarantines al liberar
const Q_COOLDOWN_FULL_SEC         = Number(process.env.Q_COOLDOWN_FULL_SEC || 60);
const Q_COOLDOWN_RESTRICTED_SEC   = Number(process.env.Q_COOLDOWN_RESTRICTED_SEC || 120);
const Q_COOLDOWN_UNAVAILABLE_SEC  = Number(process.env.Q_COOLDOWN_UNAVAILABLE_SEC || 45);
const Q_COOLDOWN_GENERIC_SEC      = Number(process.env.Q_COOLDOWN_GENERIC_SEC || 30);

// ========================= STATE =========================
const state = Object.create(null); // placeId -> { items:Map, recentUsed:Map, botLast:Map, metrics:{} }
const now = () => Date.now();
const n = (v, d=0) => { const x=Number(v); return Number.isFinite(x)?x:d; };

function getPlace(placeId){
  if (!state[placeId]){
    state[placeId] = {
      items: new Map(),        // jobId -> rec
      recentUsed: new Map(),   // jobId -> expireTs (global, evita repetir entre bots)
      botLast: new Map(),      // botId -> lastJobId (extra)
      metrics: { totalAdded:0, totalIgnored:0, totalLocks:0, totalConfirms:0, totalReleases:0, totalQuarantine:0 }
    };
  }
  return state[placeId];
}

function send(res, code, obj){
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,x-api-key"
  });
  res.end(JSON.stringify(obj));
}
function unauthorized(res){ send(res,401,{ok:false,error:"Unauthorized"}); }
function parseBody(req){ return new Promise(r=>{ let d=""; req.on("data",c=>d+=c); req.on("end",()=>{ try{ r(JSON.parse(d||"{}")) }catch{ r({}) } }); }); }
function checkKey(req,u){ const k=req.headers["x-api-key"] || u.searchParams.get("api_key"); return k===API_KEY; }

function markRecentUsed(p, jobId){
  if (RECENT_USED_TTL_MIN<=0) return;
  p.recentUsed.set(jobId, now()+RECENT_USED_TTL_MIN*60_000);
}
function expireRecentUsed(p){
  const t=now();
  for (const [jid,exp] of p.recentUsed){ if (exp<=t) p.recentUsed.delete(jid); }
}
function sweepPlace(placeId){
  const p = getPlace(placeId);
  const t = now(), maxAge = MAX_AGE_MIN*60_000;
  for (const [jid,rec] of p.items){
    const seen = rec.lastSeen || rec.ts || 0;
    if (t - seen > maxAge) { p.items.delete(jid); continue; }
    if (rec.lock && rec.lock.until <= t){ rec.lock = null; rec.reassignAfter = t + MIN_REASSIGN_DELAY_SEC*1000; markRecentUsed(p, jid); }
    if (rec.coolUntil && rec.coolUntil <= t) delete rec.coolUntil;
  }
  expireRecentUsed(p);
}

// ========================= PICKER =========================
function pickNextRecord(p, botId){
  const t=now();
  const candidates=[];
  let visible=0;

  for (const rec of p.items.values()){
    const inRecent = RECENT_USED_TTL_MIN>0 && p.recentUsed.has(rec.jobId) && p.recentUsed.get(rec.jobId)>t;
    const inCool   = !!(rec.coolUntil && rec.coolUntil>t);
    const locked   = !!rec.lock;
    const inGrace  = !!(rec.reassignAfter && rec.reassignAfter>t);

    if (!locked) visible++;
    if (!locked && !inCool && !inRecent && !inGrace){
      // Filtro “preferimos < ACCEPT_IF_PLAYERS_LT”
      if (n(rec.players,0) < ACCEPT_IF_PLAYERS_LT) candidates.push(rec);
    }
  }

  // Si no hay candidatos “<6”, probá con cualquiera no vetado
  if (candidates.length===0){
    for (const rec of p.items.values()){
      const inRecent = RECENT_USED_TTL_MIN>0 && p.recentUsed.has(rec.jobId) && p.recentUsed.get(rec.jobId)>t;
      const inCool   = !!(rec.coolUntil && rec.coolUntil>t);
      const locked   = !!rec.lock;
      const inGrace  = !!(rec.reassignAfter && rec.reassignAfter>t);
      if (!locked && !inCool && !inRecent && !inGrace) candidates.push(rec);
    }
  }

  // BYPASS (opcional) si pool visible es chico
  if (candidates.length===0 && visible < RECENT_USED_MIN_POOL){
    for (const rec of p.items.values()){
      const locked = !!rec.lock;
      const inCool = !!(rec.coolUntil && rec.coolUntil>t);
      if (!locked && !inCool) candidates.push(rec);
    }
  }

  if (candidates.length===0) return null;

  candidates.sort((a,b)=>{
    const freeA=(a.maxPlayers||0)-(a.players||0), freeB=(b.maxPlayers||0)-(b.players||0);
    if (freeB!==freeA) return freeB-freeA;
    const ageA=t-(a.lastSeen||a.ts||0), ageB=t-(b.lastSeen||b.ts||0);
    const bonusA=ageA<=PREFER_NEWER_BONUS_SEC*1000?1:0, bonusB=ageB<=PREFER_NEWER_BONUS_SEC*1000?1:0;
    if (bonusB!==bonusA) return bonusB-bonusA;
    return (b.lastSeen||b.ts||0)-(a.lastSeen||a.ts||0); // más nuevo primero
  });

  const pick = candidates[0];

  // Evitar que el mismo bot repita su último job inmediatamente (protección extra)
  const last = p.botLast.get(botId);
  if (last && last===pick.jobId && candidates.length>1){
    return candidates[1];
  }
  return pick;
}

// ========================= HANDLERS =========================
async function handleReport(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req);
  const placeId=String(b.placeId||""), jobId=String(b.jobId||"");
  if(!placeId||!jobId) return send(res,400,{ok:false,error:"placeId and jobId required"});

  const players=n(b.players), maxPlayers=n(b.maxPlayers);
  const restricted=!!b.restricted; const region=String(b.region||""); const ping=Number.isFinite(Number(b.ping))?Number(b.ping):null;

  const p=getPlace(placeId);
  sweepPlace(placeId);

  if (restricted){ p.metrics.totalIgnored++; return send(res,200,{ok:true,ignored:true,reason:"restricted"}); }
  // No rechazamos por 8/8; usamos preferencia (<6) y cooldowns. Si querés bloquear llenos, usa MIN_FREE_SLOTS_REQ>0.
  if (maxPlayers && (maxPlayers-players)<MIN_FREE_SLOTS_REQ){ p.metrics.totalIgnored++; return send(res,200,{ok:true,ignored:true,reason:"not_enough_free_slots"}); }

  // TTL “recentUsed” global (no reinyectar si se usó hace < TTL)
  const t=now();
  if (RECENT_USED_TTL_MIN>0 && p.recentUsed.has(jobId) && p.recentUsed.get(jobId)>t){
    p.metrics.totalIgnored++; return send(res,200,{ok:true,ignored:true,reason:"recently_used"});
  }

  // Capacidad
  if (p.items.size>=MAX_PER_PLACE && !p.items.has(jobId)){
    let victim=null, oldest=Infinity;
    for (const [jid,rec] of p.items){
      if (rec.lock) continue;
      if (rec.coolUntil && rec.coolUntil>t) continue;
      const ts=rec.ts||rec.lastSeen||0;
      if (ts<oldest){ oldest=ts; victim=jid; }
    }
    if (victim) p.items.delete(victim);
  }

  const rec=p.items.get(jobId)||{ jobId, placeId, players, maxPlayers, region, ping, ts:t, lastSeen:t, lock:null, badCount:0 };
  rec.players=players; rec.maxPlayers=maxPlayers||rec.maxPlayers; rec.region=region||rec.region; rec.ping=(ping??rec.ping); rec.lastSeen=t;
  p.items.set(jobId,rec);
  if(!rec._added){ p.metrics.totalAdded++; rec._added=true; }

  send(res,200,{ok:true,stored:true});
}

async function handleNext(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const placeId=String(u.searchParams.get("placeId")||"");
  const botId  =String(u.searchParams.get("botId")||"")||("bot_"+Math.random().toString(36).slice(2));
  const peek   = String(u.searchParams.get("peek")||"false").toLowerCase()==="true";
  if(!placeId) return send(res,400,{ok:false,error:"placeId required"});

  sweepPlace(placeId);
  const p=getPlace(placeId);
  const rec=pickNextRecord(p, botId);
  if(!rec) return send(res,200,{ok:true,jobId:null,reason:"empty_pool"});

  if(!peek){
    const t=now(); rec.lock={ by:botId, until:t+LOCK_LEASE_SEC*1000, start:t };
    p.botLast.set(botId, rec.jobId);
    markRecentUsed(p, rec.jobId); // Veto inmediato (global) por 10 min
    p.metrics.totalLocks++;
  }

  send(res,200,{
    ok:true, jobId:rec.jobId, placeId,
    lock: peek?null:rec.lock,
    players:rec.players, maxPlayers:rec.maxPlayers, region:rec.region, ping:rec.ping
  });
}

async function handleConfirm(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req); const placeId=String(b.placeId||""), jobId=String(b.jobId||"");
  if(!placeId||!jobId) return send(res,400,{ok:false,error:"placeId and jobId required"});
  const p=getPlace(placeId); sweepPlace(placeId);
  if (p.items.has(jobId)) p.items.delete(jobId);
  markRecentUsed(p, jobId);
  p.metrics.totalConfirms++;
  send(res,200,{ok:true,removed:true});
}

function applyQuarantine(rec,p,reason){
  const t=now(); let c=Q_COOLDOWN_GENERIC_SEC;
  if (reason==="Full") c=Q_COOLDOWN_FULL_SEC;
  else if (reason==="Restricted") c=Q_COOLDOWN_RESTRICTED_SEC;
  else if (reason==="Unavailable") c=Q_COOLDOWN_UNAVAILABLE_SEC;
  rec.coolUntil=t+c*1000; rec.badCount=(rec.badCount||0)+1; p.metrics.totalQuarantine++;
}

async function handleRelease(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req); const placeId=String(b.placeId||""), jobId=String(b.jobId||""), reason=String(b.reason||"");
  if(!placeId||!jobId) return send(res,400,{ok:false,error:"placeId and jobId required"});
  const p=getPlace(placeId); sweepPlace(placeId);
  const rec=p.items.get(jobId);
  if (rec){
    rec.lock=null; rec.reassignAfter = now() + MIN_REASSIGN_DELAY_SEC*1000;
    if (reason) applyQuarantine(rec,p,reason);
  }
  markRecentUsed(p, jobId);
  p.metrics.totalReleases++;
  send(res,200,{ok:true,released:true});
}

async function handleStats(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const placeId=u.searchParams.get("placeId");
  if(placeId){
    sweepPlace(placeId); const p=getPlace(placeId);
    return send(res,200,{ ok:true, placeId, pool:p.items.size, recentUsed:p.recentUsed.size, metrics:p.metrics,
      config:{MAX_PER_PLACE,LOCK_LEASE_SEC,LOCK_HEARTBEAT_EXTEND_SEC,HEARTBEAT_MAX_SEC,MAX_AGE_MIN,
        ACCEPT_IF_PLAYERS_LT,MIN_FREE_SLOTS_REQ,RECENT_USED_TTL_MIN,RECENT_USED_MIN_POOL,MIN_REASSIGN_DELAY_SEC,PREFER_NEWER_BONUS_SEC} });
  } else {
    const arr=Object.keys(state).map(pid=>{ sweepPlace(pid); const p=getPlace(pid); return {placeId:pid,pool:p.items.size,recentUsed:p.recentUsed.size,metrics:p.metrics}; });
    return send(res,200,{ok:true,places:arr});
  }
}

async function handleAll(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const placeId=u.searchParams.get("placeId"); if(!placeId) return send(res,400,{ok:false,error:"placeId required"});
  sweepPlace(placeId); const p=getPlace(placeId);
  const rows=[];
  for (const rec of p.items.values()){
    rows.push({ jobId:rec.jobId, players:rec.players, maxPlayers:rec.maxPlayers,
      hasLock:!!rec.lock, lockBy:rec.lock?.by||null, lockUntil:rec.lock?.until||null,
      coolUntil:rec.coolUntil||null, badCount:rec.badCount||0, ts:rec.ts, lastSeen:rec.lastSeen });
  }
  send(res,200,{ok:true,total:rows.length,rows});
}

// ========================= ROUTER =========================
const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url, `http://${req.headers.host}`); const path=u.pathname; const m=req.method.toUpperCase();
  if (m==="OPTIONS"){
    res.writeHead(204, {
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type,x-api-key",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
    });
    return res.end();
  }
  try{
    if(m==="GET"  && (path==="/api/health" || path==="/health"))   return send(res,200,{ok:true,status:"healthy",time:new Date().toISOString()});
    if(m==="POST" && (path==="/api/report" || path==="/report"))   return await handleReport(req,res,u);
    if(m==="GET"  && (path==="/api/next"   || path==="/next"))     return await handleNext(req,res,u);
    if(m==="POST" && (path==="/api/confirm"|| path==="/confirm"))  return await handleConfirm(req,res,u);
    if(m==="POST" && (path==="/api/release"|| path==="/release"))  return await handleRelease(req,res,u);
    if(m==="GET"  && (path==="/api/stats"  || path==="/stats"))    return await handleStats(req,res,u);
    if(m==="GET"  && (path==="/api/all"    || path==="/all"))      return await handleAll(req,res,u);
    return send(res,404,{ok:false,error:"Not found"});
  }catch(e){
    return send(res,500,{ok:false,error:"Server error",details:String(e&&e.message||e)});
  }
});

server.listen(PORT, ()=> console.log(`[jobid-api] listening :${PORT}`));
