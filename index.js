// external_scanner_node.js — EN+ Scanner LÍMITE REAL (compatible con API v3.0)

"use strict";

const https = require("https");
const { URL } = require("url");

// ===== CONFIG =====
const API_BASE  = process.env.API_BASE  || "https://brainrot-api-v2py.onrender.com";
const API_KEY   = process.env.API_KEY   || "bR4nR0t-9f3a2c7b-6d1e-4a2b-8c3d-5f6a7b8c9d0e";
const PLACE_ID  = process.env.PLACE_ID  || "109983668079237";

const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 5000);
const MAX_PAGES        = Number(process.env.MAX_PAGES || 8);
const REPORT_ONLY_LT   = Number(process.env.REPORT_ONLY_LT || 6);

// ===== HELPERS =====
function parseJSONSafe(t) {
  try { return JSON.parse(t); } catch { return null; }
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(parseJSONSafe(data)));
    }).on("error", reject);
  });
}

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, API_BASE);

    const req = https.request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "x-api-key": API_KEY
      }
    }, res => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => resolve({
        code: res.statusCode,
        body: parseJSONSafe(out)
      }));
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ===== SCAN LOOP =====
async function scanServers() {
  let cursor = "";
  let pages = 0;
  let added = 0;
  let ignored = 0;

  console.log(`[SCAN] Scanning place ${PLACE_ID} (<${REPORT_ONLY_LT} players)`);

  while (pages < MAX_PAGES) {
    const url = `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100${cursor ? "&cursor=" + cursor : ""}`;

    const data = await fetchJSON(url);
    if (!data || !Array.isArray(data.data)) break;

    for (const server of data.data) {
      const playing = server.playing || 0;
      const jobId = server.id;

      if (playing >= REPORT_ONLY_LT) {
        ignored++;
        continue;
      }

      const res = await postJSON("/api/report", {
        placeId: PLACE_ID,
        servers: [jobId]
      });

      if (res.code === 200 && res.body && res.body.ok) {
        added++;
        console.log(`[report OK] jobId=${jobId}`);
      } else {
        console.log("[warn]", res.code, res.body);
      }
    }

    pages++;
    if (!data.nextPageCursor) break;
    cursor = encodeURIComponent(data.nextPageCursor);
  }

  console.log(`[done] pages=${pages}, added=${added}, ignored=${ignored}`);
}

// ===== LOOP =====
(async function loop() {
  while (true) {
    await scanServers();
    await new Promise(r => setTimeout(r, SCAN_INTERVAL_MS));
  }
})();
