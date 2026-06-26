const http  = require('http');
const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 3000;

// ── NTP Sync ───────────────────────────────────────────────────────────────
// Implements SNTP (RFC 4330) using Node's built-in dgram — no npm needed.
// Queries pool.ntp.org, calculates offset from local clock, and applies it
// to every /time response so all browsers share the same reference.

const NTP_SERVERS  = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org'];
const NTP_PORT     = 123;
const NTP_DELTA    = 2208988800; // seconds between NTP epoch (1900) and Unix epoch (1970)
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // re-sync every 5 minutes

let ntpOffset = 0; // ms to add to Date.now() to get NTP-corrected time
let ntpSynced = false;

function ntpNow() { return Date.now() + ntpOffset; }

function syncNTP() {
  const server = NTP_SERVERS[Math.floor(Math.random() * NTP_SERVERS.length)];
  const client = dgram.createSocket('udp4');
  const req    = Buffer.alloc(48);
  req[0] = 0x1B; // LI=0, VN=3 (version), Mode=3 (client)

  const timeout = setTimeout(() => {
    client.close();
    console.warn(`NTP: timeout reaching ${server}, retrying in 30s`);
    setTimeout(syncNTP, 30000);
  }, 5000);

  const t0 = Date.now();

  client.send(req, 0, req.length, NTP_PORT, server, err => {
    if (err) {
      clearTimeout(timeout);
      client.close();
      console.warn(`NTP: send error — ${err.message}`);
      setTimeout(syncNTP, 30000);
    }
  });

  client.on('message', data => {
    const t1 = Date.now();
    clearTimeout(timeout);
    client.close();

    // Transmit timestamp: bytes 40–43 (seconds), 44–47 (fraction)
    const secs   = data.readUInt32BE(40) - NTP_DELTA;
    const frac   = data.readUInt32BE(44);
    const ntpMs  = secs * 1000 + Math.round((frac / 0x100000000) * 1000);
    const latency = (t1 - t0) / 2;

    ntpOffset = ntpMs + latency - t1;
    ntpSynced = true;
    console.log(`NTP: synced to ${server}, offset ${ntpOffset > 0 ? '+' : ''}${Math.round(ntpOffset)}ms, latency ±${Math.round(latency)}ms`);
  });

  client.on('error', err => {
    clearTimeout(timeout);
    client.close();
    console.warn(`NTP: error — ${err.message}`);
    setTimeout(syncNTP, 30000);
  });
}

syncNTP();
setInterval(syncNTP, SYNC_INTERVAL_MS);

// ── Shared timer state ────────────────────────────────────────────────────
let timer = {
  state: 'idle',      // idle | running | paused | expired
  remaining: 0,
  endAt: null,
};

// Last duration set by the operator — shared across devices, expires after 12h
const DURATION_TTL = 12 * 60 * 60 * 1000;
let lastDuration = { mins: 0, secs: 0, savedAt: 0 };

function savedDuration() {
  if (!lastDuration.savedAt || Date.now() - lastDuration.savedAt > DURATION_TTL) {
    return { mins: 0, secs: 0 };
  }
  return { mins: lastDuration.mins, secs: lastDuration.secs };
}

let sseClients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function snapshot() {
  const remaining = timer.state === 'running'
    ? Math.max(0, timer.endAt - Date.now())
    : timer.remaining;
  return { state: timer.state, remaining };
}

// Server-side expiry check — auto-resets to idle after 30 s of pulsing
let expiredTimeout = null;

function clearExpiredTimeout() {
  if (expiredTimeout) { clearTimeout(expiredTimeout); expiredTimeout = null; }
}

setInterval(() => {
  if (timer.state !== 'running') return;
  if (Date.now() >= timer.endAt) {
    timer.state = 'expired';
    timer.remaining = 0;
    timer.endAt = null;
    broadcast(snapshot());
    expiredTimeout = setTimeout(() => {
      timer = { state: 'idle', remaining: 0, endAt: null };
      expiredTimeout = null;
      broadcast(snapshot());
    }, 30000);
  }
}, 250);

// ── Presets (persisted to presets.json) ──────────────────────────────────
const PRESETS_FILE = path.join(__dirname, 'presets.json');
let presets = {};

try {
  presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
  console.log(`Loaded ${Object.keys(presets).length} preset(s) from presets.json`);
} catch {}

function savePresetsFile() {
  fs.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), err => {
    if (err) console.warn('Could not save presets.json:', err.message);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function parseBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { cb(JSON.parse(body || '{}')); }
    catch { cb({}); }
  });
}

function noContent(res) { res.writeHead(204); res.end(); }

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ── Server ────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Parse pathname separately from query string
  const pathname = req.url.split('?')[0];

  // Presets — list all
  if (req.method === 'GET' && pathname === '/presets') {
    return json(res, presets);
  }

  // Presets — save
  if (req.method === 'POST' && pathname === '/presets') {
    return parseBody(req, body => {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) { res.writeHead(400); return res.end('name required'); }
      presets[name] = body.settings || {};
      savePresetsFile();
      noContent(res);
    });
  }

  // Presets — delete
  if (req.method === 'DELETE' && pathname.startsWith('/presets/')) {
    const name = decodeURIComponent(pathname.slice('/presets/'.length));
    delete presets[name];
    savePresetsFile();
    return noContent(res);
  }

  // Last operator-set duration (shared across devices, expires after 12h)
  if (req.method === 'GET' && pathname === '/timer/duration') {
    return json(res, savedDuration());
  }

  if (req.method === 'POST' && pathname === '/timer/duration') {
    return parseBody(req, body => {
      const mins = Math.max(0, parseInt(body.mins) || 0);
      const secs = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
      lastDuration = { mins, secs, savedAt: Date.now() };
      noContent(res);
    });
  }

  // Current server time for clock sync (NTP-corrected)
  if (req.method === 'GET' && pathname === '/time') {
    return json(res, { ts: ntpNow(), ntpSynced });
  }

  // SSE stream — pushes timer state to all connected clients
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('\n');
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`); // send current state immediately
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Timer control endpoints
  if (req.method === 'POST' && pathname === '/timer/start') {
    return parseBody(req, body => {
      const mins = Math.max(0, parseInt(body.mins) || 0);
      const secs = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
      const duration = (mins * 60 + secs) * 1000;
      if (duration > 0) {
        clearExpiredTimeout();
        timer = { state: 'running', remaining: duration, endAt: Date.now() + duration };
        broadcast(snapshot());
      }
      noContent(res);
    });
  }

  if (req.method === 'POST' && pathname === '/timer/pause') {
    if (timer.state === 'running') {
      timer.remaining = Math.max(0, timer.endAt - Date.now());
      timer.state = 'paused';
      timer.endAt = null;
      broadcast(snapshot());
    }
    return noContent(res);
  }

  if (req.method === 'POST' && pathname === '/timer/resume') {
    if (timer.state === 'paused') {
      timer.endAt = Date.now() + timer.remaining;
      timer.state = 'running';
      broadcast(snapshot());
    }
    return noContent(res);
  }

  if (req.method === 'POST' && pathname === '/timer/reset') {
    return parseBody(req, body => {
      const mins = Math.max(0, parseInt(body.mins) || 0);
      const secs = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
      clearExpiredTimeout();
      timer = { state: 'idle', remaining: (mins * 60 + secs) * 1000, endAt: null };
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Serve the app — / and /operator are the two UI routes (query strings allowed)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/operator')) {
    fs.readFile(path.join(__dirname, 'studio-clock.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Studio clock running on port ${PORT}`));
