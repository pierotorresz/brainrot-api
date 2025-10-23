// index.js — API robusta con:
// - recent-used (veto al asignar / expirar / confirmar / liberar)
// - heartbeat para extender lock durante el teleport
// - gracia al soltar para evitar reasignación inmediata
// - filtro en /report de recently_used
// - picker sin bypass del veto (RECENT_USED_MIN_POOL por defecto 0)

const http = require("http");
const { URL } = require("url");

const PORT                   = process.env.PORT || 8000;
const API_KEY                = process.env.API_KEY || "changeme";

const MAX_PER_PLACE          = Number(process.env.MAX_PER_PLACE || 500);
const LOCK_LEASE_SEC         = Number(process.env.LOCK_LEASE_SEC || 120);
const IGNORE_IF_PLAYERS_GE   = Number(process.env.IGNORE_IF_PLAYERS_GE || 7);
const MIN_FREE_SLOTS_REQ     = Number(process.env.MIN_FREE_SLOTS_REQ || 1);
const MAX_AGE_MIN            = Number(process.env.MAX_AGE_MIN || 4);
const PREFER_NEWER_BONUS_SEC = Number(process.env.PREFER_NEWER_BONUS_SEC || 180);

const Q_COOLDOWN_FULL_SEC        = Number(process.env.Q_COOLDOWN_FULL_SEC || 60);
const Q_COOLDOWN_RESTRICTED_SEC  = Number(process.env.Q_COOLDOWN_RESTRICTED_SEC || 120);
const Q_COOLDOWN_UNAVAILABLE_SEC = Number(process.env.Q_COOLDOWN_UNAVAILABLE_SEC || 90);
const Q_COOLDOWN_GENERIC_SEC     = Number(process.env.Q_COOLDOWN_GENERIC_SEC || 45);

// recent-used
const RECENT_USED_TTL_MIN    = Number(process.env.RECENT_USED_TTL_MIN || 30);
// ⚠️ Para que NUNCA se ignore el veto, dejar 0 (recomendado).
const RECENT_USED_MIN_POOL   = Number(process.env.RECENT_USED_MIN_POOL || 0);

// heartbeat & gracia
const LOCK_HEARTBEAT_EXTEND_SEC = Number(process.env.LOCK_HEARTBEAT_EXTEND_SEC || 20);
const HEARTBEAT_MAX_SEC         = Number(process.env.HEARTBEAT_MAX_SEC || 120);
const MIN_REASSIGN_DELAY_SEC    = Number(process.env.MIN_REASSIGN_DELAY_SEC || 8);

const now = () => Date.now();
const state = Object.create(null);

function getPlace(placeId) {
  if (!state[placeId]) {
    state[placeId] = {
      items: new Map(),        // jobId -> rec
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
function n(v,d=0){ const x=Number(v); return Number.isFinite(x)?x:d; }

function send(res, code, obj){
  res.writeHead(code,{
    "Content-Type":"application/json; charset=utf-8",
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Headers":"Content-Type,x-api-key",
  });
  res.end(JSON.stringify(obj));
}
function unauthorized(res){ send(res,401,{ok:false,error:"Unauthorized"}); }
function parseBody(req){ return new Promise(r=>{ let d=""; req.on("data",c=>d+=c); req.on("end",()=>{ try{r(JSON.parse(d||"{}"))}catch{r({})} }); }); }
function checkKey(req,u){ const k=req.headers["x-api-key"] || u.searchParams.get("api_key"); return k===API_KEY; }

function markRecentUsed(p, jobId){ if(RECENT_USED_TTL_MIN<=0) return; p.recentUsed.set(jobId, now()+RECENT_USED_TTL_MIN*60_000); }

function sweepPlace(placeId){
  const p = getPlace(placeId);
  const t = now(), maxAge = MAX_AGE_MIN*60_000;

  for (const [jid,rec] of p.items){
    const seen = rec.lastSeen||rec.ts||0;
    if (t - seen > maxAge){ p.items.delete(jid); continue; }

    // 🔒 al expirar el lock, aplica gracia + VETO
    if (rec.lock && rec.lock.until <= t){
      rec.lock = null;
      rec.reassignAfter = t + MIN_REASSIGN_DELAY_SEC*1000;
      markRecentUsed(p, rec.jobId); // << clave para cortar el reuso aunque no haya confirmación
    }

    if (rec.coolUntil && rec.coolUntil > 0 && rec.coolUntil <= t) delete rec.coolUntil;
  }

  // expira recentUsed vencidos
  for (const [jid,exp] of p.recentUsed){ if (exp<=t) p.recentUsed.delete(jid); }
}

function pickNextRecord(p){
  const t=now(); const candidates=[]; let visible=0;

  for (const rec of p.items.values()){
    const inRecent = RECENT_USED_TTL_MIN>0 && p.recentUsed.has(rec.jobId) && p.recentUsed.get(rec.jobId)>t;
    const inCool   = !!(rec.coolUntil && rec.coolUntil>t);
    const inGrace  = !!(rec.reassignAfter && rec.reassignAfter>t);
    const locked   = !!rec.lock;
    if (!locked) visible++;
    if (!locked && !inCool && !inRecent && !inGrace) candidates.push(rec);
  }

  // Si quieres permitir bypass en casos extremos, sube RECENT_USED_MIN_POOL en env.
  if (candidates.length===0 && visible < RECENT_USED_MIN_POOL){
    for (const rec of p.items.values()){
      const locked=!!rec.lock, inCool=!!(rec.coolUntil && rec.coolUntil>t);
      if (!locked && !inCool) candidates.push(rec);
    }
  }

  if (candidates.length===0) return null;

  candidates.sort((a,b)=>{
    const freeA=(a.maxPlayers||0)-(a.players||0), freeB=(b.maxPlayers||0)-(b.players||0);
    if (freeB!==freeA) return freeB-freeA;
    const ageA=t-(a.lastSeen||a.ts||0), ageB=t-(b.lastSeen||b.ts||0);
    const bonusA = ageA<=PREFER_NEWER_BONUS_SEC*1000?1:0, bonusB=ageB<=PREFER_NEWER_BONUS_SEC*1000?1:0;
    if (bonusB!==bonusA) return bonusB-bonusA;
    return (b.lastSeen||b.ts||0)-(a.lastSeen||a.ts||0);
  });
  return candidates[0];
}

// ---------- Handlers ----------
async function handleReport(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req);
  const placeId=String(b.placeId||""), jobId=String(b.jobId||"");
  if(!placeId||!jobId) return send(res,400,{ok:false,error:"placeId and jobId are required"});

  const players=n(b.players), maxPlayers=n(b.maxPlayers), restricted=!!b.restricted;
  const region=String(b.region||""), ping=Number.isFinite(Number(b.ping))?Number(b.ping):null;

  const p=getPlace(placeId);
  sweepPlace(placeId);

  if (restricted){ p.metrics.totalIgnored++; return send(res,200,{ok:true,ignored:true,reason:"restricted"}); }
  if ((maxPlayers && players>=maxPlayers) || players>=IGNORE_IF_PLAYERS_GE){ p.metrics.totalIgnored++; return send(res,200,{ok:true,ignored:true,reason:"server_full_or_players_ge_threshold"}); }
  if (maxPlayers && (maxPlayers-players)<MIN_FREE_SLOTS_REQ){ p.metrics.totalIgnored++; return send(res,200,{ok:true,ignored:true,reason:"not_enough_free_slots"}); }

  // ❗ si fue usado recientemente, IGNORAR (no reinyectar antes de TTL)
  const t=now();
  if (RECENT_USED_TTL_MIN>0 && p.recentUsed.has(jobId) && p.recentUsed.get(jobId)>t){
    p.metrics.totalIgnored++;
    return send(res,200,{ok:true,ignored:true,reason:"recently_used"});
  }

  // límite de memoria por place (evitar crecer indefinidamente)
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

  const rec = p.items.get(jobId) || { jobId, placeId, players, maxPlayers, region, ping, ts:t, lastSeen:t, lock:null, badCount:0 };
  rec.players=players;
  rec.maxPlayers=maxPlayers||rec.maxPlayers;
  rec.region=region||rec.region;
  rec.ping=(ping ?? rec.ping);
  rec.lastSeen=t;

  p.items.set(jobId,rec);
  if (!rec._added){ p.metrics.totalAdded++; rec._added=true; }

  send(res,200,{ok:true,stored:true});
}

async function handleNext(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const placeId=String(u.searchParams.get("placeId")||"");
  const botId  =String(u.searchParams.get("botId")||"")||("bot_"+Math.random().toString(36).slice(2));
  const peek   = String(u.searchParams.get("peek")||"false").toLowerCase()==="true";
  if(!placeId) return send(res,400,{ok:false,error:"placeId is required"});

  sweepPlace(placeId);
  const p=getPlace(placeId);
  const rec=pickNextRecord(p);
  if(!rec) return send(res,200,{ok:true,jobId:null,reason:"empty_pool"});

  if(!peek){
    const tnow=now();
    rec.lock={ by:botId, until:tnow+LOCK_LEASE_SEC*1000, start:tnow };
    delete rec.reassignAfter;
    p.metrics.totalLocks++;

    // 🔒 VETAR DE INMEDIATO ESTE JOBID (aunque el bot no confirme después)
    markRecentUsed(p, rec.jobId);
  }

  send(res,200,{
    ok:true, jobId:rec.jobId, placeId,
    lock: peek?null:rec.lock,
    players: rec.players, maxPlayers: rec.maxPlayers,
    region: rec.region, ping: rec.ping
  });
}

async function handleConfirm(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req); const placeId=String(b.placeId||""), jobId=String(b.jobId||"");
  if(!placeId||!jobId) return send(res,400,{ok:false,error:"placeId and jobId are required"});

  const p=getPlace(placeId); sweepPlace(placeId);
  if (p.items.has(jobId)){
    p.items.delete(jobId);
    markRecentUsed(p, jobId); // ya estaba
    p.metrics.totalConfirms++;
    return send(res,200,{ok:true,removed:true});
  }
  // Even if not present, still mark as used to enforce TTL
  markRecentUsed(p, jobId);
  p.metrics.totalConfirms++;
  send(res,200,{ok:true,removed:false,reason:"not_found"});
}

function applyQuarantine(rec,p,reason){
  const t=now(); let cool=Q_COOLDOWN_GENERIC_SEC;
  if (reason==="Full") cool=Q_COOLDOWN_FULL_SEC;
  else if (reason==="Restricted") cool=Q_COOLDOWN_RESTRICTED_SEC;
  else if (reason==="Unavailable") cool=Q_COOLDOWN_UNAVAILABLE_SEC;
  rec.coolUntil=t+cool*1000; rec.badCount=(rec.badCount||0)+1; p.metrics.totalQuarantine++;
}

async function handleRelease(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req);
  const placeId=String(b.placeId||""), jobId=String(b.jobId||""), reason=String(b.reason||"");
  if(!placeId||!jobId) return send(res,400,{ok:false,error:"placeId and jobId are required"});

  const p=getPlace(placeId); sweepPlace(placeId);
  const rec=p.items.get(jobId);
  if(!rec){
    // aunque no esté, fuerza el veto
    markRecentUsed(p, jobId);
    return send(res,200,{ok:true,released:false,reason:"not_found"});
  }

  rec.lock=null;
  rec.reassignAfter = now() + MIN_REASSIGN_DELAY_SEC*1000; // gracia
  if (reason) applyQuarantine(rec,p,reason);
  markRecentUsed(p, jobId); // ya estaba

  p.metrics.totalReleases++;
  send(res,200,{ok:true,released:true,coolUntil:rec.coolUntil||null,badCount:rec.badCount||0});
}

async function handleHeartbeat(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const b=await parseBody(req);
  const placeId=String(b.placeId||""), jobId=String(b.jobId||""), botId=String(b.botId||"");
  if(!placeId||!jobId||!botId) return send(res,400,{ok:false,error:"placeId, jobId, botId required"});

  const p=getPlace(placeId); const rec=p.items.get(jobId);
  if (!rec || !rec.lock || rec.lock.by !== botId) return send(res,409,{ok:false,error:"lock_not_owned_or_missing"});

  const t=now(); const maxUntil=(rec.lock.start||t)+HEARTBEAT_MAX_SEC*1000;
  const newUntil=Math.min(maxUntil, t + LOCK_HEARTBEAT_EXTEND_SEC*1000);
  if (newUntil>rec.lock.until) rec.lock.until=newUntil;

  send(res,200,{ok:true,until:rec.lock.until});
}

async function handleStats(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const placeId=u.searchParams.get("placeId");
  if(placeId){
    sweepPlace(placeId);
    const p=getPlace(placeId);
    return send(res,200,{
      ok:true, placeId,
      pool:p.items.size, recentUsed:p.recentUsed.size,
      metrics:p.metrics,
      config:{
        MAX_PER_PLACE,LOCK_LEASE_SEC,IGNORE_IF_PLAYERS_GE,MIN_FREE_SLOTS_REQ,
        MAX_AGE_MIN,PREFER_NEWER_BONUS_SEC,
        RECENT_USED_TTL_MIN,RECENT_USED_MIN_POOL,
        LOCK_HEARTBEAT_EXTEND_SEC,HEARTBEAT_MAX_SEC,MIN_REASSIGN_DELAY_SEC
      }
    });
  } else {
    const arr=Object.keys(state).map(pid=>{ sweepPlace(pid); const p=getPlace(pid); return {placeId:pid,pool:p.items.size,recentUsed:p.recentUsed.size,metrics:p.metrics}; });
    return send(res,200,{ok:true,places:arr});
  }
}

async function handleAll(req,res,u){
  if(!checkKey(req,u)) return unauthorized(res);
  const placeId=u.searchParams.get("placeId"); if(!placeId) return send(res,400,{ok:false,error:"placeId is required"});
  sweepPlace(placeId); const p=getPlace(placeId); const rows=[];
  for (const rec of p.items.values()){
    rows.push({
      jobId:rec.jobId, players:rec.players, maxPlayers:rec.maxPlayers,
      hasLock:!!rec.lock, lockBy:rec.lock?.by||null, lockUntil:rec.lock?.until||null,
      coolUntil:rec.coolUntil||null, reassignAfter:rec.reassignAfter||null,
      badCount:rec.badCount||0, ts:rec.ts, lastSeen:rec.lastSeen
    });
  }
  send(res,200,{ok:true,total:rows.length,rows});
}

const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host}`); const path=u.pathname; const m=req.method.toUpperCase();
  if (m==="OPTIONS"){
    res.writeHead(204,{
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Headers":"Content-Type,x-api-key",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS"
    });
    return res.end();
  }
  try{
    if(m==="GET"  && (path==="/health"||path==="/api/health"))  return send(res,200,{ok:true,status:"healthy",time:new Date().toISOString()});
    if(m==="POST" && (path==="/report"||path==="/api/report"))  return await handleReport(req,res,u);
    if(m==="GET"  && (path==="/next"  ||path==="/api/next"))    return await handleNext(req,res,u);
    if(m==="POST" && (path==="/confirm"||path==="/api/confirm"))return await handleConfirm(req,res,u);
    if(m==="POST" && (path==="/release"||path==="/api/release"))return await handleRelease(req,res,u);
    if(m==="POST" && (path==="/heartbeat"||path==="/api/heartbeat"))return await handleHeartbeat(req,res,u);
    if(m==="GET"  && (path==="/stats" ||path==="/api/stats"))   return await handleStats(req,res,u);
    if(m==="GET"  && (path==="/all"   ||path==="/api/all"))     return await handleAll(req,res,u);
    return send(res,404,{ok:false,error:"Not found"});
  }catch(e){
    return send(res,500,{ok:false,error:"Server error",details:String(e&&e.message||e)});
  }
});
server.listen(PORT,()=>console.log(`[roblox-jobid-api] listening on :${PORT}`));
