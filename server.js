const http  = require('http');
const dgram = require('dgram');
const fs    = require('fs');
const path  = require('path');
const PORT  = process.env.PORT || 7823;

// ── NTP Sync ───────────────────────────────────────────────────────────────
const NTP_SERVERS      = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org'];
const NTP_PORT         = 123;
const NTP_DELTA        = 2208988800;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let ntpOffset = 0;
let ntpSynced = false;
function ntpNow() { return Date.now() + ntpOffset; }

// ms until the next whole wall-clock second, so timers/stopwatches can be
// kicked off exactly on a second boundary — same boundary the digital clock
// ticks over on for every connected viewer — instead of at an arbitrary
// mid-second offset determined by click timing.
function msUntilNextSecond() { return (1000 - (ntpNow() % 1000)) % 1000; }

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

// Each slot is a generic widget that can act as a countdown timer, a stopwatch,
// or a target-time display. Fields for the inactive types are simply unused —
// this lets a slot remember its timer config even while set to stopwatch, etc.
const SLOT_IDS      = ['slot1', 'slot2', 'slot3'];
const SLOT_DEFAULTS = { slot1: 'timer', slot2: 'stopwatch', slot3: 'targetTime' };

const slots = SLOT_IDS.map(id => ({
  id,
  type: SLOT_DEFAULTS[id],
  label: '',

  // Shared run state (timer + stopwatch)
  mode: 'idle',           // idle | running | paused | expired

  // Timer fields
  remaining:      0,      // ms remaining when not running
  endAt:          null,   // absolute ms target when running
  warnAt:         60000,  // ms — close-warn threshold (red)
  warnAtEnabled:  true,
  warn2At:        300000, // ms — early-warn threshold (orange)
  warn2AtEnabled: true,

  // Stopwatch fields
  startedAt: null,        // Date.now() when last started/resumed
  elapsed:   0,           // ms accumulated before current run

  // Target-time fields
  target:  '',            // HH:MM (24h)
  enabled: false,
}));

function getSlot(id) { return slots.find(s => s.id === id); }

const message = {
  text: '',
  visible: false,
  flash: false,
  shownAt: null,
};

// Which widgets are shown on display pages (operator controls)
const show = {
  clock: true,
  slot1: false,
  slot2: false,
  slot3: false,
  message: false,
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
  customLayout:     true,
  slotColors: {
    slot1: '#ffd600',
    slot2: '#4fc3f7',
    slot3: '#ffffff',
  },
  messageColor:     '#ffffff',
  elementPositions: {
    clock:   { x: 50, y: 21, scale: 1.5 },
    slot1:   { x: 16, y: 50, scale: 0.7 },
    slot2:   { x: 50, y: 50, scale: 0.7 },
    slot3:   { x: 84, y: 50, scale: 0.7 },
    message: { x: 50, y: 80, scale: 1.0, width: 100, height: 40 },
  },
};

const RESET_ELEMENT_POSITIONS = {
  clock:   { x: 50, y: 44, scale: 1.0 },
  slot1:   { x: 20, y: 76, scale: 0.9 },
  slot2:   { x: 50, y: 76, scale: 0.9 },
  slot3:   { x: 80, y: 76, scale: 0.9 },
  message: { x: 50, y: 88, scale: 0.85 },
};
const RESET_SLOT_COLORS = { slot1: '#ffd600', slot2: '#4fc3f7', slot3: '#ffffff' };

let flashTimeout = null;
const expiredTimeouts = new Map(); // slot id -> Timeout
const pendingStartTimeouts = new Map(); // slot id -> Timeout, aligned start/resume awaiting the next second boundary

function clearPendingStart(id) {
  if (pendingStartTimeouts.has(id)) { clearTimeout(pendingStartTimeouts.get(id)); pendingStartTimeouts.delete(id); }
}

// ── SSE broadcast ─────────────────────────────────────────────────────────
let sseClients = [];

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

function snapshot() {
  return {
    slots: slots.map(s => ({
      id:             s.id,
      type:           s.type,
      label:          s.label,
      mode:           s.mode,
      remaining:      s.mode === 'running' && s.type === 'timer' ? Math.max(0, s.endAt - Date.now()) : s.remaining,
      warnAt:         s.warnAt,
      warnAtEnabled:  s.warnAtEnabled,
      warn2At:        s.warn2At,
      warn2AtEnabled: s.warn2AtEnabled,
      elapsed:        s.mode === 'running' && s.type === 'stopwatch' ? s.elapsed + (Date.now() - s.startedAt) : s.elapsed,
      target:         s.target,
      enabled:        s.enabled,
    })),
    message: { text: message.text, visible: message.visible, flash: message.flash, shownAt: message.shownAt },
    show:    { ...show },
    displaySettings: { ...displaySettings },
  };
}

// ── Timer expiry ──────────────────────────────────────────────────────────
setInterval(() => {
  for (const s of slots) {
    if (s.type !== 'timer' || s.mode !== 'running') continue;
    if (Date.now() >= s.endAt) {
      s.mode      = 'expired';
      s.remaining = 0;
      s.endAt     = null;
      broadcast(snapshot());
      clearExpiredTimeout(s.id);
      expiredTimeouts.set(s.id, setTimeout(() => {
        s.mode      = 'idle';
        s.remaining = 0;
        expiredTimeouts.delete(s.id);
        broadcast(snapshot());
      }, 30000));
    }
  }
}, 250);

function clearExpiredTimeout(id) {
  if (expiredTimeouts.has(id)) { clearTimeout(expiredTimeouts.get(id)); expiredTimeouts.delete(id); }
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

    if (saved.displaySettings) {
      const ds = saved.displaySettings;
      Object.assign(displaySettings, ds);
      // Legacy per-widget colors → slotColors
      if (!ds.slotColors && (ds.timerColor || ds.stopwatchColor || ds.targetColor)) {
        displaySettings.slotColors = {
          slot1: ds.timerColor     || RESET_SLOT_COLORS.slot1,
          slot2: ds.stopwatchColor || RESET_SLOT_COLORS.slot2,
          slot3: ds.targetColor    || RESET_SLOT_COLORS.slot3,
        };
      }
      // Legacy elementPositions keys → slot1/2/3
      const ep = ds.elementPositions;
      if (ep && (ep.timer || ep.stopwatch || ep.targetTime)) {
        displaySettings.elementPositions = {
          clock:   ep.clock   || displaySettings.elementPositions.clock,
          slot1:   ep.timer      || displaySettings.elementPositions.slot1,
          slot2:   ep.stopwatch  || displaySettings.elementPositions.slot2,
          slot3:   ep.targetTime || displaySettings.elementPositions.slot3,
          message: ep.message || displaySettings.elementPositions.message,
        };
      }
      // Drop legacy keys so they don't linger in the persisted file
      delete displaySettings.timerColor;
      delete displaySettings.stopwatchColor;
      delete displaySettings.targetColor;
    }

    if (saved.slots) {
      // Current format
      for (const s of saved.slots) {
        const slot = getSlot(s.id);
        if (slot) Object.assign(slot, s, { mode: 'idle', endAt: null, startedAt: null });
      }
    } else {
      // Legacy format: single timer/stopwatch/targetTime → slot1/slot2/slot3
      const t = getSlot('slot1'), sw = getSlot('slot2'), tt = getSlot('slot3');
      if (saved.timerLabel          !== undefined) t.label          = saved.timerLabel;
      if (saved.timerWarnAt         !== undefined) t.warnAt         = saved.timerWarnAt;
      if (saved.timerWarnAtEnabled  !== undefined) t.warnAtEnabled  = saved.timerWarnAtEnabled;
      if (saved.timerWarn2At        !== undefined) t.warn2At        = saved.timerWarn2At;
      if (saved.timerWarn2AtEnabled !== undefined) t.warn2AtEnabled = saved.timerWarn2AtEnabled;
      if (saved.swLabel !== undefined) sw.label = saved.swLabel;
      if (saved.targetTime) { tt.target = saved.targetTime.target || ''; tt.label = saved.targetTime.label || ''; tt.enabled = !!saved.targetTime.enabled; }
    }

    if (saved.message) Object.assign(message, { text: saved.message.text || '', visible: false, flash: false });

    if (saved.show) {
      const sh = saved.show;
      if ('slot1' in sh || 'slot2' in sh || 'slot3' in sh) {
        Object.assign(show, sh);
      } else {
        // Legacy show keys
        show.clock = sh.clock !== false;
        if (sh.timer      !== undefined) show.slot1 = sh.timer;
        if (sh.stopwatch  !== undefined) show.slot2 = sh.stopwatch;
        if (sh.targetTime !== undefined) show.slot3 = sh.targetTime;
        if (sh.message    !== undefined) show.message = sh.message;
      }
    }

    console.log('Loaded persistent state');
  } catch {}
}

function saveState() {
  const data = {
    displaySettings: { ...displaySettings },
    slots: slots.map(s => ({
      id: s.id, type: s.type, label: s.label,
      warnAt: s.warnAt, warnAtEnabled: s.warnAtEnabled,
      warn2At: s.warn2At, warn2AtEnabled: s.warn2AtEnabled,
      target: s.target, enabled: s.enabled,
    })),
    message: { text: message.text },
    show:    { ...show },
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

// ── Slot action handlers ────────────────────────────────────────────────────
function slotStart(slot, body) {
  if (slot.type === 'timer') {
    const mins     = Math.max(0, parseInt(body.mins) || 0);
    const secs     = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
    const duration = (mins * 60 + secs) * 1000;
    if (duration <= 0) return;
    clearExpiredTimeout(slot.id);
    applyTimerConfig(slot, body);
    slot.mode = 'running'; slot.remaining = duration; slot.endAt = Date.now() + duration;
  } else if (slot.type === 'stopwatch') {
    if (body.label !== undefined) slot.label = String(body.label).slice(0, 60);
    if (slot.mode === 'idle' || slot.mode === 'paused') {
      slot.startedAt = Date.now();
      slot.mode      = 'running';
    }
  }
}

function slotPause(slot) {
  if (slot.type === 'timer' && slot.mode === 'running') {
    slot.remaining = Math.max(0, slot.endAt - Date.now());
    slot.mode = 'paused'; slot.endAt = null;
  } else if (slot.type === 'stopwatch' && slot.mode === 'running') {
    slot.elapsed  += Date.now() - slot.startedAt;
    slot.startedAt = null;
    slot.mode      = 'paused';
  }
}

function slotResume(slot) {
  if (slot.type === 'timer' && slot.mode === 'paused') {
    slot.endAt = Date.now() + slot.remaining;
    slot.mode  = 'running';
  } else if (slot.type === 'stopwatch' && (slot.mode === 'idle' || slot.mode === 'paused')) {
    slot.startedAt = Date.now();
    slot.mode      = 'running';
  }
}

function slotReset(slot, body) {
  clearExpiredTimeout(slot.id);
  if (slot.type === 'timer') {
    const mins = Math.max(0, parseInt(body.mins) || 0);
    const secs = Math.max(0, Math.min(59, parseInt(body.secs) || 0));
    slot.mode = 'idle'; slot.remaining = (mins * 60 + secs) * 1000; slot.endAt = null;
  } else if (slot.type === 'stopwatch') {
    slot.mode = 'idle'; slot.elapsed = 0; slot.startedAt = null;
  }
}

function applyTimerConfig(slot, body) {
  if (body.label          !== undefined) slot.label          = String(body.label).slice(0, 60);
  if (body.warnAt         !== undefined) slot.warnAt         = Math.max(0, parseInt(body.warnAt) || 0) * 1000;
  if (body.warnAtEnabled  !== undefined) slot.warnAtEnabled  = !!body.warnAtEnabled;
  if (body.warn2At        !== undefined) slot.warn2At        = Math.max(0, parseInt(body.warn2At) || 0) * 1000;
  if (body.warn2AtEnabled !== undefined) slot.warn2AtEnabled = !!body.warn2AtEnabled;
}

function slotConfig(slot, body) {
  if (body.label !== undefined) slot.label = String(body.label).slice(0, 60);
  if (slot.type === 'timer') applyTimerConfig(slot, body);
  if (slot.type === 'targetTime') {
    if (body.target  !== undefined) slot.target  = String(body.target).slice(0, 5);
    if (body.enabled !== undefined) slot.enabled = !!body.enabled;
  }
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
      const keys = ['showSeconds','clockColor','bgColor','textColor','chromakey','viewerLayout','clockStyle','customLayout','slotColors','messageColor','messageLineHeight','elementPositions'];
      for (const k of keys) if (k in body) displaySettings[k] = body[k];
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }
  if (req.method === 'POST' && pathname === '/settings/reset') {
    Object.assign(displaySettings, {
      showSeconds: true, clockColor: '#00e676', bgColor: '#0a0a0a', textColor: '#ffffff',
      chromakey: false, viewerLayout: 'auto', clockStyle: 'digital', customLayout: false,
      slotColors: { ...RESET_SLOT_COLORS }, messageColor: '#ffffff',
      elementPositions: JSON.parse(JSON.stringify(RESET_ELEMENT_POSITIONS)),
    });
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

  // Slot control: /slots/:id/(type|start|pause|resume|reset|config)
  const slotMatch = pathname.match(/^\/slots\/(slot[123])\/(type|start|pause|resume|reset|config)$/);
  if (slotMatch && req.method === 'POST') {
    const [, id, action] = slotMatch;
    const slot = getSlot(id);
    return parseBody(req, body => {
      if (action === 'start' || action === 'resume') {
        // Align the actual start to the next whole second so the countdown/
        // count-up ticks over in sync with the clock and other slots, rather
        // than at whatever mid-second instant the button was clicked.
        clearPendingStart(slot.id);
        pendingStartTimeouts.set(slot.id, setTimeout(() => {
          pendingStartTimeouts.delete(slot.id);
          if (action === 'start') slotStart(slot, body); else slotResume(slot);
          saveState();
          broadcast(snapshot());
        }, msUntilNextSecond()));
        return noContent(res);
      }

      switch (action) {
        case 'type':
          clearPendingStart(slot.id);
          if (['timer', 'stopwatch', 'targetTime'].includes(body.type)) {
            clearExpiredTimeout(slot.id);
            slot.type = body.type;
            slot.mode = 'idle'; slot.endAt = null; slot.startedAt = null;
          }
          break;
        case 'pause':   clearPendingStart(slot.id); slotPause(slot);        break;
        case 'reset':   clearPendingStart(slot.id); slotReset(slot, body);  break;
        case 'config':  slotConfig(slot, body); break;
      }
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Message / cue
  if (req.method === 'POST' && pathname === '/message') {
    return parseBody(req, body => {
      const wasVisible = message.visible;
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
      if (message.visible && !wasVisible) message.shownAt = ntpNow();
      if (!message.visible) message.shownAt = null;
      saveState();
      broadcast(snapshot());
      noContent(res);
    });
  }

  // Widget visibility (operator toggles)
  if (req.method === 'POST' && pathname === '/show') {
    return parseBody(req, body => {
      for (const k of ['clock', 'slot1', 'slot2', 'slot3', 'message']) {
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
