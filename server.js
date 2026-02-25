'use strict';
/**
 * Velox backend (Render/Railway-friendly)
 * - Keeps the SAME endpoints your app expects:
 *   /api/stations?q=
 *   /api/itineraries?from=&to=&date=DD.MM.YYYY&time=HH:MM&limit=
 *   /api/train/:trainNo
 *   /api/train/station/:stationId
 *   /health
 *
 * - Whole-day itineraries (no hard cap of 25)
 * - Sorts results so first items are departures AFTER requested time
 * - Optional "validateToday=1" to drop trains that IRIS says have no stops today
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const https = require('https');
const http = require('http');

// Use your existing InfoFer scrapers (already in your repo)
const infofer = require('./infofer');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// Timetable sources (user-provided) — can be overridden via TIMETABLE_URL_1..10
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SOURCES = [
  { operator: 'CFR Călători', url: 'https://data.gov.ro/dataset/c4f71dbb-de39-49b2-b697-5b60a5f299a2/resource/0f67143e-bb88-4a06-8e7a-b35b1eb91329/download/trenuri-2025-2026_sntfc.xml' },
  { operator: 'Interregional Călători', url: 'https://data.gov.ro/dataset/b4e2ce0b-6935-44b1-8e9d-f3999123358a/resource/1a083cf5-d37c-4618-aeb8-3f1ba0dd22dc/download/trenuri-2025-2026_interregional-calatori.xml' },
  { operator: 'Transferoviar Călători', url: 'https://data.gov.ro/dataset/9d4adc7b-d407-46c2-9003-5aa87cd16fb7/resource/2f1d9f58-1e97-4a4a-bc65-86c52b7db1a9/download/trenuri-2025-2026_tfc.xml' },
  { operator: 'Regio Călători', url: 'https://data.gov.ro/dataset/1da1018d-df38-4b5f-9667-88e4521abfb3/resource/771c1e7f-e552-46aa-8a6b-b9276b9b556c/download/trenuri-2025-2026_regio-calatori.xml' },
  { operator: 'Softrans', url: 'https://data.gov.ro/dataset/e4ba7432-2904-4cc4-9588-2afbf021756e/resource/3bf9600e-7ae4-45fb-a46e-8184576544a1/download/trenuri-2025-2026_softrans.xml' },
];

function envSources() {
  const urls = [];
  for (let i = 1; i <= 10; i++) {
    const v = process.env[`TIMETABLE_URL_${i}`];
    if (v && String(v).trim()) urls.push(String(v).trim());
  }
  return urls.length ? urls.map(u => ({ operator: 'Unknown', url: u })) : DEFAULT_SOURCES;
}

const SOURCES = envSources();

// ─────────────────────────────────────────────────────────────────────────────
// In-memory timetable store
// ─────────────────────────────────────────────────────────────────────────────
/** trains: Map<id, {id, number, type, operator, stations:[{name, dep, arr}]} > */
const trains = new Map();
/** stationNorm -> Set(trainId) */
const stationIndex = new Map();

let lastLoadAt = null;
let lastLoadError = null;
let lastDownloadedBytes = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function norm(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toMins(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(mi)) return null;
  return h * 60 + mi;
}

function durStr(mins) {
  if (mins == null) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function todayDMY_Bucharest() {
  // Format: DD.MM.YYYY in Europe/Bucharest
  const parts = new Intl.DateTimeFormat('ro-RO', {
    timeZone: 'Europe/Bucharest',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const dd = parts.find(p => p.type === 'day')?.value;
  const mm = parts.find(p => p.type === 'month')?.value;
  const yy = parts.find(p => p.type === 'year')?.value;
  return `${dd}.${mm}.${yy}`;
}

function getUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(getUrl(res.headers.location));
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Request timeout')));
  });
}

// Very lightweight, best-effort XML parsing (enough for journey search)
function parseXmlIntoStore(xmlText, defaultOperator) {
  const xml = xmlText.toString('utf8');

  // Try both Romanian tags (Tren / Statie) and some variants
  const trainRe = /<Tren([^>]*)>([\s\S]*?)<\/Tren>/gi;
  let match;
  while ((match = trainRe.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';

    const number = (
      attrs.match(/(?:numar|NumarTren|nr|number)="([^"]+)"/i)?.[1] ||
      body.match(/<\s*(?:NumarTren|Numar|nr)\s*>\s*([^<]+)\s*<\//i)?.[1] ||
      ''
    ).trim();

    if (!number) continue;

    const type = (
      body.match(/<\s*(?:Categorie|TipTren|Tip)\s*>\s*([^<]+)\s*<\//i)?.[1] ||
      ''
    ).trim();

    const operator = (
      body.match(/<\s*(?:Operator|Companie)\s*>\s*([^<]+)\s*<\//i)?.[1] ||
      defaultOperator ||
      'Unknown'
    ).trim();

    const stations = [];

    // Common: <Statie> ... <Denumire> ... <OraP> / <OraS> etc
    const stRe = /<(?:Statie|Stație)[^>]*>([\s\S]*?)<\/(?:Statie|Stație)>/gi;
    let sm;
    while ((sm = stRe.exec(body)) !== null) {
      const sb = sm[1] || '';
      const name = (
        sb.match(/<\s*(?:Denumire|Nume)\s*>\s*([^<]+)\s*<\//i)?.[1] ||
        ''
      ).trim();

      if (!name) continue;

      const dep = (
        sb.match(/<\s*(?:OraP|OraPlecare|Plecare)\s*>\s*([^<]+)\s*<\//i)?.[1] ||
        ''
      ).trim();
      const arr = (
        sb.match(/<\s*(?:OraS|OraSosire|Sosire)\s*>\s*([^<]+)\s*<\//i)?.[1] ||
        ''
      ).trim();

      stations.push({ name, dep, arr });
    }

    // Some files use different station tag names; if we got nothing, try a simpler fallback
    if (stations.length < 2) {
      // Look for <NumeStatie> ... <OraPlecare> ... blocks (rare)
    }

    if (stations.length < 2) continue;

    const id = `${operator}|${number}|${stations[0].name}|${stations[stations.length - 1].name}|${stations[0].dep || stations[0].arr || ''}`;
    if (trains.has(id)) continue;

    trains.set(id, { id, number, type, operator, stations });

    // Index each station name for quick contains matching
    for (const st of stations) {
      const k = norm(st.name);
      if (!k) continue;
      if (!stationIndex.has(k)) stationIndex.set(k, new Set());
      stationIndex.get(k).add(id);
    }
  }
}

async function loadAllTimetables() {
  trains.clear();
  stationIndex.clear();
  lastDownloadedBytes = 0;
  lastLoadError = null;

  try {
    for (const src of SOURCES) {
      const buf = await getUrl(src.url);
      lastDownloadedBytes += buf.length;
      parseXmlIntoStore(buf, src.operator);
    }
    lastLoadAt = new Date().toISOString();
  } catch (e) {
    lastLoadError = e.message;
    lastLoadAt = null;
  }
}

let loadPromise = null;
function ensureLoaded() {
  if (loadPromise) return loadPromise;
  loadPromise = loadAllTimetables();
  return loadPromise;
}

// Find candidate train IDs that include both stations (substring/word match)
function findStationKeysApprox(name) {
  const n = norm(name);
  if (!n) return [];
  // Use tokens of length >=3
  const toks = n.split(' ').filter(w => w.length >= 3);
  return toks.length ? toks : [n];
}

function stationMatches(stName, tokens) {
  const sn = norm(stName);
  return tokens.some(t => sn.includes(t));
}

function searchJourneysWholeDay(fromName, toName) {
  const fromToks = findStationKeysApprox(fromName);
  const toToks = findStationKeysApprox(toName);

  const out = [];

  for (const t of trains.values()) {
    let fromIdx = -1;
    let toIdx = -1;

    for (let i = 0; i < t.stations.length; i++) {
      if (fromIdx === -1 && stationMatches(t.stations[i].name, fromToks)) fromIdx = i;
      if (stationMatches(t.stations[i].name, toToks)) toIdx = i;
    }

    if (fromIdx === -1 || toIdx === -1 || toIdx <= fromIdx) continue;

    const dep = t.stations[fromIdx].dep || t.stations[fromIdx].arr || '';
    const arr = t.stations[toIdx].arr || t.stations[toIdx].dep || '';

    const depM = toMins(dep);
    const arrM = toMins(arr);
    if (depM == null || arrM == null) continue;

    let dur = arrM - depM;
    if (dur < 0) dur += 24 * 60; // crosses midnight

    out.push({
      dep,
      arr,
      duration: durStr(dur),
      changes: 0,
      trains: [t.number],
      operator: t.operator,
      category: t.type,
    });
  }

  return out;
}

function cmpByDep(a, b) {
  return (toMins(a.dep) ?? 0) - (toMins(b.dep) ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  // do not auto-load here (to avoid cold-start penalties). but show counts
  res.json({
    status: 'ok',
    trains: trains.size,
    lastLoadAt,
    lastLoadError,
    timetableUrlsConfigured: SOURCES.length,
    lastDownloadedBytes,
    time: new Date().toISOString(),
  });
});

// Stations autocomplete (InfoFer API)
app.get('/api/stations', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q || q.length < 2) return res.status(400).json({ error: 'q must be at least 2 chars' });
  try {
    const stations = await infofer.searchStations(q);
    res.json({ stations });
  } catch (e) {
    res.status(502).json({ error: 'station search failed', detail: e.message });
  }
});

// Whole-day itineraries from XML
app.get('/api/itineraries', async (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const date = String(req.query.date || '').trim(); // DD.MM.YYYY
  const time = String(req.query.time || '').trim(); // HH:MM
  const limit = Math.min(parseInt(req.query.limit || '300', 10) || 300, 1000);
  const offset = Math.max(parseInt(req.query.offset || '0', 10) || 0, 0);
  const validateToday = String(req.query.validateToday || '0') === '1';

  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

  await ensureLoaded();
  if (lastLoadError) {
    return res.status(500).json({ error: 'timetable not loaded', detail: lastLoadError });
  }

  const targetMins = time ? toMins(time) : null;

  let journeys = searchJourneysWholeDay(from, to);

  // Order: first those after target time, then the rest
  journeys.sort(cmpByDep);
  if (targetMins != null) {
    const upcoming = journeys.filter(j => (toMins(j.dep) ?? 0) >= targetMins);
    const past = journeys.filter(j => (toMins(j.dep) ?? 0) < targetMins);
    journeys = [...upcoming, ...past];
  }

  // OPTIONAL: if user is searching for TODAY, we can drop trains that IRIS says have no stops.
  // This is a best-effort filter to reduce "phantom trains" without scraping InfoFer itineraries.
  if (validateToday && date && date === todayDMY_Bucharest()) {
    const sliceForValidate = journeys.slice(0, 80); // validate only top results for speed
    const ok = [];

    // small concurrency to avoid hammering
    const conc = 6;
    let idx = 0;

    async function worker() {
      while (idx < sliceForValidate.length) {
        const i = idx++;
        const j = sliceForValidate[i];
        const trainNo = (j.trains && j.trains[0]) ? String(j.trains[0]).replace(/[^0-9]/g,'') : '';
        if (!trainNo) { ok.push(j); continue; }
        try {
          const st = await infofer.fetchTrainStatus(trainNo);
          if (st && Array.isArray(st.stations) && st.stations.length >= 2) ok.push(j);
        } catch {
          // if IRIS fails, keep it (avoid deleting everything on temporary outages)
          ok.push(j);
        }
      }
    }

    await Promise.all(Array.from({ length: conc }, () => worker()));
    const okKeys = new Set(ok.map(x => `${x.trains?.[0]}|${x.dep}|${x.arr}`));
    const rest = journeys.slice(80);
    journeys = [...ok, ...rest.filter(x => okKeys.has(`${x.trains?.[0]}|${x.dep}|${x.arr}`) || true)];
  }

  const total = journeys.length;
  const paged = journeys.slice(offset, offset + limit);

  res.json({
    from,
    to,
    date: date || null,
    time: time || null,
    total,
    offset,
    limit,
    journeys: paged,
  });
});

// Live train status (IRIS)
app.get('/api/train/:trainNo', async (req, res) => {
  const trainNo = String(req.params.trainNo || '').trim();
  if (!trainNo) return res.status(400).json({ error: 'trainNo required' });
  try {
    // IRIS expects numeric number
    const numeric = trainNo.replace(/[^0-9]/g, '');
    const status = await infofer.fetchTrainStatus(numeric || trainNo);
    res.json(status);
  } catch (e) {
    res.status(502).json({ error: 'train status failed', detail: e.message });
  }
});

// Station board (IRIS)
app.get('/api/train/station/:stationId', async (req, res) => {
  const stationId = String(req.params.stationId || '').trim();
  if (!stationId) return res.status(400).json({ error: 'stationId required' });
  try {
    const departures = await infofer.fetchStationBoard(stationId);
    res.json({ stationId, departures });
  } catch (e) {
    res.status(502).json({ error: 'station board failed', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Velox backend running on port ${PORT}`);
  // Start loading timetables in the background (but still in-process)
  ensureLoaded().catch(() => {});
});
