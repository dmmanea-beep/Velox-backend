'use strict';
const express = require('express');
const cors    = require('cors');
const axios   = require('axios'); 
const cheerio = require('cheerio'); 
const http    = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const RAIL_YEAR_START = new Date('2025-12-14T00:00:00Z');
const STATION_GPS_URL = 'https://raw.githubusercontent.com/vasile/data.gov.ro-gtfs-exporter/master/cfr.webgis.ro/stops.geojson';
const XML_SOURCES = [
  { operator: 'CFR Călători', url: 'https://data.gov.ro/dataset/c4f71dbb-de39-49b2-b697-5b60a5f299a2/resource/0f67143e-bb88-4a06-8e7a-b35b1eb91329/download/trenuri-2025-2026_sntfc.xml' },
  { operator: 'Interregional Călători', url: 'https://data.gov.ro/dataset/b4e2ce0b-6935-44b1-8e9d-f3999123358a/resource/1a083cf5-d37c-4618-aeb8-3f1ba0dd22dc/download/trenuri-2025-2026_interregional-calatori.xml' },
  { operator: 'Regio Călători', url: 'https://data.gov.ro/dataset/1da1018d-df38-4b5f-9667-88e4521abfb3/resource/771c1e7f-e552-46aa-8a6b-b9276b9b556c/download/trenuri-2025-2026_regio-calatori.xml' },
  { operator: 'Transferoviar Călători', url: 'https://data.gov.ro/dataset/9d4adc7b-d407-46c2-9003-5aa87cd16fb7/resource/2f1d9f58-1e97-4a4a-bc65-86c52b7db1a9/download/trenuri-2025-2026_transferoviar-calatori.xml' },
  { operator: 'Astra Trans Carpatic', url: 'https://data.gov.ro/dataset/1d057a43-3eaa-4fed-a349-4106f3ad0e49/resource/aab96a77-0fbe-4770-8408-e7b23c90480d/download/trenuri-2025-2026_astratranscarpatic.xml' }
];

// ─── STORES ────────────────────────────────────────────────────────────────
let trains       = new Map();  
let stationIndex = new Map();  
let stationGPS   = new Map();  
let dataReady    = false;

// ─── HELPERS ───────────────────────────────────────────────────────────────
function norm(n) { return (n||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
function timeToMins(t) { if(!t) return -1; const [h,m] = t.split(':').map(Number); return h*60+m; }
function secToTime(sec) {
  if (!sec) return null;
  const totalMin = Math.floor(parseInt(sec) / 60);
  return `${String(Math.floor(totalMin/60)%24).padStart(2,'0')}:${String(totalMin%60).padStart(2,'0')}`;
}

// ─── POSITION ENGINE (REAL-TIME) ──────────────────────────────────────────
// 
function getLiveTrainPosition(train) {
  const now = new Date();
  const currentMins = now.getHours() * 60 + now.getMinutes();
  
  for (let i = 0; i < train.stations.length - 1; i++) {
    const s1 = train.stations[i];
    const s2 = train.stations[i+1];
    const depM = timeToMins(s1.dep);
    const arrM = timeToMins(s2.arr);

    if (currentMins >= depM && currentMins <= arrM) {
      const g1 = stationGPS.get(norm(s1.name));
      const g2 = stationGPS.get(norm(s2.name));
      if (!g1 || !g2) return null;

      // Linear Interpolation: Calculate % of journey completed
      const progress = (currentMins - depM) / (arrM - depM);
      return {
        lat: g1.lat + (g2.lat - g1.lat) * progress,
        lng: g1.lng + (g2.lng - g1.lng) * progress,
        heading: Math.atan2(g2.lng - g1.lng, g2.lat - g1.lat) * (180 / Math.PI)
      };
    }
  }
  return null;
}

// ─── XML PARSER & DATA LOADING ─────────────────────────────────────────────
function parseCFRXml(xml, operator) {
  const result = [];
  const trainRe = /<Tren\b([^>]*)>([\s\S]*?)<\/Tren>/g;
  let tm;
  while ((tm = trainRe.exec(xml)) !== null) {
    const attrs = tm[1];
    const body  = tm[2];
    const numM = attrs.match(/Numar="([^"]+)"/);
    const bitmaskM = body.match(/bitmask="([^"]+)"/i) || attrs.match(/bitmask="([^"]+)"/i);
    const stations = [];
    const elemRe = /<ElementTrasa\b([^>]*)\/>/g;
    let em;
    while ((em = elemRe.exec(body)) !== null) {
      const ea = em[1];
      const name = (ea.match(/DenStaOrigine="([^"]+)"/) || [])[1];
      const arr = (ea.match(/OraS="([^"]+)"/) || [])[1];
      const dep = (ea.match(/OraP="([^"]+)"/) || [])[1];
      if (name) stations.push({ name, arr: secToTime(arr), dep: secToTime(dep) });
    }
    if (stations.length >= 2) result.push({ number: numM[1].trim(), operator, stations, bitmask: bitmaskM?bitmaskM[1]:null });
  }
  return result;
}

async function loadData() {
  try {
    const r = await axios.get(STATION_GPS_URL);
    r.data.features.forEach(f => stationGPS.set(norm(f.properties.name), { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }));
    
    for (const src of XML_SOURCES) {
      const xr = await axios.get(src.url, { timeout: 120000 });
      const parsed = parseCFRXml(xr.data, src.operator);
      parsed.forEach(t => {
        trains.set(t.number, t);
        t.stations.forEach(st => {
          const n = norm(st.name);
          if (!stationIndex.has(n)) stationIndex.set(n, new Set());
          stationIndex.get(n).add(t.number);
        });
      });
    }
    dataReady = true;
    console.log("System Ready");
    startRealTimeBroadcast();
  } catch (e) { console.error("Load Error"); }
}

// ─── WEBSOCKET BROADCAST ───────────────────────────────────────────────────
function startRealTimeBroadcast() {
  setInterval(() => {
    const updates = [];
    trains.forEach(t => {
      const pos = getLiveTrainPosition(t);
      if (pos) {
        updates.push({ id: t.number, op: t.operator, ...pos });
      }
    });
    io.emit('train_updates', updates);
  }, 30000); // Send updates every 30 seconds
}

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ready: dataReady, active_trains: trains.size }));

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  loadData();
});
