const express = require("express");
const fetch = require("node-fetch");
const app = express();
app.use(express.json());

const PLACE_ID = 109983668079237;
let servers = [];

async function fetchServers() {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games/${PLACE_ID}/servers/Public?sortOrder=Asc&limit=100`);
    const data = await res.json();
    if (data && data.data) {
      servers = data.data
        .filter(s => s.id && (s.maxPlayers - s.playing) > 0)
        .map(s => s.id);
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

app.get("/next", (req, res) => {
  if (servers.length === 0) return res.status(503).json({ error: "No servers yet" });
  const id = servers[Math.floor(Math.random() * servers.length)];
  res.json({ jobId: id });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor listo en puerto", PORT));
