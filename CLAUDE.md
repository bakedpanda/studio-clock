# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Studio Clock: a self-hosted broadcast clock and shared countdown timer for live production. The server NTP-syncs to `pool.ntp.org` and pushes a corrected timestamp plus shared timer/stopwatch/message state to all connected browsers over Server-Sent Events, so every viewer screen stays in lockstep regardless of local clock drift.

The entire app is two files: `server.js` (Node, no dependencies) and `studio-clock.html` (single-file frontend — HTML, CSS, and vanilla JS all inline, no build step, no framework).

## Commands

There is no package.json, no npm install, no test suite, no linter, and no build step — this is intentional (see README: "No dependencies — pure Node.js").

- Run locally: `node server.js` (serves on port 7823 by default — chosen to avoid conflicts; override with `PORT=xxxx node server.js`)
- Run via Docker: `docker compose up -d` (maps host port 7823 → container 7823, see `docker-compose.yml`)
- Rebuild/redeploy on a host already running it: `./update.sh` (forces `docker-compose up -d --build --force-recreate`)
- First-time deploy: `./deploy.sh`
- Windows laptop, no Docker: `start.bat` / `stop.bat` (starts/stops plain Node in the background, opens the operator page)

Manual verification after changes (no automated tests exist): start the server, open `http://localhost:7823/operator` in one tab and `http://localhost:7823/` in another, and confirm timer/stopwatch/message/settings changes on the operator propagate to the viewer live.

## Architecture

### Server (`server.js`)

- Plain `http` + `dgram` module, no Express/frameworks. All routing is a chain of `if (req.method === ... && pathname === ...)` checks in the single request handler.
- **NTP sync**: `syncNTP()` implements SNTP (RFC 4330) by hand against a random server from `NTP_SERVERS`, computing `ntpOffset` from the round-trip; retried every 5 minutes and on failure/timeout. `ntpNow()` is the corrected clock; `/time` exposes it to clients.
- **State**: all mutable app state (`timer`, `stopwatch`, `targetTime`, `message`, `show`, `displaySettings`) lives in flat module-level objects specifically so `snapshot()` can spread them into one JSON blob. There is no per-client state — every connected browser (operator or viewer) receives the same broadcast.
- **Broadcast model**: `sseClients` is an array of open `http.ServerResponse` objects for `/events`. Any state-mutating POST route calls `broadcast(snapshot())` to push the new state to everyone immediately. Timers/stopwatches carry `endAt`/`startedAt` timestamps rather than a ticking counter, so `snapshot()` computes `remaining`/`elapsed` on demand — this is also why the client can smoothly interpolate between SSE pushes without polling.
- **Persistence**: `state.json` (display settings, labels, warn thresholds, message text, widget visibility toggles) and `presets.json` (named saved settings snapshots) are read on boot (`loadState()`) and rewritten on every relevant change (`saveState()` / `savePresetsFile()`). Both files are gitignored — don't assume they exist in a fresh checkout.
- Timer expiry is polled server-side every 250ms (`setInterval`): when `Date.now() >= timer.endAt` it flips to `expired`, broadcasts, then auto-resets to `idle` after 30s.

### Frontend (`studio-clock.html`)

- One HTML file serves both roles. Mode is decided purely from the URL path: `/operator` → operator (controls + settings panel), anything else → viewer (display only). This is the `isOperator` / `BASE` logic near the top of the `<script>` block — `BASE` is the path prefix used to build all fetch/EventSource URLs, so the app works correctly when reverse-proxied under a subpath.
- **Sync loop**: `connectSSE()` opens `EventSource(BASE + 'events')`; every message is the full server `snapshot()`, applied via `applySSEState()`. Viewers also cache the last snapshot in `localStorage` so the display isn't blank on reload before the first SSE message arrives.
- **Clock rendering**: `serverNow()` (server time + locally-measured `timeOffset` from `/time`, resynced every 30s) is the single source of truth for "now" — never use `Date.now()` directly in display code. `drawClock()` renders to a `<canvas>` for analog mode; digital mode hides the canvas via the `clock-digital` body class and uses a text element instead.
- **Display settings & layout**: `displaySettings` (colors, clock style, viewer layout, per-element `x/y/scale` positions) are pushed from the operator via `POST /settings` and broadcast to everyone, so a viewer's appearance is fully server-driven. The layout editor (`toggleLayoutEditor`, `leStartDrag`, `leStartResize`, etc.) is a drag/resize UI on the operator page for setting each widget's `elementPositions` entry, previewed live.
- **Shareable settings links**: `encodeSettings`/`decodeSettings` base64-encode a settings object into a `?s=` query param so a specific look can be shared/bookmarked as a URL without touching server-side `displaySettings` — check `settingsPinned` / `urlS` handling when touching settings precedence, since URL params should override the broadcast state for that viewer only.
- **Presets** are named, saved `displaySettings` snapshots (`GET/POST /presets`, `DELETE /presets/:name`) managed from the operator UI, distinct from the single live `displaySettings` that's actually broadcast.

### Adding a new widget/feature

Following the existing pattern (e.g. `message` or `targetTime`) means touching: a state object in `server.js`, its slice in `snapshot()`, a POST route that mutates it + calls `saveState()` + `broadcast()`, a corresponding entry in `show` if it should be independently toggleable, an `elementPositions` default, and on the frontend a `.vw-el` block, an `applySSEState()` case, and operator-panel controls that call `post()`.
