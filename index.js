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
const recentUsed = {};    // jobId -> timestamp
const failCount = {};     // jobId -> fails
const createdAt = {};     // jobId -> timestamp
const pointers = {};      // placeId -> índice RR
const seenRecent = {};    // key(placeId|jobId) -> timestamp

// NUEVO: Almacén de detalles para el Autojoiner
let serverDetails = [];   // Lista de { name, numericMPS, jobId, detectedAt }

// =====================
// Config
// =====================
const JOB_TTL = Number(process.env.JOB_TTL || 300);
const LOCK_TTL = Number(process.env.LOCK_TTL || 12);
const MAX_FAILS = Number(process.env.MAX_FAILS || 3);
const RECENT_USED_TTL = Number(process.env.RECENT_USED_TTL || 8);
const SEEN_TTL = Number(process.env.SEEN_TTL || 300);
const MAX_DETAILS_SIZE = 150; // Cuántos servidores detallados guardar para el Autojoiner

const DEFAULT_PLACE_ID = process.env.DEFAULT_PLACE_ID ? String(process.env.DEFAULT_PLACE_ID) : null;

function now() { return Math.floor(Date.now() / 1000); }

function ensurePlace(placeId) {
    if (!pools[placeId]) pools[placeId] = [];
    if (pointers[placeId] === undefined) pointers[placeId] = 0;
}

function isValidJobId(jobId) { return typeof jobId === "string" && jobId.length > 5; }

// =====================================================
// /api/report (Scanner -> API)
// =====================================================
app.post("/api/report", (req, res) => {
    const { placeId, servers, details } = req.body || {};

    if (!placeId) return res.status(400).json({ ok: false, error: "missing_placeId" });
    ensurePlace(String(placeId));

    // 1. Lógica de Detalles (Para Autojoiner)
    if (details && isValidJobId(details.jobId)) {
        // Evitar duplicados en serverDetails
        serverDetails = serverDetails.filter(d => d.jobId !== details.jobId);
        serverDetails.push({
            name: details.name || "Unknown",
            numericMPS: Number(details.numericMPS) || 0,
            jobId: details.jobId,
            detectedAt: new Date().toISOString()
        });
        if (serverDetails.length > MAX_DETAILS_SIZE) serverDetails.shift();
    }

    // 2. Lógica de Pool (Para Bots)
    if (!servers) return res.json({ ok: true, msg: "only_details_updated" });

    let arr = typeof servers === "string" ? [servers] : servers;
    if (!Array.isArray(arr)) return res.json({ ok: false, error: "servers_not_array" });

    const list = pools[String(placeId)];
    const t = now();
    let added = 0;

    for (const jobId of arr) {
        if (!isValidJobId(jobId)) continue;

        const sk = `${placeId}|${jobId}`;
        const lastSeen = seenRecent[sk];
        if (lastSeen && (t - lastSeen) < SEEN_TTL) continue;
        
        seenRecent[sk] = t;

        if (!list.includes(jobId)) {
            list.push(jobId);
            createdAt[jobId] = t;
            failCount[jobId] = failCount[jobId] || 0;
            added++;
        }
    }

    return res.json({ ok: true, added, poolSize: list.length, detailsCount: serverDetails.length });
});

// =====================================================
// NUEVO: /api/all (Para el Autojoiner)
// =====================================================
app.get("/api/all", (req, res) => {
    // Filtramos detalles que ya expiraron (más de 5 min)
    const tLimit = Date.now() - (JOB_TTL * 1000);
    const freshDetails = serverDetails.filter(d => new Date(d.detectedAt).getTime() > tLimit);
    res.json(freshDetails);
});

// =====================================================
// /server (Hopper Bot Selector)
// =====================================================
function pickNextJobId(placeId, botId) {
    ensurePlace(placeId);
    const list = pools[placeId];
    if (!list.length) return null;

    const t = now();
    const start = (pointers[placeId] + Math.floor(Math.random() * 3)) % list.length;

    for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const jobId = list[idx];

        if (createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL)) continue;
        if ((failCount[jobId] || 0) >= MAX_FAILS) continue;
        if (recentUsed[jobId] && (t - recentUsed[jobId] < RECENT_USED_TTL)) continue;
        
        const lock = locks[jobId];
        if (lock && (t - lock.timestamp < LOCK_TTL)) continue;

        locks[jobId] = { botId: botId || "unknown", timestamp: t };
        recentUsed[jobId] = t;
        pointers[placeId] = idx;
        return jobId;
    }
    return null;
}

app.get("/server", (req, res) => {
    const placeId = String(req.query.placeId || DEFAULT_PLACE_ID || "");
    const botId = (req.headers["username"] || "unknown").toString();
    const jobId = pickNextJobId(placeId, botId);
    return res.status(200).send(jobId || "");
});

// =====================================================
// /count (Visualizador rápido)
// =====================================================
app.get("/count", (req, res) => {
    let total = 0;
    for (const id in pools) total += pools[id].length;
    res.send(`
        <body style="font-family: sans-serif; background: #111; color: #eee; text-align: center; padding-top: 50px;">
            <h1>📊 Brainrot Stats</h1>
            <p style="font-size: 24px;">Pool Total: <b style="color: #0f0;">${total}</b> servidores</p>
            <p style="font-size: 18px;">Servidores Detallados: <b style="color: #0af;">${serverDetails.length}</b></p>
            <hr style="width: 200px; border: 1px solid #333;">
            <p>API v3.2 Detail Edition</p>
        </body>
    `);
});

// =====================================================
// Limpiadores Automáticos
// =====================================================
setInterval(() => {
    const t = now();
    // Limpieza de pools
    for (const pid in pools) {
        pools[pid] = pools[pid].filter(jid => {
            const exp = createdAt[jid] && (t - createdAt[jid] > JOB_TTL);
            if (exp) { delete createdAt[jid]; delete failCount[jid]; delete locks[jid]; }
            return !exp;
        });
    }
    // Limpieza de locks
    for (const jid in locks) if (t - locks[jid].timestamp > LOCK_TTL) delete locks[jid];
    // Limpieza de Cache Dedupe
    for (const k in seenRecent) if (t - seenRecent[k] > SEEN_TTL) delete seenRecent[k];
}, 30000);

app.listen(PORT, () => {
    console.log("🚀 Brainrot Detail API running on port", PORT);
});
