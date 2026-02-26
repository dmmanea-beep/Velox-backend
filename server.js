'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const axios   = require('axios'); 
const cheerio = require('cheerio'); 

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }));
app.options('*', cors());

// ─── DATA SOURCES ──────────────────────────────────────────────────────────
const XML_SOURCES = [
  { operator: 'CFR Călători', url: 'https://data.gov.ro/dataset/c4f71dbb-de39-49b2-b697-5b60a5f299a2/resource/0f67143e-bb88-4a06-8e7a-b35b1eb91329/download/trenuri-2025-2026_sntfc.xml' },
  { operator: 'Interregional Călători', url: 'https://data.gov.ro/dataset/b4e2ce0b-6935-44b1-8e9d-f3999123358a/resource/1a083cf5-d37c-4618-aeb8-3f1ba0dd22dc/download/trenuri-2025-2026_interregional-calatori.xml' },
  { operator: 'Regio Călători', url: 'https://data.gov.ro/dataset/1da1018d-df38-4b5f-9667-88e4521abfb3/resource/771c1e7f-e552-46aa-8a6b-b9276b9b556c/download/trenuri-2025-2026_regio-calatori.xml' },
  { operator: 'Transferoviar Călători', url: 'https://data.gov.ro/dataset/9d4adc7b-d407-46c2-9003-5aa87cd16fb7/resource/2f1d9f58-1e97-4a4a-bc65-86c52b7db1a9/download/trenuri-2025-2026_transferoviar-calatori.xml' },
  { operator: 'Astra Trans Carpatic', url: 'https://data.gov.ro/dataset/1d057a43-3eaa-4fed-a349-4106f3ad0e49/resource/aab96a77-0fbe-4770-8408-e7b23c90480d/download/trenuri-2025-2026_astratranscarpatic.xml' }
];

const STATION_GPS_URL = 'https://raw.githubusercontent.com/vasile/data.gov.ro-gtfs-exporter/master/cfr.webgis.ro/stops.geojson';
const IRIS_URL = (trainNum) => `https://appiris.infofer.ro/MyTrainRO.aspx?tren=${encodeURIComponent(trainNum)}`;

// --- 2025-2026 RAIL YEAR CONFIGURATION ---
const RAIL_YEAR_START = new Date('2025-12-14T00:00:00Z'); //

// ─── IN-MEMORY STORE ───────────────────────────────────────────────────────
let trains       = new Map();  
let stationIndex = new Map();  
let stationGPS   = new Map();  
let dataReady    = false;
let loadStatus   = 'starting';

const _cache = {};
const cacheGet = (k) => { const i = _cache[k]; return (i && Date.now() < i.e) ? i.v : null; };
const cacheSet = (k, v, s) => { _cache[k] = { v, e: Date.now() + s * 1000 }; };

// ─── HTTP HELPER (Legacy) ───────────────────────────────────────────────────
function get(url, timeout = 60000, hops = 0) {
  return new Promise((res, rej) => {
    if (hops > 5) return rej(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'VeloxApp/4.0', 'Accept': '*/*' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const next = r.headers.location.startsWith('http') ? r.headers.location : new URL(r.headers.location, url).href;
        return res(get(next, timeout, hops + 1));
      }
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rej);
    req.setTimeout(timeout, () => { req.destroy(); rej(new Error('Timeout: ' + url)); });
  });
}

// ─── LAYER 1: BITMASK VALIDATION ───────────────────────────────────────────
function isScheduledByBitmask(train, targetDate = new Date()) {
  if (!train.bitmask || train.bitmask.length < 100) return null; //
  const dayIndex = Math.floor((targetDate - RAIL_YEAR_START) / 86400000); //
  if (dayIndex < 0 || dayIndex >= train.bitmask.length) return false;
  return train.bitmask[dayIndex] === '1'; //
}

// ─── LAYER 2: AUTHORITATIVE IRIS HANDSHAKE ─────────────────────────────────
async function getLiveIRISBoard(stationName) {
  const url = 'http://appiris.infofer.ro/SosPlcRO.aspx';
  try {
    const { data: html1 } = await axios.get(url, { timeout: 7000 });
    const $1 = cheerio.load(html1);
    const formData = new URLSearchParams();
    formData.append('__VIEWSTATE', $1('#__VIEWSTATE').val() || '');
    formData.append('__EVENTVALIDATION', $1('#__EVENTVALIDATION').val() || '');
    formData.append('__VIEWSTATEGENERATOR', $1('#__VIEWSTATEGENERATOR').val() || '');
    formData.append('ctl00$ContentPlaceHolder1$txtStatie', stationName);
    formData.append('ctl00$ContentPlaceHolder1$txtData', todayStr());
    formData.append('ctl00$ContentPlaceHolder1$btnCauta', 'Cauta');

    const { data: html2 } = await axios.post(url, formData, { timeout: 10000 });
    if (/nu circul[aă]/i.test(html2)) return new Set();

    const activeTrains = new Set();
    const $2 = cheerio.load(html2);
    $2('table tr').each((_, el) => {
      const match = $2(el).text().match(/(?:IR|R|RE|IC|IRN|EN|EC)\s*(\d+)/i);
      if (match) activeTrains.add(match[1]);
    });
    return activeTrains;
  } catch (e) {
    console.error(`[IRIS Handshake Error] ${stationName}:`, e.message);
    return null; 
  }
}

// ─── HELPERS ───────────────────────────────────────────────────────────────
function secToTime(sec) {
  if (sec == null || sec === '') return null;
  const s = parseInt(sec);
  const totalMin = Math.floor(s / 60);
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeToMins(t) {
  if (!t) return -1;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function durStr(mins) {
  if (mins <= 0) return '';
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function norm(name) {
  return (name || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveStation(userInput) {
  const n = norm(userInput);
  if (stationIndex.has(n)) return n;
  for (const key of stationIndex.keys()) { if (key.startsWith(n + ' ') || key === n) return key; }
  return n;
}

function guessType(cat) {
  const c = (cat || '').toUpperCase();
  if (c === 'EC') return 'EuroCity';
  if (c === 'IC') return 'InterCity';
  if (c === 'IR') return 'InterRegio';
  if (c === 'RE' || c === 'RX') return 'RegioExpress';
  if (c === 'R') return 'Regio';
  return 'Tren';
}

function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

// ─── XML PARSER ────────────────────────────────────────────────────────────
function parseCFRXmlV2(xml, defaultOperator) {
  const result = [];
  const trainRe = /<Tren\b([^>]*)>([\s\S]*?)<\/Tren>/g;
  let tm;

  while ((tm = trainRe.exec(xml)) !== null) {
    const attrs = tm[1];
    const body  = tm[2];
    const numM = attrs.match(/Numar="([^"]+)"/);
    const catM = attrs.match(/CategorieTren="([^"]+)"/);
    if (!numM) continue;

    const number = numM[1].trim();
    const category = catM ? catM[1].trim() : '';

    // Extract Bitmask for validation
    const bitmaskM = body.match(/bitmask="([^"]+)"/i) || attrs.match(/bitmask="([^"]+)"/i);
    const bitmask = bitmaskM ? bitmaskM[1] : null;

    const allElems = [...body.matchAll(/<ElementTrasa\b([^>]*)\/>/g)];
    const stations = [];

    allElems.forEach((em) => {
      const ea = em[1];
      const oName = (ea.match(/DenStaOrigine="([^"]+)"/) || [])[1];
      const oraP = (ea.match(/OraP="([^"]+)"/) || [])[1];
      const oraS = (ea.match(/OraS="([^"]+)"/) || [])[1];
      if (oName) stations.push({ name: oName, arr: secToTime(oraS), dep: secToTime(oraP) });
    });

    if (stations.length >= 2) {
      result.push({ number, category, type: guessType(category), operator: defaultOperator, stations, bitmask });
    }
  }
  return result;
}

// ─── JOURNEY SEARCH (Itineraries) ──────────────────────────────────────────
function findDirectJourneys(fromNorm, toNorm, dateStr) {
  const fromSet = stationIndex.get(fromNorm) || new Set();
  const toSet   = stationIndex.get(toNorm)   || new Set();
  const results = [];

  for (const tNum of fromSet) {
    if (!toSet.has(tNum)) continue;
    const train = trains.get(tNum);
    if (!train) continue;

    const fi = train.stations.findIndex(s => norm(s.name) === fromNorm);
    const ti = train.stations.findIndex(s => norm(s.name) === toNorm);
    if (fi < 0 || ti < 0 || fi >= ti) continue;

    const dep = train.stations[fi].dep || train.stations[fi].arr;
    const arr = train.stations[ti].arr || train.stations[ti].dep;
    if (!dep || !arr) continue;

    const depM = timeToMins(dep);
    const arrM = timeToMins(arr);
    const durM = arrM >= depM ? arrM - depM : arrM + 1440 - depM;

    results.push({ dep, arr, depM, arrM, durM, number: train.number, category: train.category, operator: train.operator });
  }
  return results.sort((a, b) => a.depM - b.depM);
}

// ─── LOAD DATA ─────────────────────────────────────────────────────────────
async function loadData() {
  loadStatus = 'loading...';
  try {
    const r = await axios.get(STATION_GPS_URL);
    for (const f of r.data.features) {
      const [lng, lat] = f.geometry.coordinates;
      stationGPS.set(norm(f.properties.name), { name: f.properties.name, lat, lng });
    }
  } catch (e) { console.warn('GPS failed'); }

  for (const src of XML_SOURCES) {
    try {
      const r = await axios.get(src.url, { timeout: 60000 });
      const parsed = parseCFRXmlV2(r.data, src.operator);
      for (const t of parsed) {
        trains.set(t.number, t);
        for (const st of t.stations) {
          const n = norm(st.name);
          if (!stationIndex.has(n)) stationIndex.set(n, new Set());
          stationIndex.get(n).add(t.number);
        }
      }
    } catch (e) { console.error(`Error ${src.operator}`); }
  }
  dataReady = true;
  loadStatus = 'ready';
}

// ─── API ROUTES ────────────────────────────────────────────────────────────
app.get('/api/board/:stationName', async (req, res) => {
  if (!dataReady) return res.status(503).json({ error: 'Loading...' });
  const n = resolveStation(req.params.stationName);
  const nums = stationIndex.get(n);
  if (!nums) return res.status(404).json({ error: 'Not found' });

  const today = new Date();
  const candidates = Array.from(nums).map(num => trains.get(num)).filter(t => isScheduledByBitmask(t, today) !== false);
  const liveList = await getLiveIRISBoard(req.params.stationName);

  const departures = candidates.map(t => {
    const isLive = liveList ? liveList.has(t.number) : null;
    if (isLive === false) return null; // GHOST BUSTED
    const st = t.stations.find(s => norm(s.name) === n);
    return { time: st?.dep || '--:--', train: `${t.category} ${t.number}`, number: t.number, operator: t.operator, status: isLive ? 'confirmed' : 'unverified' };
  }).filter(Boolean).sort((a,b) => a.time.localeCompare(b.time));

  res.json({ station: req.params.stationName, departures });
});

app.get('/api/itineraries', async (req, res) => {
  const from = norm(req.query.from);
  const to = norm(req.query.to);
  if (!from || !to) return res.status(400).json({ error: 'Params required' });
  const journeys = findDirectJourneys(from, to, todayStr());
  res.json({ from, to, journeys });
});

app.get('/health', (req, res) => res.json({ status: loadStatus, ready: dataReady, trains: trains.size }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server live on ${PORT}`);
  loadData();
});
