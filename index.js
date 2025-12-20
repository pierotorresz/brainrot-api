"use strict";

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = Number(process.env.PORT || 10000);

// --- Stores ---
const pools = {};         
const locks = {};         
const recentUsed = {};    
const failCount = {};     
const createdAt = {};     
const pointers = {};      
const seenRecent = {};    
let serverDetails = [];   

// --- Configuración para Escala Masiva (300 Bots) ---
const JOB_TTL = 450;       // El JobID vive más tiempo en la lista
const LOCK_TTL = 60;       // Bloqueo de 1 minuto para evitar colisiones por carga lenta
const MAX_FAILS = 3;
const RECENT_USED_TTL = 30; // Evita que el mismo ID sea sugerido muy rápido
const SEEN_TTL = 600;      // Dedupe de 10 min para no repetir escaneos innecesarios
const MAX_DETAILS_SIZE = 250; 

function now() { return Math.floor(Date.now() / 1000); }

function ensurePlace(placeId) {
    if (!pools[placeId]) pools[placeId] = [];
    if (pointers[placeId] === undefined) pointers[placeId] = 0;
}

function isValidJobId(jobId) { return typeof jobId === "string" && jobId.length > 5; }

function pickNextJobId(placeId, botId) {
    ensurePlace(placeId);
    const list = pools[placeId];
    if (!list || list.length === 0) return null;

    const t = now();
    // Salto aleatorio mayor para dispersar a los 300 bots en toda la lista
    const start = Math.floor(Math.random() * list.length);

    for (let i = 0; i < list.length; i++) {
        const idx = (start + i) % list.length;
        const jobId = list[idx];

        if (createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL)) continue;
        if ((failCount[jobId] || 0) >= MAX_FAILS) continue;

        // Bloqueo Estricto
        const lock = locks[jobId];
        if (lock && (t - lock.timestamp < LOCK_TTL)) {
            if (lock.botId !== botId) continue;
        }

        // Si se usó recientemente por CUALQUIERA, esperar un poco (distribución uniforme)
        if (recentUsed[jobId] && (t - recentUsed[jobId] < RECENT_USED_TTL)) continue;

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
    const botId = req.headers["username"] || "bot_" + Math.random().toString(36).substring(7);
    if (!placeId) return res.status(400).send("");

    const jobId = pickNextJobId(String(placeId), botId);
    res.status(200).send(jobId || "");
});

app.get("/api/all", (req, res) => res.json(serverDetails));

app.listen(PORT, () => console.log(`API v3.4 300-BOTS-READY en puerto ${PORT}`));
