const http  = require('http');
const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 3000;

// ── NTP Sync ───────────────────────────────────────────────────────────────
const NTP_SERVERS      = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org'];
const NTP_PORT         = 123;
const NTP_DELTA        = 2208988800;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let ntpOffset = 0;
let ntpSynced = false;
function ntpNow() { return Date.now() + ntpOffset; }

function syncNTP() {
  const server = NTP_SERVERS[Math.floor(Math.random() * NTP_SERVERS.length)];
  const client = dgram.createSocket('udp4');
  const req    = Buffer.alloc(48);
  req[0] = 0x1B;

  const timeout = setTimeout(() => {
    client.close();
    console.warn(`NTP: timeout reaching ${server}, retrying in 30s`);
    setTimeout(syncNTP, 30000);
  }, 5000);

  const t0 = Date.now();

  client.send(req, 0, req.length, NTP_PORT, server, err => {
    if (err) { clearTimeout(timeout); client.close(); setTimeout(syncNTP, 30000); }
  });

  client.on('message', data => {
    const t1 = Date.now();
    clearTimeout(timeout);
    client.close();
    const secs    = data.readUInt32BE(40) - NTP_DELTA;
    const frac    = data.readUInt32BE(44);
    const ntpMs   = secs * 1000 + Math.round((frac / 0x100000000) * 1000);
    const latency = (t1 - t0) / 2;
    ntpOffset = ntpMs + latency - t1;
    ntpSynced = true;
    console.log(`NTP: synced to ${server}, offset ${ntpOffset > 0 ? '+' : ''}${Math.round(ntpOffset)}ms`);
  });

  client.on('error', err => {
    clearTimeout(timeout); client.close();
    console.warn(`NTP: error — ${err.message}`);
    setTimeout(syncNTP, 30000);
  });
}

syncNTP();
setInterval(syncNTP, SYNC_INTERVAL_MS);

// ── Application state ─────────────────────────────────────────────────────
// All mutable state is in flat objects so snapshot() can spread them cleanly.

const timer = {
  mode: 'idle',     // idle | running | paused | expired
  remaining: 0,     // ms remaining when not running
  endAt: null,      // absolute ms target when running
  label: '',
  warnAt: 60000,    // ms — color-warn viewers when under this
};

const stopwatch = {
  mode: 'idle',     // idle | running | paused
  startedAt: null,  // Date.now() when last started/resumed
  elapsed: 0,       // ms accumulated before current run
  label: '',
};

const targetTime = {
  target: '',       // HH:MM (24 h)
  label: '',
  enabled: false,
};

const message = {
  text: '',
  visible: false,
  flash: false,
};

// Which widgets are shown on display pages (operator controls)
const show = {
  clock:      true,
  timer:      false,
  stopwatch:  false,
  targetTime: false,
  message:    false,
};

// Viewer display settings (broadcast to all viewers via SSE)
const displaySettings = {
  showSeconds:      true,
  clockColor:       '#00e676',
  bgColor:          '#0a0a0a',
  textColor:        '#ffffff',
  chromakey:        false,
  viewerLayout:     'auto',
  clockStyle:       'digital',
  viewerFocus:      'clock',
  customLayout:     false,
  elementPositions: {
    clock:      { x: 50, y: 44, scale: 1.0 },
    timer:      { x: 20, y: 76, scale: 0.9 },
    stopwatch:  { x: 50, y: 76, scale: 0.9 },
    targetTime: { x: 80, y: 76, scale: 0.9 },
    message:    { x: 50, y: 88, scale: 0.85 },
  },
};

let expiredTimeout = null;
let flashTimeout   = null;

// ── Duration memory ───────────────────────────────────────────────────────
const DURATION_TTL = 12 * 60 * 60 * 1000;
let lastDuration = { mins: 0, secs: 0, savedAt: 0 };

function savedDuration() {
  if (!lastDuration.savedAt || Date.now() - lastDuration.savedAt > DURATION_TTL) return { mins: 0, secs: 0 };
  return { mins: lastDuration.mins, secs: lastDuration.secs };
}

// ── SSE broadcast ─────────────────────────────────────────────────────────
let sseClients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function snapshot() {
  return {
    timer: {
      mode:      timer.mode,
      remaining: timer.mode === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remaining,
      label:     timer.label,
      warnAt:    timer.warnAt,
    },
    stopwatch: {
      mode:    stopwatch.mode,
      elapsed: stopwatch.mode === 'running'
        ? stopwatch.elapsed + (Date.now() - stopwatch.startedAt)
        : stopwatch.elapsed,
      label: stopwatch.label,
    },
    targetTime: { target: targetTime.target, label: targetTime.label, enabled: targetTime.enabled },
    message:    { text: message.text, visible: message.visible, flash: message.flash },
    show:       { clock: show.clock, timer: show.timer, stopwatch: show.stopwatch,
                  targetTime: show.targetTime, message: show.message },
    displaySettings: { ...displaySettings },
  };
}

// ── Timer expiry ──────────────────────────────────────────────────────────
setInterval(() => {
  if (timer.mode !== 'running') return;
  if (Date.now() >= timer.endAt) {
    timer.mode      = 'expired';
    timer.remaining = 0;
    timer.endAt     = null;
    broadcast(snapshot());
    expiredTimeout = setTimeout(() => {
      timer.mode      = 'idle';
      timer.remaining = 0;
      expiredTimeout  = null;
      broadcast(snapshot());
    }, 30000);
  }
}, 250);

function clearExpiredTimeout() {
  if (expiredTimeout) { clearTimeout(expiredTimeout); expiredTimeout = null; }
}

// ── Presets ───────────────────────────────────────────────────────────────
const PRESETS_FILE = path.join(__dirname, 'presets.json');
let presets = {};
try {
  presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
  console.log(`Loaded ${Object.keys(presets).length} preset(s)`);
} catch {}

function savePresetsFile() {
  fs.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2), err => {
    if (err) console.warn('Could not save presets.json:', err.message);
  });
}

// ── Persistent state ──────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved.displaySettings) Object.assign(displaySettings, saved.displaySettings);
    if (saved.timerLabel  !== undefined) timer.label  = saved.timerLabel;
    if (saved.timerWarnAt !== undefined) timer.warnAt = saved.timerWarnAt;
    if (saved.swLabel     !== undefined) stopwatch.label = saved.swLabel;
    if (saved.targetTime)  Object.assign(targetTime, saved.targetTime);
    if (saved.message)     Object.assign(message,    { text: saved.message.text || '', visible: false, flash: false });
    if (saved.show)        Object.assign(show,        saved.show);
    console.log('Loaded persistent state');
  } catch {}
}

function saveState() {
  const data = {
    displaySettings: { ...displaySettings },
    timerLabel:  timer.label,
    timerWarnAt: timer.warnAt,
    swLabel:     stopwatch.label,
    targetTime:  { ...targetTime },
    message:     { text: message.text },
    show:        { ...show },
  };
  fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), err => {
    if (err) console.warn('Could not save state.json:', err.message);
  });
}

loadState();

// ── HTTP helpers ──────────────────────────────────────────────────────────
function parseBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => { try { cb(JSON.parse(body || '{}')); } catch { cb({}); } });
}
function noContent(res) { res.writeHead(204); res.end(); }
function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ── HTTP server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const pathname = req.url.split('?')[0];

  // Presets
  if (req.method === 'GET'    && pathname === '/presets') return json(res, presets);
  if (req.method === 'POST'   && pathname === '/presets') {
    return parseBody(req, body => {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) { res.writeHead(400); return res.end('name required'); }
      presets[name] = body.settings || {};
      savePresetsFile();
      noContent(res);
    });
  }
  if (req.method === 'DELETE' && pathname.startsWith('/presets/')) {
    delete presets[decodeURIComponent(pathname.slice('/presets/'.length))];
    savePresetsFile();
    return noContent(res);
  }

  // Display settings
  if (req.method === 'GET'  && pathname === '/settings') return json(res, displaySettings);
  if (req.method === 'POST' && pathname === '/settings') {
    return parseBody(req, body => {
      const keys = ['showSeconds','clockColor','bgColor','textColor','chromakey','viewerLayout','clockStyle','viewerFocus','customLayout','elementPositions'];
      for (const k of keys) if (k in body) displaySettings[k] = body[k];
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }
  if (req.method === 'POST' && pathname === '/settings/reset') {
    Object.assign(displaySettings, { showSeconds: true, clockColor: '#00e676', bgColor: '#0a0a0a', textColor: '#ffffff', chromakey: false, viewerLayout: 'auto', clockStyle: 'digital', viewerFocus: 'clock', customLayout: false, elementPositions: { clock: { x: 50, y: 44, scale: 1.0 }, timer: { x: 20, y: 76, scale: 0.9 }, stopwatch: { x: 50, y: 76, scale: 0.9 }, targetTime: { x: 80, y: 76, scale: 0.9 }, message: { x: 50, y: 88, scale: 0.85 } } });
    saveState();
    broadcast(snapshot());
    return noContent(res);
  }

  // NTP time
  if (req.method === 'GET' && pathname === '/time') return json(res, { ts: ntpNow(), ntpSynced });

  // SSE
  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('\n');
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.push(res);
    req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
    return;
  }

  // Timer duration memory
  if (req.method === 'GET'  && pathname === '/timer/duration') return json(res, savedDuration());
  if (req.method === 'POST' && pathname === '/timer/duration') {
    return parseBody(req, body => {
      const mins = Math.max(0, parseInt(body.mins) || 0);
      const secs = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
      lastDuration = { mins, secs, savedAt: Date.now() };
      noContent(res);
    });
  }

  // Timer control
  if (req.method === 'POST' && pathname === '/timer/start') {
    return parseBody(req, body => {
      const mins     = Math.max(0, parseInt(body.mins) || 0);
      const secs     = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
      const duration = (mins * 60 + secs) * 1000;
      if (duration > 0) {
        clearExpiredTimeout();
        if (body.label  !== undefined) timer.label  = String(body.label).slice(0, 60);
        if (body.warnAt !== undefined) timer.warnAt = Math.max(0, parseInt(body.warnAt) || 0) * 1000;
        timer.mode = 'running'; timer.remaining = duration; timer.endAt = Date.now() + duration;
        broadcast(snapshot());
      }
      noContent(res);
    });
  }

  if (req.method === 'POST' && pathname === '/timer/pause') {
    if (timer.mode === 'running') {
      timer.remaining = Math.max(0, timer.endAt - Date.now());
      timer.mode = 'paused'; timer.endAt = null;
      broadcast(snapshot());
    }
    return noContent(res);
  }

  if (req.method === 'POST' && pathname === '/timer/resume') {
    if (timer.mode === 'paused') {
      timer.endAt = Date.now() + timer.remaining;
      timer.mode  = 'running';
      broadcast(snapshot());
    }
    return noContent(res);
  }

  if (req.method === 'POST' && pathname === '/timer/reset') {
    return parseBody(req, body => {
      const mins = Math.max(0, parseInt(body.mins) || 0);
      const secs = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
      clearExpiredTimeout();
      timer.mode = 'idle'; timer.remaining = (mins * 60 + secs) * 1000; timer.endAt = null;
      broadcast(snapshot());
      noContent(res);
    });
  }

  if (req.method === 'POST' && pathname === '/timer/config') {
    return parseBody(req, body => {
      if (body.label  !== undefined) timer.label  = String(body.label).slice(0, 60);
      if (body.warnAt !== undefined) timer.warnAt = Math.max(0, parseInt(body.warnAt) || 0) * 1000;
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Stopwatch
  if (req.method === 'POST' && pathname === '/stopwatch/start') {
    return parseBody(req, body => {
      if (body.label !== undefined) stopwatch.label = String(body.label).slice(0, 60);
      if (stopwatch.mode === 'idle' || stopwatch.mode === 'paused') {
        stopwatch.startedAt = Date.now();
        stopwatch.mode      = 'running';
        broadcast(snapshot());
      }
      noContent(res);
    });
  }

  if (req.method === 'POST' && pathname === '/stopwatch/pause') {
    if (stopwatch.mode === 'running') {
      stopwatch.elapsed  += Date.now() - stopwatch.startedAt;
      stopwatch.startedAt = null;
      stopwatch.mode      = 'paused';
      broadcast(snapshot());
    }
    return noContent(res);
  }

  if (req.method === 'POST' && pathname === '/stopwatch/reset') {
    stopwatch.mode = 'idle'; stopwatch.elapsed = 0; stopwatch.startedAt = null;
    broadcast(snapshot());
    return noContent(res);
  }

  if (req.method === 'POST' && pathname === '/stopwatch/config') {
    return parseBody(req, body => {
      if (body.label !== undefined) stopwatch.label = String(body.label).slice(0, 60);
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Target time
  if (req.method === 'POST' && pathname === '/target-time') {
    return parseBody(req, body => {
      if (body.target  !== undefined) targetTime.target  = String(body.target).slice(0, 5);
      if (body.label   !== undefined) targetTime.label   = String(body.label).slice(0, 60);
      if (body.enabled !== undefined) targetTime.enabled = !!body.enabled;
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Message / cue
  if (req.method === 'POST' && pathname === '/message') {
    return parseBody(req, body => {
      if (body.text    !== undefined) message.text    = String(body.text).slice(0, 200);
      if (body.visible !== undefined) message.visible = !!body.visible;
      if (body.flash   !== undefined) {
        message.flash = !!body.flash;
        if (message.flash) {
          message.visible = true;
          if (flashTimeout) clearTimeout(flashTimeout);
          flashTimeout = setTimeout(() => {
            message.flash = false;
            broadcast(snapshot());
          }, 3000);
        }
      }
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Widget visibility (operator toggles)
  if (req.method === 'POST' && pathname === '/show') {
    return parseBody(req, body => {
      for (const k of ['clock', 'timer', 'stopwatch', 'targetTime', 'message']) {
        if (body[k] !== undefined) show[k] = !!body[k];
      }
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Serve HTML
  if (req.method === 'GET' && (pathname === '/' || pathname === '/operator')) {
    fs.readFile(path.join(__dirname, 'studio-clock.html'), (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => console.log(`Studio clock running on port ${PORT}`));
