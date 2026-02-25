'use strict';
/**
 * Velox backend — timetable search + station board
 * Fixes:
 * - No more hard cap of 12/25 results. Supports limit/offset and "whole-day" results.
 * - Sorts results relative to the user's requested time (time=HH:MM).
 * - Adds best-effort date validity filtering (date=DD.MM.YYYY) when present in XML.
 *
 * NOTE: The public XML feeds are "static reference data" and may not include full
 * exception calendars for every train. Where the XML lacks validity info, trains are
 * assumed to run daily.
 */
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }));
app.options('*', cors());

// ─── DATA SOURCES ──────────────────────────────────────────────────────────
// 2025-2026 XML URLs from data.gov.ro (user provided)
const XML_SOURCES = [
  { operator: 'CFR Călători',          url: 'https://data.gov.ro/dataset/c4f71dbb-de39-49b2-b697-5b60a5f299a2/resource/0f67143e-bb88-4a06-8e7a-b35b1eb91329/download/trenuri-2025-2026_sntfc.xml' },
  { operator: 'Interregional Călători',url: 'https://data.gov.ro/dataset/b4e2ce0b-6935-44b1-8e9d-f3999123358a/resource/1a083cf5-d37c-4618-aeb8-3f1ba0dd22dc/download/trenuri-2025-2026_interregional-calatori.xml' },
  { operator: 'Transferoviar Călători',url: 'https://data.gov.ro/dataset/9d4adc7b-d407-46c2-9003-5aa87cd16fb7/resource/2f1d9f58-1e97-4a4a-bc65-86c52b7db1a9/download/trenuri-2025-2026_tfc.xml' },
  { operator: 'Regio Călători',        url: 'https://data.gov.ro/dataset/1da1018d-df38-4b5f-9667-88e4521abfb3/resource/771c1e7f-e552-46aa-8a6b-b9276b9b556c/download/trenuri-2025-2026_regio-calatori.xml' },
  { operator: 'Softrans',              url: 'https://data.gov.ro/dataset/e4ba7432-2904-4cc4-9588-2afbf021756e/resource/3bf9600e-7ae4-45fb-a46e-8184576544a1/download/trenuri-2025-2026_softrans.xml' },
];

// Optional: set TIMETABLE_URL_1, TIMETABLE_URL_2, ... to override/add sources
function envTimetableUrls() {
  const urls = [];
  for (let i = 1; i <= 10; i++) {
    const v = process.env[`TIMETABLE_URL_${i}`];
    if (v && typeof v === 'string' && v.trim()) urls.push(v.trim());
  }
  return urls;
}

const TIMETABLE_URLS = envTimetableUrls().length
  ? envTimetableUrls().map(u => ({ operator: 'Unknown', url: u }))
  : XML_SOURCES;

// ─── IN-MEMORY STORE ───────────────────────────────────────────────────────
/**
 * trains map key: trainId (string)
 * value: { id, number, type, operator, stations[], daysMask, validFrom, validTo }
 */
const trains = new Map();
/** stationIndex: normalizedStationName -> Set(trainId) */
const stationIndex = new Map();

let dataLoaded = false;
let lastLoadAt = null;
let lastLoadError = null;
let lastDownloadedBytes = 0;

// ─── HELPERS ───────────────────────────────────────────────────────────────
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

function pad2(n){ return String(n).padStart(2,'0'); }

function toMins(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(mi)) return null;
  return (h * 60 + mi);
}

function durStr(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${pad2(m)}m`;
}

function parseDateDMY(s) {
  // supports DD.MM.YYYY and YYYY-MM-DD
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2]-1, +m[1], 0,0,0));
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], 0,0,0));
  return null;
}

function weekdayMon1(dateUtc) {
  // JS: 0=Sun..6=Sat => convert to Mon=1..Sun=7
  const d = dateUtc.getUTCDay();
  return d === 0 ? 7 : d;
}

function daysToMask(daysStr) {
  // Returns bitmask with bits 1..7 (Mon..Sun) set. 0 means "unknown".
  if (!daysStr) return 0;
  const s = String(daysStr).toUpperCase();

  if (s.includes('ZILNIC') || s.includes('DAILY') || s.includes('EVERY')) {
    return 0b11111110; // bits 1..7 set (ignore bit0)
  }

  // Digits 1-7 (Mon=1..Sun=7)
  const digits = [...new Set((s.match(/[1-7]/g) || []))].map(x=>parseInt(x,10));
  if (digits.length) {
    let mask = 0;
    for (const d of digits) mask |= (1 << d);
    return mask;
  }

  // Romanian abbreviations: L Ma Mi J V S D (sometimes Lu/Mar/Mie/Joi/Vin/Sam/Dum)
  // We'll look for tokens.
  const tokens = s
    .replace(/[^A-ZĂÂÎȘȚ]/g,' ')
    .split(/\s+/)
    .filter(Boolean);

  const map = {
    L:1, LU:1, LUN:1, LUNI:1,
    MA:2, MAR:2, MARTI:2, MARȚI:2,
    MI:3, MIE:3, MIERCURI:3,
    J:4, JO:4, JOI:4,
    V:5, VI:5, VIN:5, VINERI:5,
    S:6, SA:6, SAM:6, SAMBATA:6, SÂMBĂTĂ:6,
    D:7, DU:7, DUM:7, DUMINICA:7, DUMINICĂ:7,
  };

  let mask = 0;
  for (const t of tokens) {
    const key = t.length > 3 ? t : t; // keep as is
    if (map[key]) mask |= (1 << map[key]);
  }
  return mask;
}

function runsOn(train, dateStr) {
  // dateStr: "DD.MM.YYYY"
  if (!dateStr) return true; // no date => don't filter
  const d = parseDateDMY(dateStr);
  if (!d) return true;

  if (train.validFrom && d < train.validFrom) return false;
  if (train.validTo   && d > train.validTo)   return false;

  if (train.daysMask) {
    const wd = weekdayMon1(d);
    if ((train.daysMask & (1 << wd)) === 0) return false;
  }

  return true;
}

function getUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow redirect
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
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

// ─── XML PARSER (best-effort) ───────────────────────────────────────────────
function parseCFRXml(xml, defaultOperator) {
  const result = [];
  const trainRe = /<Tren([^>]*)>([\s\S]*?)<\/Tren>/gi;
  let tm;
  while ((tm = trainRe.exec(xml)) !== null) {
    const attrs  = tm[1] || '';
    const body   = tm[2] || '';

    const numM = attrs.match(/(?:numar|NumarTren|nr|number)="([^"]+)"/i) || body.match(/<\s*(?:NumarTren|Numar|nr)\s*>\s*([^<]+)\s*<\//i);
    if (!numM) continue;

    const tipM = attrs.match(/(?:tip|Tip|categorie|type)="([^"]+)"/i) || body.match(/<\s*(?:Tip|Categorie|Category|Type)\s*>\s*([^<]+)\s*<\//i);
    const opM  = attrs.match(/(?:operator|Operator)="([^"]+)"/i) || body.match(/<\s*(?:Operator)\s*>\s*([^<]+)\s*<\//i);

    // days/validity appear in different places over the years; try a few patterns
    const daysM =
      attrs.match(/(?:zile|days|circula|zilecirculatie)="([^"]+)"/i) ||
      body.match(/<\s*(?:ZileCirculatie|Zile|Days|Circula)\s*>\s*([^<]+)\s*<\//i);

    const fromM =
      attrs.match(/(?:dataStart|DataStart|from|validFrom|deLa|dataInceput)="([^"]+)"/i) ||
      body.match(/<\s*(?:DataInceput|ValidFrom|DeLa|From)\s*>\s*([^<]+)\s*<\//i);

    const toM =
      attrs.match(/(?:dataEnd|DataEnd|to|validTo|panaLa|dataSfarsit)="([^"]+)"/i) ||
      body.match(/<\s*(?:DataSfarsit|ValidTo|PanaLa|To)\s*>\s*([^<]+)\s*<\//i);

    const number   = (numM[1] || numM[0] || '').toString().trim();
    const type     = tipM ? (tipM[1] || '').toString().trim() : '';
    const operator = opM  ? (opM[1]  || '').toString().trim()  : defaultOperator;

    const daysRaw  = daysM ? (daysM[1] || '').toString().trim() : '';
    const daysMask = daysToMask(daysRaw);

    const validFrom = fromM ? parseDateDMY((fromM[1]||'').toString().trim()) : null;
    const validTo   = toM   ? parseDateDMY((toM[1]||'').toString().trim())   : null;

    // Parse station stops
    const stations = [];
    const stRe = /<(?:Statie|Station|statie)([^>]*)\/?>|<(?:Statie|Station|statie)([^>]*)>([\s\S]*?)<\/(?:Statie|Station|statie)>/gi;
    let sm;
    while ((sm = stRe.exec(body)) !== null) {
      const stAttrs = sm[1] || sm[2] || '';
      const nameM = stAttrs.match(/(?:nume|name|NumeStatie)="([^"]+)"/i) || (sm[3]||'').match(/<\s*(?:Nume|Name)\s*>\s*([^<]+)\s*<\//i);
      const arrM  = stAttrs.match(/(?:sosire|arr|arrival|Sosire)="([^"]+)"/i);
      const depM  = stAttrs.match(/(?:plecare|dep|departure|Plecare)="([^"]+)"/i);

      const name = nameM ? (nameM[1] || '').trim() : '';
      if (!name) continue;

      const arr = arrM ? arrM[1].trim() : '';
      const dep = depM ? depM[1].trim() : '';

      stations.push({
        name,
        arr: arr || null,
        dep: dep || null,
        arrMins: toMins(arr) ?? null,
        depMins: toMins(dep) ?? null,
      });
    }

    // Require at least 2 stations and times
    if (stations.length < 2) continue;

    result.push({
      id: `${operator}::${number}`, // stable key across sources
      number,
      type,
      operator,
      daysRaw,
      daysMask,
      validFrom,
      validTo,
      stations,
    });
  }

  return result;
}

// ─── BUILD INDEXES ─────────────────────────────────────────────────────────
function rebuildIndexes() {
  stationIndex.clear();
  for (const [id, t] of trains) {
    for (const st of t.stations) {
      const n = norm(st.name);
      if (!n) continue;
      if (!stationIndex.has(n)) stationIndex.set(n, new Set());
      stationIndex.get(n).add(id);
    }
  }
}

function trainLabel(t) {
  // e.g. "IR 1989"
  const n = (t.number || '').toString().trim();
  const typ = (t.type || '').toString().trim();
  const prefix = typ ? typ : '';
  return prefix ? `${prefix} ${n}`.trim() : n;
}

// Find direct legs between two stations for trains that run on date
function findDirect(fromNorm, toNorm, dateStr) {
  const result = [];
  const fromSet = stationIndex.get(fromNorm);
  const toSet   = stationIndex.get(toNorm);
  if (!fromSet || !toSet) return result;

  // intersect train sets
  for (const id of fromSet) {
    if (!toSet.has(id)) continue;
    const t = trains.get(id);
    if (!t) continue;
    if (!runsOn(t, dateStr)) continue;

    const fi = t.stations.findIndex(s => norm(s.name) === fromNorm);
    const ti = t.stations.findIndex(s => norm(s.name) === toNorm);
    if (fi < 0 || ti < 0 || ti <= fi) continue;

    const fromStop = t.stations[fi];
    const toStop   = t.stations[ti];

    // departure can be dep or arr if dep missing (some feeds)
    const depMins = fromStop.depMins ?? fromStop.arrMins;
    const arrMins = toStop.arrMins ?? toStop.depMins;
    if (depMins == null || arrMins == null) continue;

    const durMins = arrMins - depMins;
    if (durMins <= 0 || durMins > 24*60) continue;

    result.push({
      trainId: id,
      trainNo: t.number,
      trainType: t.type,
      operator: t.operator,
      trainLabel: trainLabel(t),
      from: fromStop.name,
      to: toStop.name,
      dep: fromStop.dep || fromStop.arr,
      arr: toStop.arr || toStop.dep,
      depMins,
      arrMins,
      durMins,
      leg: {
        trainNo: t.number,
        type: t.type,
        operator: t.operator,
        from: fromStop.name,
        to: toStop.name,
        dep: fromStop.dep || fromStop.arr,
        arr: toStop.arr || toStop.dep,
        depMins,
        arrMins,
      }
    });
  }

  // Sort by departure time
  result.sort((a,b) => a.depMins - b.depMins);
  return result;
}

function searchJourneys(fromName, toName, opts) {
  const { date, time, directOnly=false, limit=300 } = opts || {};
  const fromNorm = norm(fromName);
  const toNorm   = norm(toName);
  const targetMins = time ? (toMins(time) ?? 0) : 0;

  const journeys = [];

  // Direct trains
  const directs = findDirect(fromNorm, toNorm, date);
  for (const d of directs) {
    journeys.push({
      dep: d.dep, arr: d.arr,
      duration: durStr(d.durMins),
      durationMins: d.durMins,
      trains: [d.trainLabel],
      changes: 0,
      legs: [d.leg],
    });
  }

  if (!directOnly) {
    // One change (limited for performance)
    const fromTrains = stationIndex.get(fromNorm) || new Set();
    const toTrains   = stationIndex.get(toNorm)   || new Set();

    const viaCandidates = new Set();
    for (const id of fromTrains) {
      const train = trains.get(id);
      if (!train) continue;
      if (!runsOn(train, date)) continue;
      const fi = train.stations.findIndex(s => norm(s.name) === fromNorm);
      if (fi < 0) continue;
      train.stations.slice(fi+1).forEach(s => {
        const n2 = norm(s.name);
        if (!n2) return;
        const set2 = stationIndex.get(n2);
        if (!set2) return;
        for (const id2 of set2) {
          if (!toTrains.has(id2)) continue;
          const t2 = trains.get(id2);
          if (!t2) continue;
          if (!runsOn(t2, date)) continue;
          viaCandidates.add(n2);
          break;
        }
      });
    }

    for (const via of [...viaCandidates].slice(0, 10)) {
      const leg1s = findDirect(fromNorm, via, date);
      const leg2s = findDirect(via, toNorm, date);

      for (const l1 of leg1s.slice(0, 12)) {
        for (const l2 of leg2s.slice(0, 12)) {
          const wait = l2.depMins - l1.arrMins;
          if (wait < 5 || wait > 180) continue;
          const durM = l2.arrMins - l1.depMins;
          if (durM < 0 || durM > 24*60) continue;

          journeys.push({
            dep: l1.dep, arr: l2.arr,
            duration: durStr(durM),
            durationMins: durM,
            trains: [l1.trainLabel, l2.trainLabel],
            changes: 1,
            waitMins: wait,
            viaStation: l1.leg.to,
            legs: [l1.leg, l2.leg],
          });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  const unique = journeys.filter(j => {
    const k = `${j.dep}|${j.arr}|${j.trains.join('+')}|${j.changes||0}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Sort: upcoming after requested time first (by dep), then the rest
  unique.sort((a,b) => (toMins(a.dep)||0) - (toMins(b.dep)||0));
  const upcoming = unique.filter(j => (toMins(j.dep)||0) >= targetMins);
  const past = unique.filter(j => (toMins(j.dep)||0) < targetMins);

  const ordered = [...upcoming, ...past];

  return ordered.slice(0, Math.max(1, Math.min(500, limit)));
}

// ─── LOAD DATA ─────────────────────────────────────────────────────────────
async function loadAll() {
  dataLoaded = false;
  lastLoadError = null;
  lastDownloadedBytes = 0;

  trains.clear();

  try {
    for (const src of TIMETABLE_URLS) {
      const buf = await getUrl(src.url);
      lastDownloadedBytes += buf.length;
      const xml = buf.toString('utf8');

      const parsed = parseCFRXml(xml, src.operator);
      for (const t of parsed) {
        // If duplicates across sources, keep the one with more stations
        const existing = trains.get(t.id);
        if (!existing || (t.stations.length > existing.stations.length)) {
          trains.set(t.id, t);
        }
      }
    }

    rebuildIndexes();
    dataLoaded = true;
    lastLoadAt = new Date().toISOString();
  } catch (e) {
    lastLoadError = String(e && e.message ? e.message : e);
    dataLoaded = false;
  }
}

// initial load + periodic refresh
loadAll();
setInterval(loadAll, 6 * 60 * 60 * 1000); // every 6 hours

// ─── ROUTES ────────────────────────────────────────────────────────────────
app.get('/', (req,res) => res.json({
  name: 'Velox API',
  version: '3.1.0',
  status: dataLoaded ? 'ready' : 'loading',
  trains: trains.size,
  stations: stationIndex.size,
  endpoints: {
    health:       'GET /health',
    stations:     'GET /api/stations?q=Brasov',
    itineraries:  'GET /api/itineraries?from=Bucuresti%20Nord&to=Constanta&date=25.02.2026&time=08:00&limit=200',
    trainInfo:    'GET /api/train/:number?date=25.02.2026',
    stationBoard: 'GET /api/board/:stationName?date=25.02.2026',
  }
}));

app.get('/health', (req,res) => res.json({
  status: 'ok',
  trains: trains.size,
  stations: stationIndex.size,
  lastLoadAt,
  lastLoadError,
  timetableUrlsConfigured: TIMETABLE_URLS.length,
  lastDownloadedBytes,
  time: new Date().toISOString(),
}));

// Stations autocomplete
app.get('/api/stations', (req,res) => {
  const q = norm(req.query.q || '');
  if (!q || q.length < 2) return res.json({ stations: [] });

  const out = [];
  for (const stNorm of stationIndex.keys()) {
    if (stNorm.includes(q)) {
      out.push(stNorm);
      if (out.length >= 30) break;
    }
  }
  // Return display-ish names (best effort: title-case from norm)
  res.json({ stations: out.map(s => s.split(' ').map(w => w ? (w[0].toUpperCase()+w.slice(1)) : '').join(' ')) });
});

// Itineraries search
app.get('/api/itineraries', (req,res) => {
  const from = req.query.from;
  const to   = req.query.to;
  const date = req.query.date;  // "DD.MM.YYYY"
  const time = req.query.time;  // "HH:MM"

  const directOnly = String(req.query.directOnly||'').toLowerCase()==='true';
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit||'200',10) || 200));

  if (!from || !to) return res.status(400).json({ error: 'Missing from/to' });

  const journeys = searchJourneys(from, to, { date, time, directOnly, limit });

  res.json({
    from, to, date: date || null, time: time || null,
    count: journeys.length,
    journeys
  });
});

// Train details: supports date filtering
app.get('/api/train/:number', (req,res) => {
  const num = String(req.params.number || '').trim();
  const date = req.query.date || null;

  // Find all trains matching number (across operators)
  const matches = [];
  for (const t of trains.values()) {
    if (String(t.number).trim() === num) {
      if (!runsOn(t, date)) continue;
      matches.push(t);
    }
  }

  if (!matches.length) {
    return res.status(404).json({ error: 'Train not found (or not running on this date)', number: num, date });
  }

  // Prefer the one with the most stations
  matches.sort((a,b) => b.stations.length - a.stations.length);
  const t = matches[0];

  res.json({
    number: t.number,
    type: t.type,
    operator: t.operator,
    days: t.daysRaw || null,
    validFrom: t.validFrom ? t.validFrom.toISOString().slice(0,10) : null,
    validTo: t.validTo ? t.validTo.toISOString().slice(0,10) : null,
    stations: t.stations.map(s => ({ name: s.name, arr: s.arr, dep: s.dep })),
  });
});

// Simple station board: all trains that stop here, ordered by departure time
app.get('/api/board/:stationName', (req,res) => {
  const stationName = req.params.stationName;
  const date = req.query.date || null;

  const stNorm = norm(stationName);
  const set = stationIndex.get(stNorm);
  if (!set) return res.json({ station: stationName, date, departures: [] });

  const deps = [];
  for (const id of set) {
    const t = trains.get(id);
    if (!t) continue;
    if (!runsOn(t, date)) continue;
    const idx = t.stations.findIndex(s => norm(s.name) === stNorm);
    if (idx < 0) continue;
    const stop = t.stations[idx];
    const depM = stop.depMins ?? stop.arrMins;
    if (depM == null) continue;

    deps.push({
      trainNo: t.number,
      type: t.type,
      operator: t.operator,
      dep: stop.dep || stop.arr,
      direction: t.stations[t.stations.length-1]?.name || null,
    });
  }

  deps.sort((a,b) => (toMins(a.dep)||0) - (toMins(b.dep)||0));
  res.json({ station: stationName, date, departures: deps });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Velox backend running on port ${PORT}`));
