'use strict';
const express = require('express');
const cors    = require('cors');
const axios   = require('axios'); 
const cheerio = require('cheerio'); 

const app = express();
app.use(cors());

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
// The start of the 2025-2026 rail year
const RAIL_YEAR_START = new Date('2025-12-14T00:00:00Z');
const STATION_GPS_URL = 'https://raw.githubusercontent.com/vasile/data.gov.ro-gtfs-exporter/master/cfr.webgis.ro/stops.geojson';

const XML_SOURCES = [
  { operator: 'CFR Călători', url: 'https://data.gov.ro/dataset/c4f71dbb-de39-49b2-b697-5b60a5f299a2/resource/0f67143e-bb88-4a06-8e7a-b35b1eb91329/download/trenuri-2025-2026_sntfc.xml' },
  { operator: 'Interregional Călători', url: 'https://data.gov.ro/dataset/b4e2ce0b-6935-44b1-8e9d-f3999123358a/resource/1a083cf5-d37c-4618-aeb8-3f1ba0dd22dc/download/trenuri-2025-2026_interregional-calatori.xml' },
  { operator: 'Regio Călători', url: 'https://data.gov.ro/dataset/1da1018d-df38-4b5f-9667-88e4521abfb3/resource/771c1e7f-e552-46aa-8a6b-b9276b9b556c/download/trenuri-2025-2026_regio-calatori.xml' },
  { operator: 'Transferoviar Călători', url: 'https://data.gov.ro/dataset/9d4adc7b-d407-46c2-9003-5aa87cd16fb7/resource/2f1d9f58-1e97-4a4a-bc65-86c52b7db1a9/download/trenuri-2025-2026_transferoviar-calatori.xml' },
  { operator: 'Astra Trans Carpatic', url: 'https://data.gov.ro/dataset/1d057a43-3eaa-4fed-a349-4106f3ad0e49/resource/aab96a77-0fbe-4770-8408-e7b23c90480d/download/trenuri-2025-2026_astratranscarpatic.xml' }
];

// ─── IN-MEMORY STORE ───────────────────────────────────────────────────────
let trains       = new Map();  
let stationIndex = new Map();  
let stationGPS   = new Map();  
let dataReady    = false;
let loadStatus   = 'starting';

// ─── GHOST BUSTING ENGINE ──────────────────────────────────────────────────

// Layer 1: Bitmask (The Calendar Check)
function isScheduledByBitmask(train, targetDate = new Date()) {
  if (!train.bitmask || train.bitmask.length < 100) return null;
  const dayIndex = Math.floor((targetDate - RAIL_YEAR_START) / 86400000);
  if (dayIndex < 0 || dayIndex >= train.bitmask.length) return false;
  return train.bitmask[dayIndex] === '1';
}

// Layer 2: IRIS Handshake (The Physical Check)
async function getLiveIRISBoard(stationName) {
  const url = 'http://appiris.infofer.ro/SosPlcRO.aspx';
  try {
    const { data: html1 } = await axios.get(url, { timeout: 8000 });
    const $1 = cheerio.load(html1);
    const formData = new URLSearchParams();
    
    formData.append('__VIEWSTATE', $1('#__VIEWSTATE').val() || '');
    formData.append('__EVENTVALIDATION', $1('#__EVENTVALIDATION').val() || '');
    formData.append('__VIEWSTATEGENERATOR', $1('#__VIEWSTATEGENERATOR').val() || '');
    formData.append('ctl00$ContentPlaceHolder1$txtStatie', stationName);
    formData.append('ctl00$ContentPlaceHolder1$txtData', todayStr());
    formData.append('ctl00$ContentPlaceHolder1$btnCauta', 'Cauta');

    const { data: html2 } = await axios.post(url, formData, { timeout: 10000 });
    const activeTrains = new Set();
    const $2 = cheerio.load(html2);
    
    $2('table tr').each((_, el) => {
      const text = $2(el).text();
      const match = text.match(/\b(\d{3,6})\b/);
      if (match) activeTrains.add(match[1]);
    });
    
    return activeTrains;
  } catch (e) {
    console.error(`[IRIS] Failed for ${stationName}`);
    return null; // Fail-safe: don't block if IRIS is down
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function norm(name) {
  return (name || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function resolveStation(userInput) {
  const n = norm(userInput);
  if (stationIndex.has(n)) return n;
  for (const key of stationIndex.keys()) { if (key.startsWith(n + ' ') || key === n) return key; }
  return n;
}

function secToTime(sec) {
  if (sec == null || sec === '') return null;
  const totalMin = Math.floor(parseInt(sec) / 60);
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ─── PARSER ────────────────────────────────────────────────────────────────
function parseCFRXml(xml, operator) {
  const result = [];
  const trainRe = /<Tren\b([^>]*)>([\s\S]*?)<\/Tren>/g;
  let tm;
  while ((tm = trainRe.exec(xml)) !== null) {
    const attrs = tm[1];
    const body  = tm[2];
    const numM  = attrs.match(/Numar="([^"]+)"/);
    if (!numM) continue;

    const bitmaskM = body.match(/bitmask="([^"]+)"/i) || attrs.match(/bitmask="([^"]+)"/i) || body.match(/BitSet="([^"]+)"/i);
    const bitmask  = bitmaskM ? bitmaskM[1] : null;

    const stations = [];
    const elemRe = /<ElementTrasa\b([^>]*)\/>/g;
    let em;
    while ((em = elemRe.exec(body)) !== null) {
      const ea = em[1];
      const name = (ea.match(/DenStaOrigine="([^"]+)"/) || [])[1];
      const dep  = (ea.match(/OraP="([^"]+)"/) || [])[1];
      if (name) stations.push({ name, dep: secToTime(dep) });
    }
    
    if (stations.length >= 2) {
      result.push({ number: numM[1].trim(), operator, stations, bitmask });
    }
  }
  return result;
}

// ─── DATA LOADING ──────────────────────────────────────────────────────────
async function loadData() {
  loadStatus = 'loading...';
  try {
    const gpsRes = await axios.get(STATION_GPS_URL);
    gpsRes.data.features.forEach(f => {
      stationGPS.set(norm(f.properties.name), { name: f.properties.name, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] });
    });
  } catch (e) { console.error("GPS Load Failed"); }

  for (const src of XML_SOURCES) {
    try {
      console.log(`[boot] Fetching ${src.operator}...`);
      const r = await axios.get(src.url, { timeout: 120000 });
      const parsed = parseCFRXml(r.data, src.operator);
      parsed.forEach(t => {
        trains.set(t.number, t);
        t.stations.forEach(st => {
          const n = norm(st.name);
          if (!stationIndex.has(n)) stationIndex.set(n, new Set());
          stationIndex.get(n).add(t.number);
        });
      });
      r.data = null; // Clear memory immediately
    } catch (e) { console.error(`Failed source: ${src.operator}`); }
  }
  dataReady = true;
  loadStatus = 'ready';
  console.log(`READY: ${trains.size} trains in memory.`);
}

// ─── API ROUTES ────────────────────────────────────────────────────────────

// Station Board with TRIPLE-CHECK GHOST BUSTING
app.get('/api/board/:stationName', async (req, res) => {
  if (!dataReady) return res.status(503).json({ error: 'Data loading...' });

  const input = req.params.stationName;
  const n = resolveStation(input);
  const nums = stationIndex.get(n);

  if (!nums) return res.status(404).json({ error: 'Station not found' });

  // 1. Bitmask Filter
  const candidates = Array.from(nums)
    .map(num => trains.get(num))
    .filter(t => isScheduledByBitmask(t, new Date()) !== false);

  // 2. IRIS Handshake
  const liveList = await getLiveIRISBoard(input);

  const departures = candidates.map(t => {
    const isLive = liveList ? liveList.has(t.number) : null;
    
    // IF IRIS is online and the train is NOT there, it's a ghost. DELETE IT.
    if (isLive === false) return null; 

    const st = t.stations.find(s => norm(s.name) === n);
    return {
      time: st ? st.dep : '--:--',
      train: t.number,
      operator: t.operator,
      status: isLive ? 'confirmed' : 'unverified'
    };
  }).filter(Boolean).sort((a,b) => a.time.localeCompare(b.time));

  res.json({ station: input, departures });
});

app.get('/health', (req, res) => res.json({ status: loadStatus, ready: dataReady, trains: trains.size }));

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server live on ${PORT}`);
  loadData();
});
