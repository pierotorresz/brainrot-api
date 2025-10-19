const express = require("express");
const fetch = require("node-fetch");
const app = express();
app.use(express.json());

const PLACE_ID = 109983668079237;
let servers = [];

// Carga/actualiza lista de JobIds con espacio disponible
async function fetchServers() {
  try {
    const res = await fetch(
      `https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100`
    );
    const data = await res.json();
    if (data && data.data) {
      servers = data.data
        .filter(s => s.id && (s.maxPlayers - s.playing) > 0)
        .map(s => s.id);
      // elimina duplicados por si acaso
      servers = Array.from(new Set(servers));
      console.log("✅ Servidores cargados:", servers.length);
    }
  } catch (err) {
    console.log("❌ Error al obtener servers:", err);
  }
}

setInterval(fetchServers, 15000);
fetchServers();

app.get("/", (req, res) => {
  res.send("✅ Backend funcionando correctamente");
});

/**
 * GET /next
 * - Sin parámetros (o n=1): JSON { jobId: "..." }  (compatibilidad)
 * - Con n>1: texto plano con n JobIds, uno por línea
 *   Ej: /next?n=20  --> (text/plain)
 *       id1
 *       id2
 *       ...
 */
app.get("/next", (req, res) => {
  if (!servers.length) {
    return res.status(503).json({ error: "No servers yet" });
  }

  const n = Math.max(parseInt(req.query.n || "1", 10), 1);

  if (n === 1) {
    const id = servers[Math.floor(Math.random() * servers.length)];
    return res.json({ jobId: id });
  }

  // Selección aleatoria sin repetidos (hasta n o tamaño de la lista)
  const pool = servers.slice();
  const count = Math.min(n, pool.length);
  const sample = [];

  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    sample.push(pool[idx]);
    pool.splice(idx, 1);
  }

  res.type("text/plain").send(sample.join("\n"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor listo en puerto", PORT));
