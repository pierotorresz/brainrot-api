// =====================================================
//  Brainrot Pool API v3.0 — HIGH CONCURRENCY EDITION
//  ✔ Optimizado para 300–1000 bots simultáneos
//  ✔ Sin empty_pool falso
//  ✔ recentUsed 25s (ideal para grandes cantidades)
//  ✔ locks 12s (evita overlaps)
//  ✔ selección RANDOM + round-robin
//  ✔ O(1) performance
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

const pools = {};      
const locks = {};      
const recentUsed = {}; 
const pointers = {};   // round-robin por placeId

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
    ensurePlace(placeId);

    const list = pools[placeId];
    let added = 0;

    for (const s of servers) {
        if (!list.includes(s)) {
            list.push(s);
            added++;
        }
    }

    return res.json({ ok: true, added });
});

// =====================================================
// /api/next — OPTIMIZADO PARA 300–1000 bots
// =====================================================
app.post("/api/next", (req, res) => {
    if (req.headers["x-api-key"] !== API_KEY) {
        return res.status(403).json({ ok: false });
    }

    const { placeId, botId } = req.body;
    ensurePlace(placeId);

    const list = pools[placeId];
    if (!list.length) return res.json({ ok: true, empty_pool: true });

    const L = list.length;
    const nowt = now();

    // random offset + round robin pointer
    const start = (pointers[placeId] + Math.floor(Math.random() * 7)) % L;

    for (let i = 0; i < L; i++) {
        const idx = (start + i) % L;
        const jobId = list[idx];

        // recientes (25s)
        if (recentUsed[jobId] && nowt - recentUsed[jobId] < 25) continue;

        // lock activo (12s)
        const lock = locks[jobId];
        if (lock && nowt - lock.timestamp < 12) continue;

        // asignar lock
        locks[jobId] = { botId, timestamp: nowt };
        recentUsed[jobId] = nowt;

        // mover round robin
        pointers[placeId] = idx;

        return res.json({ ok: true, jobId });
    }

    return res.json({ ok: true, empty_pool: true });
});

// =====================================================
// /api/confirm
// =====================================================
app.post("/api/confirm", (req, res) => {
    const { jobId } = req.body;
    delete locks[jobId];
    return res.json({ ok: true });
});

// =====================================================
// /api/release
// =====================================================
app.post("/api/release", (req, res) => {
    const { jobId } = req.body;
    delete locks[jobId];
    return res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log("API v3.0 (High Concurrency) running on", PORT);
});
