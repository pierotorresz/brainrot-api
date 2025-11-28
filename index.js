// =====================================================
//  Brainrot Pool API v2.3 (FIX FINAL)
//  ✔ Arregla "servers is not iterable"
//  ✔ No crashea si servers viene mal
//  ✔ Acepta string o array
//  ✔ Compatible con hopper v2.2
//  ✔ Compatible con scanner externo
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
const pools = {};       // placeId → [ jobId, jobId, ... ]
const locks = {};       // jobId → { botId, timestamp }
const recentUsed = {};  // jobId → timestamp
const pointers = {};    // placeId → índice (round robin)

// Helpers
function now() {
    return Math.floor(Date.now() / 1000);
}

function ensurePlace(placeId) {
    if (!pools[placeId]) pools[placeId] = [];
    if (!pointers[placeId]) pointers[placeId] = 0;
}

// =====================================================
// /api/report  — Scanner envía servidores
// =====================================================
app.post("/api/report", (req, res) => {
    const { placeId, servers } = req.body;

    if (!placeId) {
        return res.status(400).json({ ok: false, error: "missing_placeId" });
    }

    ensurePlace(placeId);
    const list = pools[placeId];
    let added = 0;

    // ===========================
    // VALIDACIÓN CRÍTICA
    // ===========================

    if (!servers) {
        return res.json({ ok: false, error: "no_servers" });
    }

    let arr = servers;

    // Si viene como string → convertir a array
    if (typeof servers === "string") {
        arr = [servers];
    }

    // Si no es array → no romper
    if (!Array.isArray(arr)) {
        return res.json({ ok: false, error: "servers_not_array" });
    }

    // Agregar servers al pool
    for (const jobId of arr) {
        if (
            typeof jobId === "string" &&
            jobId.length > 5 &&
            !list.includes(jobId)
        ) {
            list.push(jobId);
            added++;
        }
    }

    return res.json({ ok: true, added });
});

// =====================================================
// /api/next — Hopper pide servidor
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
    const nowt = now();

    const start = (pointers[placeId] + Math.floor(Math.random() * 5)) % L;

    for (let i = 0; i < L; i++) {
        const idx = (start + i) % L;
        const jobId = list[idx];

        // RecentUsed (anti-spam)
        if (recentUsed[jobId] && nowt - recentUsed[jobId] < 8) continue;

        // Lock actual
        const lock = locks[jobId];
        if (lock && nowt - lock.timestamp < 10) continue;

        locks[jobId] = { botId, timestamp: nowt };
        recentUsed[jobId] = nowt;

        pointers[placeId] = idx;

        return res.json({ ok: true, jobId });
    }

    return res.json({ ok: true, empty_pool: true });
});

// =====================================================
// /api/confirm — Bot llegó bien
// =====================================================
app.post("/api/confirm", (req, res) => {
    const { jobId } = req.body;
    delete locks[jobId];
    return res.json({ ok: true });
});

// =====================================================
// /api/release — Bot no llegó (server muerto / fallo TP)
// =====================================================
app.post("/api/release", (req, res) => {
    const { jobId } = req.body;
    delete locks[jobId];
    return res.json({ ok: true });
});

// =====================================================
// /api/stats — Debug
// =====================================================
app.get("/api/stats", (req, res) => {
    return res.json({
        pools,
        locks,
        recentUsed,
        pointers
    });
});

// Servidor
app.listen(PORT, () =>
    console.log("API Brainrot v2.3 FIX corriendo en puerto", PORT)
);
