"use strict";

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY || "bR4nR0t-9f3a2c7b-6d1e-4a2b-8c3d-5f6a7b8c9d0e";

// --- Stores ---
const pools = {};         
const locks = {};         // jobId -> { botId, timestamp }
const recentUsed = {};    
const failCount = {};     
const createdAt = {};     
const pointers = {};      
const seenRecent = {};    
let serverDetails = [];   

// --- Configuración Antiduplicado ---
const JOB_TTL = 300;
const LOCK_TTL = 30;      // Aumentado a 30s para dar tiempo al bot a entrar
const MAX_FAILS = 3;
const RECENT_USED_TTL = 15;
const SEEN_TTL = 300;
const MAX_DETAILS_SIZE = 150;

function now() { return Math.floor(Date.now() / 1000); }

function ensurePlace(placeId) {
    if (!pools[placeId]) pools[placeId] = [];
    if (pointers[placeId] === undefined) pointers[placeId] = 0;
}

function isValidJobId(jobId) { return typeof jobId === "string" && jobId.length > 5; }

// selector con LOCKING ESTRICTO
function pickNextJobId(placeId, botId) {
    ensurePlace(placeId);
    const list = pools[placeId];
    if (!list || list.length === 0) return null;

    const t = now();
    // Empezamos en un punto aleatorio para distribuir bots
    const start = Math.floor(Math.random() * list.length);

    for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const jobId = list[idx];

        // Filtros de limpieza
        if (createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL)) continue;
        if ((failCount[jobId] || 0) >= MAX_FAILS) continue;

        // Lógica de Bloqueo Exclusivo
        const lock = locks[jobId];
        if (lock && (t - lock.timestamp < LOCK_TTL)) {
            // Si el lock no es mío, el servidor está ocupado por otro bot
            if (lock.botId !== botId) continue;
        }

        // Asignación de Lock
        locks[jobId] = { botId: botId, timestamp: t };
        recentUsed[jobId] = t;
        return jobId;
    }
    return null;
}

// --- Endpoints ---

app.post("/api/report", (req, res) => {
    const { placeId, servers, details } = req.body || {};
    if (!placeId) return res.status(400).send("no_placeid");

    if (details && isValidJobId(details.jobId)) {
        serverDetails = serverDetails.filter(d => d.jobId !== details.jobId);
        serverDetails.push({
            name: details.name,
            numericMPS: details.numericMPS,
            jobId: details.jobId,
            detectedAt: new Date().toISOString()
        });
        if (serverDetails.length > MAX_DETAILS_SIZE) serverDetails.shift();
    }

    if (servers) {
        ensurePlace(String(placeId));
        const list = pools[String(placeId)];
        const t = now();
        let arr = Array.isArray(servers) ? servers : [servers];

        arr.forEach(jobId => {
            if (!isValidJobId(jobId)) return;
            const sk = `${placeId}|${jobId}`;
            if (seenRecent[sk] && (t - seenRecent[sk] < SEEN_TTL)) return;
            seenRecent[sk] = t;
            if (!list.includes(jobId)) {
                list.push(jobId);
                createdAt[jobId] = t;
            }
        });
    }
    res.json({ ok: true });
});

app.get("/server", (req, res) => {
    const placeId = req.query.placeId;
    const botId = req.headers["username"] || "unknown_bot";
    if (!placeId) return res.status(400).send("");

    const jobId = pickNextJobId(String(placeId), botId);
    res.status(200).send(jobId || "");
});

app.get("/api/all", (req, res) => {
    res.json(serverDetails);
});

app.get("/count", (req, res) => {
    let total = 0;
    for (const id in pools) total += pools[id].length;
    res.send(`Bots activos viendo ${total} servers. Detallados: ${serverDetails.length}`);
});

app.listen(PORT, () => console.log(`API v3.3 Anti-Dupe en puerto ${PORT}`));
