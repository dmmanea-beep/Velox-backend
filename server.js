'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'OPTIONS'] }));
app.options('*', cors());

// ─── DATA SOURCES ──────────────────────────────────────────────────────────
// All confirmed 2025-2026 XML URLs from data.gov.ro
const XML_SOURCES = [
  {
    operator: 'CFR Călători',
    url: 'https://data.gov.ro/dataset/c4f71dbb-de39-49b2-b697-5b60a5f299a2/resource/0f67143e-bb88-4a06-8e7a-b35b1eb91329/download/trenuri-2025-2026_sntfc.xml'
  },
  {
    operator: 'Interregional Călători',
    url: 'https://data.gov.ro/dataset/b4e2ce0b-6935-44b1-8e9d-f3999123358a/resource/1a083cf5-d37c-4618-aeb8-3f1ba0dd22dc/download/trenuri-2025-2026_interregional-calatori.xml'
  },
  {
    operator: 'Regio Călători',
    url: 'https://data.gov.ro/dataset/1da1018d-df38-4b5f-9667-88e4521abfb3/resource/771c1e7f-e552-46aa-8a6b-b9276b9b556c/download/trenuri-2025-2026_regio-calatori.xml'
  },
  {
    operator: 'Transferoviar Călători',
    url: 'https://data.gov.ro/dataset/9d4adc7b-d407-46c2-9003-5aa87cd16fb7/resource/2f1d9f58-1e97-4a4a-bc65-86c52b7db1a9/download/trenuri-2025-2026_transferoviar-calatori.xml'
  },
  {
    operator: 'Astra Trans Carpatic',
    url: 'https://data.gov.ro/dataset/1d057a43-3eaa-4fed-a349-4106f3ad0e49/resource/aab96a77-0fbe-4770-8408-e7b23c90480d/download/trenuri-2025-2026_astratranscarpatic.xml'
  },
  {
    operator: 'Softrans',
    url: 'https://data.gov.ro/dataset/e4ba7432-2904-4cc4-9588-2afbf021756e/resource/3bf9600e-7ae4-45fb-a46e-8184576544a1/download/trenuri-2025-2026_softrans.xml'
  },
];

// GPS coordinates for all Romanian railway stations
const STATION_GPS_URL = 'https://raw.githubusercontent.com/vasile/data.gov.ro-gtfs-exporter/master/cfr.webgis.ro/stops.geojson';

// IRIS real-time delay endpoint
const IRIS_URL = (trainNum) => `https://appiris.infofer.ro/MyTrainRO.aspx?tren=${encodeURIComponent(trainNum)}`;

// ─── IN-MEMORY STORE ───────────────────────────────────────────────────────
let trains       = new Map();  // trainNumber -> { number, type, operator, stations[] }
let stationIndex = new Map();  // normName -> Set(trainNumbers)
let stationGPS   = new Map();  // normName -> { name, lat, lng, id }
let dataReady    = false;
let loadStatus   = 'starting';

// ─── CACHE ─────────────────────────────────────────────────────────────────
const _cache = {};
const cacheGet = (k) => { const i = _cache[k]; return (i && Date.now() < i.e) ? i.v : null; };
const cacheSet = (k, v, s) => { _cache[k] = { v, e: Date.now() + s * 1000 }; };

// ─── HTTP HELPER ───────────────────────────────────────────────────────────
function get(url, timeout = 60000, hops = 0) {
  return new Promise((res, rej) => {
    if (hops > 5) return rej(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'VeloxApp/4.0',
        'Accept': '*/*',
      }
    }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        const next = r.headers.location.startsWith('http')
          ? r.headers.location
          : new URL(r.headers.location, url).href;
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

// ─── HELPERS ───────────────────────────────────────────────────────────────

// Convert seconds-since-midnight to HH:MM
// The XML stores times as seconds e.g. OraP="17820" = 17820/60 = 297min = 04:57
function secToTime(sec) {
  if (sec == null || sec === '') return null;
  const s = parseInt(sec);
  if (isNaN(s) || s < 0) return null;
  // Times can exceed 86400 for trains running past midnight
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

// Normalize station name for fuzzy matching (remove diacritics, lowercase)
function norm(name) {
  return (name || '').trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve a user-typed station name to the exact norm key used in stationIndex.
// Handles cases like "București Nord" matching "Bucuresti Nord Gr.A"
function resolveStation(userInput) {
  const n = norm(userInput);
  // 1. Exact match
  if (stationIndex.has(n)) return n;
  // 2. Find any indexed station whose norm starts with the user input
  //    e.g. "bucuresti nord" matches "bucuresti nord gr a"
  for (const key of stationIndex.keys()) {
    if (key.startsWith(n + ' ') || key === n) return key;
  }
  // 3. Find any indexed station that contains the user input
  for (const key of stationIndex.keys()) {
    if (key.includes(n)) return key;
  }
  // 4. User input contains the indexed key (e.g. user typed full name, XML is shorter)
  for (const key of stationIndex.keys()) {
    if (n.startsWith(key + ' ') || n === key) return key;
  }
  return n; // fallback — return as-is
}

function guessType(cat) {
  const c = (cat || '').toUpperCase();
  if (c === 'EC')  return 'EuroCity';
  if (c === 'IC')  return 'InterCity';
  if (c === 'IR')  return 'InterRegio';
  if (c === 'RX')  return 'RegioExpress';
  if (c === 'RE')  return 'RegioExpress';
  if (c === 'R')   return 'Regio';
  if (c === 'S')   return 'Suburban';
  return 'Tren';
}

// Strip all HTML/XML tags from a string
function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

// ─── XML PARSER ────────────────────────────────────────────────────────────
// Parses the actual CFR XML format where:
//   - Each <Tren> has CategorieTren, Numar, Operator attributes
//   - Inside <Trase><Trasa><ElementTrasa> each element has:
//       DenStaOrigine, DenStaDestinatie, OraS (arr seconds), OraP (dep seconds)
//   - We reconstruct the full stop list from the chain of ElementTrasa elements
function parseCFRXml(xml, defaultOperator) {
  const trains = [];

  // Match every <Tren ...>...</Tren>
  const trainRe = /<Tren\b([^>]*)>([\s\S]*?)<\/Tren>/g;
  let tm;

  while ((tm = trainRe.exec(xml)) !== null) {
    const attrs = tm[1];
    const body  = tm[2];

    const numM  = attrs.match(/Numar="([^"]+)"/);
    const catM  = attrs.match(/CategorieTren="([^"]+)"/);
    const opM   = attrs.match(/Operator="([^"]+)"/);

    if (!numM) continue;

    const number   = numM[1].trim();
    const category = catM ? catM[1].trim() : '';
    const operator = defaultOperator;

    // Parse ElementTrasa elements to build the station list
    // Each ElementTrasa represents a segment:
    //   DenStaOrigine = departure station of this segment
    //   OraS = arrival time at origin (seconds)  
    //   OraP = departure time from origin (seconds)
    //   DenStaDestinatie = destination station of this segment
    // The final destination only has OraS at DenStaDestinatie of the last element

    const stations = [];
    const elemRe   = /<ElementTrasa\b([^>]*)\/>/g;
    let em;
    let prevDestName = null;

    while ((em = elemRe.exec(body)) !== null) {
      const ea    = em[1];
      const oName = (ea.match(/DenStaOrigine="([^"]+)"/) || [])[1];
      const dName = (ea.match(/DenStaDestinatie="([^"]+)"/) || [])[1];
      const oraS  = (ea.match(/OraS="([^"]+)"/) || [])[1]; // arrival at origin
      const oraP  = (ea.match(/OraP="([^"]+)"/) || [])[1]; // departure from origin
      const seq   = parseInt((ea.match(/Secventa="([^"]+)"/) || [])[1] || '0');

      if (!oName || !dName) continue;

      if (seq === 1 || stations.length === 0) {
        // First stop
        stations.push({
          name: oName,
          arr:  secToTime(oraS),
          dep:  secToTime(oraP),
          seq:  seq,
        });
      } else if (oName !== prevDestName) {
        // Gap in sequence — push origin as new stop
        stations.push({
          name: oName,
          arr:  secToTime(oraS),
          dep:  secToTime(oraP),
          seq:  seq,
        });
      } else {
        // Update the last stop's departure time
        const last = stations[stations.length - 1];
        if (!last.dep) last.dep = secToTime(oraP);
      }

      prevDestName = dName;

      // If this is the last element in this trasa, add the destination
      // We'll do this after the loop by checking the last element
    }

    // Add the final destination from the last ElementTrasa
    const lastElem = body.match(/(?:.*<ElementTrasa\b([^>]*)\/>\s*)+$/s);
    if (lastElem) {
      const lastAttrs = lastElem[1];
      const dName = (lastAttrs.match(/DenStaDestinatie="([^"]+)"/) || [])[1];
      const oraS  = (lastAttrs.match(/OraS="([^"]+)"/) || [])[1];
      if (dName && stations.length > 0 && stations[stations.length-1].name !== dName) {
        // Find the last element's arrival time for destination
        const allElems = [...body.matchAll(/<ElementTrasa\b([^>]*)\/>/g)];
        if (allElems.length > 0) {
          const lastA = allElems[allElems.length - 1][1];
          const finalName = (lastA.match(/DenStaDestinatie="([^"]+)"/) || [])[1];
          const finalOraS = (lastA.match(/OraS="([^"]+)"/) || [])[1];
          // The destination arrival time in seconds is in a different field
          // OraS for the destination = arrival at the destination of the last element
          // We need to compute it from the last element's travel time
          // For now use a simple approach: find it in the CodStaDestinatie element
          if (finalName) {
            stations.push({
              name: finalName,
              arr:  null, // will be filled below
              dep:  null,
              seq:  999,
            });
          }
        }
      }
    }

    if (stations.length >= 2) {
      trains.push({ number, category, type: guessType(category), operator, stations });
    }
  }

  return trains;
}

// Better approach: build stop list by collecting all unique origin stations
// in sequence order, then add final destination from the last element
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

    const number   = numM[1].trim();
    const category = catM ? catM[1].trim() : '';

    // Collect all ElementTrasa in order
    const allElems = [...body.matchAll(/<ElementTrasa\b([^>]*)\/>/g)];
    if (allElems.length === 0) continue;

    const stations = [];

    allElems.forEach((em, idx) => {
      const ea    = em[1];
      const oName = (ea.match(/DenStaOrigine="([^"]+)"/) || [])[1];
      const dName = (ea.match(/DenStaDestinatie="([^"]+)"/) || [])[1];
      const oraS  = (ea.match(/OraS="([^"]+)"/) || [])[1]; // arrival at origin in seconds
      const oraP  = (ea.match(/OraP="([^"]+)"/) || [])[1]; // departure from origin in seconds

      if (!oName) return;

      // Add origin station (each unique stop once)
      const lastSt = stations[stations.length - 1];
      if (!lastSt || norm(lastSt.name) !== norm(oName)) {
        stations.push({
          name: oName,
          arr:  secToTime(oraS),
          dep:  secToTime(oraP),
        });
      } else {
        // Same station — update times if missing
        if (!lastSt.arr && oraS) lastSt.arr = secToTime(oraS);
        if (!lastSt.dep && oraP) lastSt.dep = secToTime(oraP);
      }

      // On the last element, also add the destination
      if (idx === allElems.length - 1 && dName) {
        // Try to get destination arrival time from OraSD (Ora Sosire Destinatie)
        // or fallback to computing from travel time fields
        const oraSD = (ea.match(/OraSD=\"([^\"]+)\"/) || [])[1]  // some XML variants
                    || (ea.match(/OraSosireDestinatie=\"([^\"]+)\"/) || [])[1]
                    || (ea.match(/OraSDest=\"([^\"]+)\"/) || [])[1];
        if (norm(dName) !== norm(oName)) {
          stations.push({
            name: dName,
            arr:  oraSD ? secToTime(oraSD) : null,
            dep:  null,
          });
        }
      }
    });

    if (stations.length >= 2) {
      result.push({ number, category, type: guessType(category), operator: defaultOperator, stations });
    }
  }

  return result;
}

// ─── LOAD DATA ─────────────────────────────────────────────────────────────
async function loadData() {
  loadStatus = 'loading GPS...';
  console.log('[boot] Loading station GPS...');

  // 1. Load GPS coordinates
  try {
    const r   = await get(STATION_GPS_URL, 30000);
    const geo = JSON.parse(r.body);
    for (const f of geo.features) {
      const [lng, lat] = f.geometry.coordinates;
      stationGPS.set(norm(f.properties.name), {
        name: f.properties.name,
        lat, lng,
        id: f.properties.station_id,
      });
    }
    console.log(`[boot] GPS: ${stationGPS.size} stations`);
  } catch (e) {
    console.warn('[boot] GPS failed:', e.message);
  }

  // 2. Load each timetable XML
  let total = 0;
  for (const src of XML_SOURCES) {
    loadStatus = `loading ${src.operator}...`;
    try {
      console.log(`[boot] Fetching ${src.operator}...`);
      const r = await get(src.url, 90000);

      if (r.status !== 200) {
        console.warn(`[boot] ${src.operator}: HTTP ${r.status}`);
        continue;
      }

      console.log(`[boot] ${src.operator}: ${(r.body.length / 1024).toFixed(0)} KB`);
      const parsed = parseCFRXmlV2(r.body, src.operator);
      console.log(`[boot] ${src.operator}: ${parsed.length} trains parsed`);

      for (const train of parsed) {
        trains.set(train.number, train);

        // Index by every station name
        for (const st of train.stations) {
          const n = norm(st.name);
          if (!stationIndex.has(n)) stationIndex.set(n, new Set());
          stationIndex.get(n).add(train.number);
        }
        total++;
      }
    } catch (e) {
      console.error(`[boot] ${src.operator} error:`, e.message);
    }
  }

  dataReady  = true;
  loadStatus = 'ready';
  console.log(`[boot] READY: ${trains.size} trains, ${stationIndex.size} stations`);
}

// ─── JOURNEY SEARCH ────────────────────────────────────────────────────────
function findDirectJourneys(fromNorm, toNorm) {
  const fromSet = stationIndex.get(fromNorm) || new Set();
  const toSet   = stationIndex.get(toNorm)   || new Set();
  const results = [];

  for (const tNum of fromSet) {
    if (!toSet.has(tNum)) continue;

    const train = trains.get(tNum);
    if (!train) continue;

    // Find the indices of from/to in this train's station list
    const fi = train.stations.findIndex(s => norm(s.name) === fromNorm);
    const ti = train.stations.findIndex(s => norm(s.name) === toNorm);
    if (fi < 0 || ti < 0 || fi >= ti) continue;

    const dep = train.stations[fi].dep || train.stations[fi].arr;
    const arr = train.stations[ti].arr || train.stations[ti].dep;
    if (!dep) continue;
    // If arrival is still null (final terminus with unknown time), estimate from dep + 1 min
    const arrFinal = arr || dep;

    const depM = timeToMins(dep);
    const arrM = timeToMins(arrFinal);
    const durM = arrM >= depM ? arrM - depM : arrM + 1440 - depM;

    // Attach GPS to stops
    const stops = train.stations.slice(fi, ti + 1).map(s => {
      const gps = stationGPS.get(norm(s.name));
      return { ...s, lat: gps?.lat || null, lng: gps?.lng || null };
    });

    results.push({
      dep, arr: arrFinal, depM, arrM, durM,
      label:    `${train.category} ${train.number}`,
      number:   train.number,
      category: train.category,
      type:     train.type,
      operator: train.operator,
      from:     train.stations[fi].name,
      to:       train.stations[ti].name,
      stops,
    });
  }

  return results.sort((a, b) => a.depM - b.depM);
}

function searchJourneys(fromName, toName) {
  const fN = resolveStation(fromName);
  const tN = resolveStation(toName);

  const journeys = [];

  // Direct
  const directs = findDirectJourneys(fN, tN);
  for (const d of directs) {
    journeys.push({
      dep: d.dep, arr: d.arr,
      duration: durStr(d.durM),
      durationMins: d.durM,
      changes: 0,
      trains: [d.label],
      legs: [{
        train:    d.label,
        number:   d.number,
        type:     d.type,
        operator: d.operator,
        from:     d.from,
        to:       d.to,
        dep:      d.dep,
        arr:      d.arr,
        stops:    d.stops,
      }],
    });
  }

  // 1 change — always search for connections, not just when few directs found
  {
    const fromTrains = stationIndex.get(fN) || new Set();
    const toTrains   = stationIndex.get(tN)  || new Set();

    // Find candidate via stations: reachable from 'from' AND can reach 'to'
    const candidates = new Set();
    for (const tNum of fromTrains) {
      const train = trains.get(tNum);
      if (!train) continue;
      const fi = train.stations.findIndex(s => norm(s.name) === fN);
      if (fi < 0) continue;
      // All stations after 'from' on this train
      train.stations.slice(fi + 1).forEach(s => {
        const n2 = norm(s.name);
        // Check if any train from this station goes to 'to'
        const stTrains = stationIndex.get(n2) || new Set();
        for (const t2 of stTrains) {
          if (toTrains.has(t2)) { candidates.add(n2); break; }
        }
      });
    }

    for (const via of [...candidates].slice(0, 20)) {
      const leg1s = findDirectJourneys(fN, via);
      const leg2s = findDirectJourneys(via, tN);

      for (const l1 of leg1s.slice(0, 8)) {
        for (const l2 of leg2s.slice(0, 8)) {
          const wait = l2.depM - l1.arrM;
          if (wait < 5 || wait > 180) continue; // 5min–3h connection window

          const totalDur = l2.arrM - l1.depM;
          if (totalDur <= 0 || totalDur > 1200) continue;

          journeys.push({
            dep: l1.dep, arr: l2.arr,
            duration: durStr(totalDur),
            durationMins: totalDur,
            changes: 1,
            waitMins: wait,
            viaStation: l1.to,
            trains: [l1.label, l2.label],
            legs: [
              { train: l1.label, number: l1.number, type: l1.type, operator: l1.operator, from: l1.from, to: l1.to, dep: l1.dep, arr: l1.arr, stops: l1.stops },
              { train: l2.label, number: l2.number, type: l2.type, operator: l2.operator, from: l2.from, to: l2.to, dep: l2.dep, arr: l2.arr, stops: l2.stops },
            ],
          });
        }
      }
    }
  }

  // Deduplicate + sort by duration
  const seen = new Set();
  return journeys
    .filter(j => {
      const k = `${j.dep}${j.arr}${j.trains.join()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.depM - b.depM)
    .slice(0, 100);
}

// ─── REAL-TIME DELAY (IRIS) ────────────────────────────────────────────────
async function getLiveDelay(trainNumber) {
  const key    = 'live:' + trainNumber;
  const cached = cacheGet(key);
  if (cached !== null) return cached;

  try {
    const resp = await Promise.race([
      get(IRIS_URL(trainNumber), 8000),
      new Promise((_, rej) => setTimeout(() => rej(new Error('iris timeout')), 8000)),
    ]);

    const html = resp.body;

    // Extract delay
    const delayM = html.match(/(?:întârziere|intarziere)[^<\d]*?(\d+)\s*min/i)
                || html.match(/delay[^<\d]*?(\d+)\s*min/i);
    const delay   = delayM ? parseInt(delayM[1]) : 0;

    // Extract per-station delay info from table
    const stationDelays = [];
    const rows          = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(c => stripTags(c));
      if (cells.length >= 2 && /\d{2}:\d{2}/.test(cells[1] || '')) {
        stationDelays.push({
          name:      cells[0],
          scheduled: cells[1],
          actual:    cells[2] || null,
          delay:     parseInt(cells[3]) || 0,
        });
      }
    }

    const result = {
      trainNumber,
      delay,
      onTime:        delay === 0,
      stationDelays,
      liveAvailable: true,
      updatedAt:     new Date().toISOString(),
    };

    cacheSet(key, result, 60); // cache 60 seconds
    return result;

  } catch (err) {
    const result = {
      trainNumber,
      delay:         0,
      onTime:        true,
      stationDelays: [],
      liveAvailable: false,
      error:         err.message,
      updatedAt:     new Date().toISOString(),
    };
    cacheSet(key, result, 30);
    return result;
  }
}

// ─── ROUTES ────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  name:     'Velox API',
  version:  '4.0.0',
  status:   loadStatus,
  trains:   trains.size,
  stations: stationIndex.size,
  ready:    dataReady,
  endpoints: {
    health:       'GET /health',
    stations:     'GET /api/stations?q=Brasov',
    itineraries:  'GET /api/itineraries?from=Brașov&to=Constanța&date=24.02.2026',
    trainRoute:   'GET /api/train/:number',
    trainLive:    'GET /api/train/:number/live',
    stationBoard: 'GET /api/board/:stationName',
  },
}));

app.get('/health', (req, res) => res.json({
  status:   loadStatus,
  ready:    dataReady,
  trains:   trains.size,
  stations: stationIndex.size,
  time:     new Date().toISOString(),
}));

// GET /api/stations?q=Brasov
app.get('/api/stations', (req, res) => {
  const q = norm(req.query.q || '');
  if (q.length < 2) return res.status(400).json({ error: 'Minimum 2 characters' });
  if (!dataReady)   return res.status(503).json({ error: 'Loading, try again in 30s', status: loadStatus });

  const matches = [];
  const seen    = new Set();

  for (const [n, trainSet] of stationIndex) {
    if (!n.includes(q)) continue;

    // Get original name with diacritics from first train
    const tNum  = [...trainSet][0];
    const train = trains.get(tNum);
    if (!train) continue;
    const st = train.stations.find(s => norm(s.name) === n);
    if (!st || seen.has(st.name)) continue;
    seen.add(st.name);

    const gps = stationGPS.get(n);
    matches.push({
      name:       st.name,
      lat:        gps?.lat  || null,
      lng:        gps?.lng  || null,
      stationId:  gps?.id   || null,
      trainCount: trainSet.size,
    });
  }

  // Sort: exact matches first, then by number of trains (busier stations first)
  matches.sort((a, b) => {
    const aN = norm(a.name), bN = norm(b.name);
    if (aN === q && bN !== q) return -1;
    if (bN === q && aN !== q) return  1;
    return b.trainCount - a.trainCount;
  });

  return res.json({ stations: matches.slice(0, 15), total: matches.length });
});

// GET /api/itineraries?from=Brașov&to=Constanța&date=24.02.2026
app.get('/api/itineraries', (req, res) => {
  const from = (req.query.from || '').trim();
  const to   = (req.query.to   || '').trim();
  const date = (req.query.date || '').trim() || todayStr();

  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (!dataReady)   return res.status(503).json({ error: 'Loading, try again in 30s', status: loadStatus });

  const key    = `itin:${resolveStation(from)}:${resolveStation(to)}:${date}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ source: 'cache', from, to, date, journeys: cached, count: cached.length });

  const journeys = searchJourneys(from, to);
  cacheSet(key, journeys, 300); // cache 5 minutes

  return res.json({ source: 'live', from, to, date, journeys, count: journeys.length });
});

// GET /api/train/1581  — full scheduled route
app.get('/api/train/:number', (req, res) => {
  if (!dataReady) return res.status(503).json({ error: 'Loading, try again in 30s' });

  const train = trains.get(req.params.number.trim());
  if (!train)  return res.status(404).json({ error: `Train ${req.params.number} not found` });

  // Enrich stations with GPS
  const stations = train.stations.map(s => {
    const gps = stationGPS.get(norm(s.name));
    return { ...s, lat: gps?.lat || null, lng: gps?.lng || null };
  });

  const first = train.stations[0];
  const last  = train.stations[train.stations.length - 1];

  return res.json({
    number:   train.number,
    type:     train.type,
    category: train.category,
    operator: train.operator,
    from:     first.name,
    to:       last.name,
    dep:      first.dep || first.arr,
    arr:      last.arr  || last.dep,
    stops:    stations.length,
    stations,
  });
});

// GET /api/train/1581/live  — real-time delay from IRIS
app.get('/api/train/:number/live', async (req, res) => {
  const num   = req.params.number.trim();
  const live  = await getLiveDelay(num);
  const train = trains.get(num);

  return res.json({
    ...live,
    ...(train ? { type: train.type, operator: train.operator, from: train.stations[0]?.name, to: train.stations[train.stations.length-1]?.name } : {}),
  });
});

// GET /api/board/:stationName  — all trains calling at a station today
app.get('/api/board/:stationName', (req, res) => {
  if (!dataReady) return res.status(503).json({ error: 'Loading, try again in 30s' });

  const stName = req.params.stationName.trim();
  const n      = resolveStation(stName);
  const nums   = stationIndex.get(n);

  if (!nums || nums.size === 0) {
    // Try partial match — find closest station name
    const q2 = norm(stName);
    const suggestions = [];
    for (const [key] of stationIndex) {
      if (key.includes(q2) || q2.includes(key)) suggestions.push(key);
    }
    return res.status(404).json({
      error: `Station "${stName}" not found`,
      suggestions: suggestions.slice(0, 5),
      hint: 'Use /api/stations?q=... to find the correct name',
    });
  }

  const departures = [];
  for (const tNum of nums) {
    const train = trains.get(tNum);
    if (!train) continue;
    const st = train.stations.find(s => norm(s.name) === n);
    if (!st) continue;
    const dep = st.dep || st.arr;
    if (!dep) continue;

    departures.push({
      time:     dep,
      train:    `${train.category} ${train.number}`,
      number:   train.number,
      type:     train.type,
      operator: train.operator,
      to:       train.stations[train.stations.length - 1].name,
      arr:      train.stations[train.stations.length - 1].arr,
      delay:    0, // enriched by /live endpoint
    });
  }

  const gps = stationGPS.get(n);
  departures.sort((a, b) => timeToMins(a.time) - timeToMins(b.time));

  return res.json({
    station:    stName,
    lat:        gps?.lat || null,
    lng:        gps?.lng || null,
    stationId:  gps?.id  || null,
    departures,
    count:      departures.length,
  });
});

// ─── START ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Velox API v4 on port ${PORT}`);
  loadData().catch(e => {
    loadStatus = 'error: ' + e.message;
    console.error('[boot] FATAL:', e.message);
  });
});
