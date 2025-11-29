// =====================================================
//  Brainrot Pool API v3.0 — CLEAN AUTO-PURGE EDITION
//  ✔ Limpia jobIds viejos (TTL 160s)
//  ✔ Limpia jobIds con muchos fallos (maxFail=3)
//  ✔ Limpia locks antiguos automáticamente
//  ✔ Evita "server is no longer available"
//  ✔ Compatible con tu external scanner + hopper v2.2
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

// Almacenes
const pools = {};         // placeId → [ jobId, jobId ]
const locks = {};         // jobId → { botId, timestamp }
const recentUsed = {};    // jobId → timestamp
const failCount = {};     // jobId → # de fallos de teleport
const createdAt = {};     // jobId → timestamp cuando se agregó
const pointers = {};      // placeId → índice RR

// === CONFIG LIMPIEZA ===
const JOB_TTL = 160;      // borrar servers viejos >160s
const LOCK_TTL = 12;      // lock que dura más de 12s se elimina
const MAX_FAILS = 3;      // borrar jobId tras 3 fallos

function now() {
    return Math.floor(Date.now() / 1000);
}

function ensurePlace(placeId) {
    if (!pools[placeId]) pools[placeId] = [];
    if (!pointers[placeId]) pointers[placeId] = 0;
}

// =====================================================
// /api/report
// =====================================================
app.post("/api/report", (req, res) => {
    const { placeId, servers } = req.body;

    if (!placeId) {
        return res.status(400).json({ ok: false, error: "missing_placeId" });
    }

    ensurePlace(placeId);
    const list = pools[placeId];
    let arr = servers;

    if (!servers) return res.json({ ok: false, error: "no_servers" });

    if (typeof arr === "string") arr = [arr];
    if (!Array.isArray(arr)) return res.json({ ok: false, error: "servers_not_array" });

    let added = 0;

    for (const jobId of arr) {
        if (
            typeof jobId === "string" &&
            jobId.length > 5 &&
            !list.includes(jobId)
        ) {
            list.push(jobId);
            createdAt[jobId] = now();
            failCount[jobId] = 0;
            added++;
        }
    }

    return res.json({ ok: true, added });
});

// =====================================================
// /api/next
// =====================================================
app.post("/api/next", (req, res) => {
    if (req.headers["x-api-key"] !== API_KEY) {
        return res.status(403).json({ ok: false, error: "unauthorized" });
    }

    const { placeId, botId } = req.body;
    ensurePlace(placeId);

    const list = pools[placeId];
    if (!list.length) return res.json({ ok: true, empty_pool: true });

    const L = list.length;
    const t = now();

    const start = (pointers[placeId] + Math.floor(Math.random() * 5)) % L;

    for (let i = 0; i < L; i++) {
        const idx = (start + i) % L;
        const jobId = list[idx];

        // Server viejo → borrar
        if (createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL)) {
            list.splice(idx, 1);
            delete createdAt[jobId];
            continue;
        }

        // Server con demasiados fallos → borrar
        if (failCount[jobId] >= MAX_FAILS) {
            list.splice(idx, 1);
            delete failCount[jobId];
            delete createdAt[jobId];
            continue;
        }

        // Anti-spam recentUsed
        if (recentUsed[jobId] && (t - recentUsed[jobId] < 8)) continue;

        // Lock activo
        const lock = locks[jobId];
        if (lock && (t - lock.timestamp < LOCK_TTL)) continue;

        locks[jobId] = { botId, timestamp: t };
        recentUsed[jobId] = t;

        pointers[placeId] = idx;

        return res.json({ ok: true, jobId });
    }

    return res.json({ ok: true, empty_pool: true });
});

// =====================================================
// /api/confirm — Bot llegó
// =====================================================
app.post("/api/confirm", (req, res) => {
    const { jobId } = req.body;
    delete locks[jobId];
    return res.json({ ok: true });
});

// =====================================================
// /api/release — Server muerto
// =====================================================
app.post("/api/release", (req, res) => {
    const { jobId } = req.body;
    delete locks[jobId];

    if (!failCount[jobId]) failCount[jobId] = 0;
    failCount[jobId]++;

    return res.json({ ok: true, fails: failCount[jobId] });
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
        pointers
    });
});

// =====================================================
// LIMPIEZA AUTOMÁTICA CADA 20s
// =====================================================
setInterval(() => {
    const t = now();

    for (const placeId in pools) {
        const list = pools[placeId];

        pools[placeId] = list.filter(jobId => {
            const tooOld = createdAt[jobId] && (t - createdAt[jobId] > JOB_TTL);
            const tooManyFails = failCount[jobId] >= MAX_FAILS;

            if (tooOld || tooManyFails) {
                delete createdAt[jobId];
                delete failCount[jobId];
                delete locks[jobId];
                return false;
            }
            return true;
        });
    }

    // Limpieza de locks
    for (const jobId in locks) {
        if (t - locks[jobId].timestamp > LOCK_TTL) {
            delete locks[jobId];
        }
    }

}, 20000);

// Servidor
app.listen(PORT, () =>
    console.log("API Brainrot v3.0 CLEAN corriendo en puerto", PORT)
);
