# Velox API v4

Real Romanian railway backend. Uses official 2025-2026 timetable XML from data.gov.ro + live IRIS delays.

## Endpoints

| URL | Description |
|-----|-------------|
| `GET /health` | Status — check `trains` count here after deploy |
| `GET /api/stations?q=Brasov` | Station autocomplete with GPS coords |
| `GET /api/itineraries?from=Brașov&to=Constanța` | Journey search (direct + 1 change) |
| `GET /api/train/1581` | Full scheduled route for a train |
| `GET /api/train/1581/live` | Real-time delay from IRIS |
| `GET /api/board/Brașov` | All departures from a station today |

## Deploy on Render

1. Upload `server.js`, `package.json`, `README.md` to GitHub repo
2. render.com → New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Click Deploy

After ~60 seconds visit `/health` — you should see `trains > 0`.
