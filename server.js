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
  // NOTE: Softrans XML removed — their data.gov.ro file contains wrong train numbers
  // (shows IR 1683 etc. which are CFR Călători numbers). Softrans real trains are
  // in the 11xxx range and run Craiova-Brasov-Bucuresti, not Bucuresti-Constanta.
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

// ─── HTTP POST HELPER ──────────────────────────────────────────────────────
function post(url, formData, timeout = 12000) {
  return new Promise((res, rej) => {
    const body = Object.entries(formData)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');
    const u = new URL(url);
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (url.startsWith('https') ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro-RO,ro;q=0.9',
        'Referer': url,
      },
    }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', rej);
    req.setTimeout(timeout, () => { req.destroy(); rej(new Error('POST timeout')); });
    req.write(body);
    req.end();
  });
}

// Scrape IRIS SosPlcRO.aspx for today's REAL departures at a station.
// This is the authoritative source - only trains actually running today appear here.
async function getIRISStationBoard(stationName) {
  const cacheKey = 'iris_board:' + norm(stationName) + ':' + todayStr();
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const IRIS_STA = 'http://appiris.infofer.ro/SosPlcRO.aspx';
  try {
    // GET the form page first to extract ASP.NET hidden fields
    const page1 = await get(IRIS_STA, 10000);
    const html1 = page1.body || '';
    const vsM  = html1.match(/name="__VIEWSTATE"\s+[^>]*value="([^"]+)"/);
    const evM  = html1.match(/name="__EVENTVALIDATION"\s+[^>]*value="([^"]+)"/);
    const vsgM = html1.match(/name="__VIEWSTATEGENERATOR"\s+[^>]*value="([^"]+)"/);

    if (!vsM) {
      console.log('[IRIS-board] Could not extract VIEWSTATE');
      return null;
    }

    // POST with station + today's date
    const formData = {
      '__VIEWSTATE':           vsM[1],
      '__EVENTVALIDATION':     evM  ? evM[1]  : '',
      '__VIEWSTATEGENERATOR':  vsgM ? vsgM[1] : '',
      '__EVENTTARGET':         '',
      '__EVENTARGUMENT':       '',
      'ctl00$ContentPlaceHolder1$txtStatie': stationName,
      'ctl00$ContentPlaceHolder1$txtData':   todayStr(),
      'ctl00$ContentPlaceHolder1$btnCauta':  'Cauta',
    };

    const page2 = await post(IRIS_STA, formData, 12000);
    const html2 = page2.body || '';
    if (html2.length < 300) { console.log('[IRIS-board] Short response'); return null; }

    // Parse the departures table rows
    const departures = [];
    const rows = html2.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const row of rows) {
      const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map(c => stripTags(c).trim().replace(/\s+/g, ' '));
      if (cells.length < 3) continue;
      const timeM = (cells[0] || '').match(/(\d{2}:\d{2})/);
      if (!timeM) continue;
      const trainRaw = cells[1] || '';
      const numM = trainRaw.match(/(\d{3,5})/);
      const catM = trainRaw.match(/^([A-Za-z]{1,5})/);
      departures.push({
        time:     timeM[1],
        number:   numM ? numM[1] : '',
        category: catM ? catM[1].toUpperCase() : '',
        to:       cells[2] || '',
        delay:    parseInt((cells[4]||'').replace(/\D/g,''))||0,
        platform: (cells[5]||'').replace(/\D/g,'')||null,
      });
    }

    console.log('[IRIS-board]', stationName, ':', departures.length, 'trains');
    if (departures.length > 0) cacheSet(cacheKey, departures, 300);
    return departures.length > 0 ? departures : null;
  } catch (e) {
    console.error('[IRIS-board] Error:', e.message);
    return null;
  }
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

// Parse DD.MM.YYYY → JS Date object (noon, to avoid DST issues)
function parseRoDate(str) {
  if (!str) return null;
  const [d, m, y] = str.split('.').map(Number);
  if (!d || !m || !y) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}

// Return day-of-week index 0=Sun,1=Mon...6=Sat for a DD.MM.YYYY date string
function dateToDow(str) {
  const d = parseRoDate(str);
  return d ? d.getDay() : -1;
}

// ZileSaptamana in CFR XML is a string like "12345" meaning Mon–Fri,
// or "1234567" meaning daily. Each digit = day number: 1=Mon, 2=Tue … 7=Sun.
// Returns true if the given date (DD.MM.YYYY) falls on an operating day.
function trainRunsOnDate(train, dateStr) {
  if (!train.schedule || train.schedule.length === 0) return true; // no data = assume runs
  const dow = dateToDow(dateStr); // 0=Sun … 6=Sat
  // Convert JS dow (0=Sun) to CFR dow (1=Mon … 7=Sun)
  const cfrDow = dow === 0 ? 7 : dow; // Sun→7, Mon→1 … Sat→6

  const targetDate = parseRoDate(dateStr);

  for (const sch of train.schedule) {
    // Check date range
    if (sch.dateStart && sch.dateEnd) {
      const ds = parseRoDate(sch.dateStart);
      const de = parseRoDate(sch.dateEnd);
      if (targetDate && ds && de) {
        if (targetDate < ds || targetDate > de) continue; // outside this schedule's window
      }
    }
    // Check day of week bitmask
    if (sch.days && sch.days.length > 0) {
      if (sch.days.includes(String(cfrDow))) return true;
    } else {
      return true; // schedule exists but no day restriction = runs every day in range
    }
  }
  return false;
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
// in sequence order, then add final destination from the last element.
// Also extracts ZileSaptamana (days of week) and date range from <Trasa> elements.
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

    // ── Extract schedule (days of operation) ──────────────────────────────
    // Try multiple XML formats used by different Romanian operators:
    // Format A: <Trasa ZileSaptamana="12345" DataInceput="01.12.2025" DataSfarsit="14.06.2026">
    // Format B: <Circulatie ZileSaptamana="12345" ...>
    // Format C: <Calendar ZileSaptamana="12345" ...>
    // ZileSaptamana digits: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
    const schedule = [];
    // Try all known element names that carry schedule data
    const schedTagRe = /<(?:Trasa|Circulatie|Calendar|Serviciu|Grafic|PerioadaCirculatie)\b([^>]*)>/gi;
    let schedM;
    while ((schedM = schedTagRe.exec(body)) !== null) {
      const ta = schedM[1];
      const daysM  = ta.match(/ZileSaptamana="([^"]+)"/i)
                  || ta.match(/ZileSapt="([^"]+)"/i)
                  || ta.match(/DaysOfWeek="([^"]+)"/i)
                  || ta.match(/Zile="([^"]+)"/i);
      const startM = ta.match(/DataInceput="([^"]+)"/i)
                  || ta.match(/DataStart="([^"]+)"/i)
                  || ta.match(/StartDate="([^"]+)"/i)
                  || ta.match(/De="([^"]+)"/i);
      const endM   = ta.match(/DataSfarsit="([^"]+)"/i)
                  || ta.match(/DataFinal="([^"]+)"/i)
                  || ta.match(/DataSfir="([^"]+)"/i)
                  || ta.match(/EndDate="([^"]+)"/i)
                  || ta.match(/Pana="([^"]+)"/i);
      if (daysM || startM || endM) {
        schedule.push({
          days:      daysM  ? daysM[1].trim()  : '',
          dateStart: startM ? startM[1].trim() : '',
          dateEnd:   endM   ? endM[1].trim()   : '',
        });
      }
    }
    
    // Also try to find ZileSaptamana as a direct child element: <ZileSaptamana>12345</ZileSaptamana>
    if (schedule.length === 0) {
      const zileEl = body.match(/<ZileSaptamana[^>]*>([^<]+)<\/ZileSaptamana>/i);
      const startEl = body.match(/<(?:DataInceput|DataStart)[^>]*>([^<]+)<\/(?:DataInceput|DataStart)>/i);
      const endEl   = body.match(/<(?:DataSfarsit|DataFinal)[^>]*>([^<]+)<\/(?:DataSfarsit|DataFinal)>/i);
      if (zileEl) {
        schedule.push({
          days:      zileEl[1].trim(),
          dateStart: startEl ? startEl[1].trim() : '',
          dateEnd:   endEl   ? endEl[1].trim()   : '',
        });
      }
    }

    // Collect all ElementTrasa in order
    const allElems = [...body.matchAll(/<ElementTrasa\b([^>]*)\/>/g)];
    if (allElems.length === 0) continue;

    const stations = [];

    allElems.forEach((em, idx) => {
      const ea    = em[1];
      const oName = (ea.match(/DenStaOrigine="([^"]+)"/) || [])[1];
      const dName = (ea.match(/DenStaDestinatie="([^"]+)"/) || [])[1];
      const oraS  = (ea.match(/OraS="([^"]+)"/) || [])[1];
      const oraP  = (ea.match(/OraP="([^"]+)"/) || [])[1];

      if (!oName) return;

      const lastSt = stations[stations.length - 1];
      if (!lastSt || norm(lastSt.name) !== norm(oName)) {
        stations.push({ name: oName, arr: secToTime(oraS), dep: secToTime(oraP) });
      } else {
        if (!lastSt.arr && oraS) lastSt.arr = secToTime(oraS);
        if (!lastSt.dep && oraP) lastSt.dep = secToTime(oraP);
      }

      if (idx === allElems.length - 1 && dName) {
        const oraSD = (ea.match(/OraSD="([^"]+)"/) || [])[1]
                    || (ea.match(/OraSosireDestinatie="([^"]+)"/) || [])[1]
                    || (ea.match(/OraSDest="([^"]+)"/) || [])[1];
        if (norm(dName) !== norm(oName)) {
          stations.push({ name: dName, arr: oraSD ? secToTime(oraSD) : null, dep: null });
        }
      }
    });

    if (stations.length >= 2) {
      result.push({ number, category, type: guessType(category), operator: defaultOperator, stations, schedule });
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
      
      // Log XML structure sample for debugging ghost trains
      if (parsed.length > 0) {
        const sample = parsed[0];
        console.log(`[XML-STRUCT] ${src.operator}: first train ${sample.number}, schedule entries: ${sample.schedule ? sample.schedule.length : 'none'}`);
        if (sample.schedule && sample.schedule.length > 0) {
          console.log(`[XML-STRUCT] Sample schedule:`, JSON.stringify(sample.schedule[0]));
        } else {
          // Try to find ZileSaptamana in raw XML for diagnosis
          const rawSample = r.body.slice(0, 3000);
          const hasZile = rawSample.includes('ZileSaptamana');
          const hasTrasa = rawSample.includes('Trasa');
          const hasCirculatie = rawSample.includes('Circulatie');
          const hasCalendar = rawSample.includes('Calendar');
          console.log(`[XML-STRUCT] No schedule found. Raw XML has: ZileSaptamana=${hasZile}, Trasa=${hasTrasa}, Circulatie=${hasCirculatie}, Calendar=${hasCalendar}`);
          // Show first 1000 chars of XML for structure inspection
          console.log('[XML-STRUCT] First 800 chars:', rawSample.slice(0, 800).replace(/\s+/g, ' '));
        }
        // Count trains with/without schedule
        const withSched = parsed.filter(t => t.schedule && t.schedule.length > 0).length;
        console.log(`[XML-STRUCT] ${src.operator}: ${withSched}/${parsed.length} trains have schedule data`);
      }
      console.log(`[boot] ${src.operator}: ${parsed.length} trains parsed`);

      for (const train of parsed) {
        // Duplicate number guard: if this number already exists from a different operator,
        // keep the existing entry. This prevents private operator XMLs from accidentally
        // overwriting CFR Călători numbers with wrong data (as Softrans XML did).
        const existing = trains.get(train.number);
        if (existing && existing.operator !== train.operator) {
          console.warn(`[dedup] Train ${train.number}: ${src.operator} conflicts with ${existing.operator} — keeping ${existing.operator}`);
          continue; // skip duplicate
        }

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
function findDirectJourneys(fromNorm, toNorm, dateStr) {
  const fromSet = stationIndex.get(fromNorm) || new Set();
  const toSet   = stationIndex.get(toNorm)   || new Set();
  const results = [];

  for (const tNum of fromSet) {
    if (!toSet.has(tNum)) continue;

    const train = trains.get(tNum);
    if (!train) continue;

    // ── Day-of-operation check ───────────────────────────────────────────
    // Skip trains that don't run on the searched date
    if (dateStr && !trainRunsOnDate(train, dateStr)) continue;

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

function searchJourneys(fromName, toName, dateStr) {
  const fN = resolveStation(fromName);
  const tN = resolveStation(toName);

  const journeys = [];

  // Direct (filtered by date)
  const directs = findDirectJourneys(fN, tN, dateStr);
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
      const leg1s = findDirectJourneys(fN, via, dateStr);
      const leg2s = findDirectJourneys(via, tN, dateStr);

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
    .slice(0, 200); // full day of trains
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

    // Extract platform/line number - IRIS shows "Linia X" or "Peronul X"  
    const platformM = html.match(/[Ll]inia\s*(\d+)/i)
                    || html.match(/[Pp]eron(?:ul)?\s*(\d+)/i)
                    || html.match(/[Tt]rack\s*(\d+)/i);
    const platform = platformM ? platformM[1] : null;

    const result = {
      trainNumber,
      delay,
      platform,
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


// GET /api/debug/:trainNumber — show raw schedule data + InfoFer test
app.get('/api/debug/:trainNumber', async (req, res) => {
  const num = req.params.trainNumber.trim();
  const date = (req.query.date || todayStr()).trim();
  const train = trains.get(num);
  if (!train) return res.json({ error: 'Train not found', num });

  // Test InfoFer connectivity
  let infoferResult = null;
  try {
    const url = `https://mersultrenurilor.infofer.ro/ro-RO/Tren/Info-tren?tren=${encodeURIComponent(num)}&data=${encodeURIComponent(date)}`;
    const r = await get(url, 8000);
    infoferResult = {
      status: r.status,
      length: (r.body||'').length,
      first300: (r.body||'').slice(0,300),
      hasNuCircula: /nu circulă|nu circula/i.test(r.body||''),
      hasTrainInfo: (r.body||'').length > 800,
    };
  } catch(e) {
    infoferResult = { error: e.message };
  }

  return res.json({
    num,
    date,
    category: train.category,
    operator: train.operator,
    schedule: train.schedule,
    scheduleLength: train.schedule ? train.schedule.length : 0,
    trainRunsOnDate: trainRunsOnDate(train, date),
    stationCount: train.stations.length,
    firstStation: train.stations[0],
    lastStation: train.stations[train.stations.length-1],
    infofer: infoferResult,
  });
});

// GET /api/test-train?n=1581&d=26.02.2026 — test IRIS for a specific train/date
app.get('/api/test-train', async (req, res) => {
  const num  = (req.query.n || '').trim();
  const date = (req.query.d || todayStr()).trim();
  if (!num) return res.json({ error: 'n= required' });
  
  const results = { num, date };
  
  // Check IRIS MersTrenRo with date
  try {
    const url1 = `http://appiris.infofer.ro/MersTrenRo.aspx?tren=${encodeURIComponent(num)}&data=${encodeURIComponent(date)}`;
    const r1 = await get(url1, 8000);
    results.irisMersTren = {
      url: url1, status: r1.status, length: r1.body.length,
      hasTimes: /\d{2}:\d{2}/.test(r1.body),
      first300: r1.body.slice(0, 300).replace(/\s+/g, ' '),
    };
  } catch(e) { results.irisMersTren = { error: e.message }; }
  
  // Check IRIS MyTrainRO (live position - no date)
  try {
    const url2 = IRIS_URL(num);
    const r2 = await get(url2, 8000);
    results.irisMyTrain = {
      url: url2, status: r2.status, length: r2.body.length,
      hasTimes: /\d{2}:\d{2}/.test(r2.body),
      first300: r2.body.slice(0, 300).replace(/\s+/g, ' '),
    };
  } catch(e) { results.irisMyTrain = { error: e.message }; }
  
  // Check our XML data
  const train = trains.get(num);
  results.xmlData = train ? {
    schedule: train.schedule,
    scheduleCount: train.schedule ? train.schedule.length : 0,
    trainRunsOnDate: trainRunsOnDate(train, date),
    stations: train.stations.length,
  } : { error: 'not in XML' };
  
  // Check validation result
  results.validationResult = await checkTrainOnInfoFer(num, date);
  
  res.json(results);
});

// GET /api/xmltest — diagnose XML structure and IRIS connectivity
app.get('/api/xmltest', async (req, res) => {
  const results = {};
  
  // Test 1: Check IRIS connectivity with a known train
  try {
    const irisUrl = `http://appiris.infofer.ro/MersTrenRo.aspx?tren=1581&data=${todayStr()}`;
    const r = await get(irisUrl, 8000);
    results.iris = {
      status: r.status,
      length: r.body.length,
      hasTimes: /\d{2}:\d{2}/.test(r.body),
      first200: r.body.slice(0, 200).replace(/\s+/g, ' '),
    };
  } catch(e) { results.iris = { error: e.message }; }
  
  // Test 2: Check XML structure
  try {
    const xmlR = await get(XML_SOURCES[0].url, 30000);
    const xml = xmlR.body || '';
    results.xml = {
      length: xml.length,
      hasZileSaptamana: xml.includes('ZileSaptamana'),
      hasTrasa: xml.includes('<Trasa'),
      hasPerioda: xml.includes('Perioada'),
      // Show first <Tren> element raw
      firstTren: (xml.match(/<Tren\b[^>]*>[\s\S]{0,800}?<\/Tren>/) || ['not found'])[0],
      // Show first 500 chars
      first500: xml.slice(0, 500),
    };
    // Count trains with schedule
    let withSched = 0, total = 0;
    const re = /<Tren\b[^>]*>([\s\S]*?)<\/Tren>/g;
    let m;
    while ((m = re.exec(xml)) !== null && total < 100) {
      total++;
      if (/ZileSaptamana/.test(m[1])) withSched++;
    }
    results.xml.trainsChecked = total;
    results.xml.withSchedule = withSched;
    results.xml.percentWithSchedule = Math.round(withSched/total*100) + '%';
  } catch(e) { results.xml = { error: e.message }; }
  
  // Test 3: Check our in-memory schedule data for sample trains
  const sampleNums = [...trains.keys()].slice(0, 5);
  results.sampleTrains = sampleNums.map(n => {
    const t = trains.get(n);
    return { 
      number: n, 
      scheduleEntries: t.schedule ? t.schedule.length : 0,
      schedule: t.schedule,
      runsToday: trainRunsOnDate(t, todayStr()),
    };
  });
  results.totalTrains = trains.size;
  results.today = todayStr();
  
  res.json(results);
});

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
app.get('/api/itineraries', async (req, res) => {
  const from = (req.query.from || '').trim();
  const to   = (req.query.to   || '').trim();
  const date = (req.query.date || '').trim() || todayStr();

  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  if (!dataReady)   return res.status(503).json({ error: 'Loading, try again in 30s', status: loadStatus });

  const key    = `itin:${resolveStation(from)}:${resolveStation(to)}:${date}`;
  const cached = cacheGet(key);
  if (cached) return res.json({ source: 'cache', from, to, date, journeys: cached, count: cached.length });

  const rawJourneys = searchJourneys(from, to, date);

  // ── Validate every train number against InfoFer for the requested date ──
  // This eliminates ghost trains that exist in the XML but don't run on this date.
  const allTrainNums = [...new Set(
    rawJourneys.flatMap(j => j.legs.map(l => l.number).filter(Boolean))
  )];

  let validNums = new Set(allTrainNums); // default: all valid
  if (allTrainNums.length > 0) {
    try {
      const validation = await validateTrains(allTrainNums, date);
      validNums = new Set(Object.entries(validation)
        .filter(([, ok]) => ok)
        .map(([num]) => num));
    } catch (e) {
      console.error('[itineraries] validation error:', e.message);
      // Fail open — return all rather than nothing
    }
  }

  // Filter out journeys where any leg's train doesn't run on this date
  const journeys = rawJourneys.filter(j =>
    j.legs.every(l => !l.number || validNums.has(l.number))
  );

  cacheSet(key, journeys, 300); // cache 5 minutes
  return res.json({ source: 'live', from, to, date, journeys, count: journeys.length });
});

// ─── INFOFER TRAIN VALIDATION ─────────────────────────────────────────────
// Check a single train number against InfoFer mers tren for a specific date.
// Returns true if running, false if not found / not running on that date.
// Check if a specific train runs on a specific date using IRIS.
// Fail-open: if IRIS is unreachable or ambiguous, we show the train.
async function checkTrainOnInfoFer(trainNum, dateStr) {
  const cacheKey = `infofer:${trainNum}:${dateStr}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) return cached;

  const url = `http://appiris.infofer.ro/MersTrenRo.aspx?tren=${encodeURIComponent(trainNum)}&data=${encodeURIComponent(dateStr)}`;
  try {
    const r = await get(url, 6000);
    const html = r.body || '';

    // Only block if IRIS explicitly says the train doesn't run
    const notRunning =
      /nu circul[aă]/i.test(html) ||
      /nu exist[aă] informa/i.test(html) ||
      /tren.*negasit/i.test(html) ||
      (html.length > 50 && html.length < 300 && !/<table/i.test(html));

    const running = !notRunning;
    cacheSet(cacheKey, running, 3600);
    return running;
  } catch (e) {
    // Network error → fail open (show train)
    cacheSet(cacheKey, true, 300);
    return true;
  }
}

// Track whether IRIS is reachable (probe result cached 10 min)
let _irisReachable = null;
let _irisProbeTime = 0;
async function isIrisReachable() {
  if (Date.now() - _irisProbeTime < 600000) return _irisReachable;
  try {
    const r = await get('http://appiris.infofer.ro/MersTrenRo.aspx?tren=1581', 4000);
    _irisReachable = r.status === 200 && r.body.length > 100;
  } catch (e) {
    _irisReachable = false;
  }
  _irisProbeTime = Date.now();
  console.log(`[IRIS] reachable: ${_irisReachable}`);
  return _irisReachable;
}

// Validate a list of train numbers for a given date.
// Step 1: XML schedule filter (instant — ZileSaptamana + date range).
// Step 2: IRIS per-train check ONLY if IRIS is reachable (skip if not to avoid slow timeouts).
// Fail-open: trains with no schedule data and no IRIS check are shown.
async function validateTrains(trainNumbers, dateStr) {
  if (!trainNumbers.length) return {};
  const results = {};
  const needsIris = [];

  for (const num of trainNumbers) {
    const train = trains.get(num);
    if (!train) { results[num] = false; continue; }
    // XML schedule check — blocks trains outside date range or wrong day of week
    if (train.schedule && train.schedule.length > 0 && !trainRunsOnDate(train, dateStr)) {
      results[num] = false;
      continue;
    }
    needsIris.push(num);
  }

  // Only call IRIS if it's known to be reachable (avoids 6s timeouts × 50 trains)
  const irisOk = await isIrisReachable();
  if (irisOk) {
    for (let i = 0; i < needsIris.length; i += 10) {
      const batch = needsIris.slice(i, i + 10);
      await Promise.all(batch.map(async num => {
        results[num] = await checkTrainOnInfoFer(num, dateStr);
      }));
    }
  } else {
    // IRIS unreachable — fail open for all remaining trains
    for (const num of needsIris) results[num] = true;
  }

  return results;
}

// GET /api/validate-trains?numbers=532,1234&date=25.02.2026
app.get('/api/validate-trains', async (req, res) => {
  const numbersRaw = (req.query.numbers || '').trim();
  const date = (req.query.date || todayStr()).trim();
  if (!numbersRaw) return res.json({ results: {} });
  const numbers = numbersRaw.split(',').map(n => n.trim()).filter(Boolean).slice(0, 20);
  const results = await validateTrains(numbers, date);
  return res.json({ date, results, checked: numbers.length });
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
app.get('/api/board/:stationName', async (req, res) => {
  if (!dataReady) return res.status(503).json({ error: 'Loading, try again in 30s' });

  const stName = req.params.stationName.trim();
  const n      = resolveStation(stName);
  const gps    = stationGPS.get(n);

  // ── PRIMARY: Try IRIS SosPlcRO.aspx — authoritative real departures ──────
  // IRIS only returns trains that actually run today. No ghost trains possible.
  const irisBoard = await getIRISStationBoard(stName);
  if (irisBoard && irisBoard.length > 0) {
    // Enrich IRIS data with our XML data (operator, full route, etc.)
    const departures = irisBoard.map(d => {
      const xmlTrain = trains.get(d.number);
      return {
        time:        d.time,
        train:       `${d.category || xmlTrain?.category || ''} ${d.number}`.trim(),
        trainNumber: d.number,
        number:      d.number,
        type:        xmlTrain?.type || d.category || '',
        operator:    xmlTrain?.operator || '',
        to:          d.to || (xmlTrain ? xmlTrain.stations[xmlTrain.stations.length-1].name : ''),
        from:        xmlTrain ? xmlTrain.stations[0].name : '',
        delay:       d.delay || 0,
        platform:    d.platform || null,
        isOrigin:    xmlTrain ? norm(xmlTrain.stations[0].name) === n : false,
        isTerminus:  xmlTrain ? norm(xmlTrain.stations[xmlTrain.stations.length-1].name) === n : false,
      };
    });

    return res.json({
      station:   stName,
      source:    'iris',
      lat:       gps?.lat || null,
      lng:       gps?.lng || null,
      stationId: gps?.id  || null,
      departures,
      count:     departures.length,
    });
  }

  // ── FALLBACK: XML data + date validation ─────────────────────────────────
  // Used when IRIS is unavailable. We validate against InfoFer to filter ghosts.
  console.log('[board] IRIS unavailable for', stName, '— falling back to XML');
  const nums = stationIndex.get(n);
  if (!nums || nums.size === 0) {
    const q2 = norm(stName);
    const suggestions = [];
    for (const [key] of stationIndex) {
      if (key.includes(q2) || q2.includes(key)) suggestions.push(key);
    }
    return res.status(404).json({
      error: `Station "${stName}" not found`,
      suggestions: suggestions.slice(0, 5),
    });
  }

  const date = todayStr();
  const rawDeps = [];
  for (const tNum of nums) {
    const train = trains.get(tNum);
    if (!train) continue;
    const st = train.stations.find(s => norm(s.name) === n);
    if (!st) continue;
    const dep = st.dep || st.arr;
    if (!dep) continue;
    rawDeps.push({
      time:        dep,
      train:       `${train.category} ${train.number}`,
      trainNumber: train.number,
      number:      train.number,
      type:        train.type,
      operator:    train.operator,
      from:        train.stations[0].name,
      to:          train.stations[train.stations.length - 1].name,
      delay:       0,
      platform:    null,
      isOrigin:    norm(train.stations[0].name) === n,
      isTerminus:  norm(train.stations[train.stations.length - 1].name) === n,
    });
  }

  // Use validateTrains (InfoFer page → XML → IRIS) to filter ghost trains
  const allNums = [...new Set(rawDeps.map(d => d.number).filter(Boolean))];
  let validNums = new Set(allNums);
  try {
    const validation = await validateTrains(allNums, date);
    validNums = new Set(Object.entries(validation).filter(([,ok])=>ok).map(([n])=>n));
    console.log(`[board fallback] ${validNums.size}/${allNums.length} trains validated for ${stName}`);
  } catch (e) { console.error('[board fallback] validation error:', e.message); }

  const departures = rawDeps.filter(d => !d.number || validNums.has(d.number));
  departures.sort((a, b) => timeToMins(a.time) - timeToMins(b.time));

  return res.json({
    station:   stName,
    source:    'xml',
    lat:       gps?.lat || null,
    lng:       gps?.lng || null,
    stationId: gps?.id  || null,
    departures,
    count:     departures.length,
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
