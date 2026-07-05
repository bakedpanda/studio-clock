# Studio Clock

A self-hosted broadcast clock and shared timer for live production environments. Displays an NTP-synced clock and a synchronized countdown timer that all connected clients see in real time.

## Features

- **NTP-synced clock** — server queries `pool.ntp.org` and serves a corrected timestamp to all browsers, keeping every display in sync regardless of client clock drift
- **Shared countdown timer** — operator starts/pauses/resets the timer; all viewer screens update instantly via Server-Sent Events
- **Operator / viewer modes** — `/operator` shows timer controls, `/` (viewer) shows display only
- **No dependencies** — pure Node.js, no npm install required
- **Docker support** — single container, runs anywhere

## Usage

### Docker (recommended)

```bash
docker compose up -d
```

### Direct

```bash
node server.js
```

The server runs on port `7823` by default (an uncommon port chosen to avoid conflicts). Set the `PORT` environment variable to override.

| URL | Purpose |
|-----|---------|
| `http://host:7823/` | Viewer — display only |
| `http://host:7823/operator` | Operator — timer controls |

### Windows laptop (event use)

For running on a Windows laptop without Docker: install [Node.js](https://nodejs.org) (LTS), then double-click:

- `start.bat` — starts the server in the background and opens the operator page in your browser
- `stop.bat` — stops the server

Windows Firewall may prompt to allow Node.js on first run — allow it if other devices (viewer screens) need to connect over the network. Display settings and saved presets live in `presets.json`/`state.json` next to `server.js`, so they persist across `start.bat`/`stop.bat` as long as you don't delete the folder.

## How it works

- The server implements SNTP (RFC 4330) using Node's built-in `dgram` module — no external packages needed
- Timer state lives on the server; clients receive updates over a persistent SSE connection (`/events`) and send commands via `POST`
- Between SSE updates, running timers count down locally using the last known remaining value, so the display stays smooth without polling
