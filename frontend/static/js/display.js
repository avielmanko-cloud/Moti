/* ── MOTI Display ── */
let state = { lights: {}, spotify: {}, pc: {}, notes: { items: [] }, system: {} };
let progressMs = 0, durationMs = 0, progressTimer = null;
let wsRetryDelay = 1000;

const ARC_C  = 175.9;  // 2π × r28
const RING_C = 339.3;  // 2π × r54

// ── Default widget positions (for 1920×1080, adjust via drag) ─────────────
const DEFAULTS = {
  lights:  { left: 24,  top: 24 },
  spotify: { right: 24, top: 24 },
  pc:      { left: 24,  bottom: 24 },
  notes:   { right: 24, bottom: 24 },
};

// ── WebSocket ─────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen  = () => { wsRetryDelay = 1000; };
  ws.onclose = () => { setTimeout(connectWS, wsRetryDelay); wsRetryDelay = Math.min(wsRetryDelay * 2, 16000); };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.topic === 'full_state') { state = msg.data; renderAll(); }
    else if (msg.topic && msg.data) { state[msg.topic] = msg.data; render(msg.topic, msg.data); }
  };
}

function renderAll() {
  render('lights',  state.lights);
  render('spotify', state.spotify);
  render('pc',      state.pc);
  render('notes',   state.notes);
  render('system',  state.system);
}

function render(topic, data) {
  switch (topic) {
    case 'lights':  renderLights(data);  break;
    case 'spotify': renderSpotify(data); break;
    case 'pc':      renderPC(data);      break;
    case 'notes':   renderNotes(data);   break;
    case 'system':  renderSystem(data);  break;
  }
}

// ── System ────────────────────────────────────────────────────────────────
function renderSystem(d) {
  if (d.time) setText('d-clock', d.time);
  setArc('arc-cpu', 'gauge-cpu-val', d.cpu);
  setArc('arc-ram', 'gauge-ram-val', d.ram);
}

function renderPC(d) {
  setArc('arc-disk', 'gauge-disk-val', d.disk);
  setText('d-net-up',   fmtNet(d.net_sent));
  setText('d-net-down', fmtNet(d.net_recv));
}

function setArc(circleId, textId, pct) {
  const v = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  const el = document.getElementById(circleId);
  const tx = document.getElementById(textId);
  if (el) el.style.strokeDashoffset = (ARC_C * (1 - v / 100)).toFixed(2);
  if (tx) tx.textContent = (pct != null ? v.toFixed(0) : '—') + '%';
}

// ── Lights ────────────────────────────────────────────────────────────────
function renderLights(lights) {
  const entries = Object.entries(lights || {});
  const container = document.getElementById('d-lights');
  if (!container) return;

  setPill('pill-lights', entries.some(([, v]) => v.reachable));

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-msg">No lights configured</div>';
    return;
  }

  container.innerHTML = entries.map(([id, l]) => `
    <div class="light-card ${l.on ? 'on' : ''}">
      <span class="light-led"></span>
      <div class="light-info">
        <div class="light-name">${escHtml(l.name || id)}</div>
        <div class="light-meta">${
          l.reachable
            ? (l.on ? `ON · ${l.brightness ?? 0}%` : 'OFF')
            : '<span style="color:var(--red)">OFFLINE</span>'
        }</div>
        <div class="light-bar"><div class="light-bar-fill" style="width:${l.on ? (l.brightness ?? 0) : 0}%"></div></div>
      </div>
    </div>
  `).join('');
}

// ── Spotify ───────────────────────────────────────────────────────────────
function renderSpotify(d) {
  setPill('pill-spotify', d.connected);

  const art = document.getElementById('d-album-art');
  if (art) art.innerHTML = d.album_art ? `<img src="${d.album_art}" alt=""/>` : '♪';

  setText('d-track',  d.track  || 'Nothing playing');
  setText('d-artist', d.artist || '—');

  progressMs = d.progress_ms || 0;
  durationMs = d.duration_ms || 0;
  updateProgress();

  const vol = document.getElementById('d-vol-fill');
  if (vol) vol.style.width = (d.volume || 0) + '%';
  setText('d-vol-pct', (d.volume || 0) + '%');

  const eq = document.getElementById('eq-bars');
  if (d.playing) {
    eq?.classList.add('eq-active');
    startProgressTick();
  } else {
    eq?.classList.remove('eq-active');
    stopProgressTick();
  }
}

function startProgressTick() {
  stopProgressTick();
  progressTimer = setInterval(() => {
    progressMs = Math.min(progressMs + 1000, durationMs);
    updateProgress();
  }, 1000);
}

function stopProgressTick() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function updateProgress() {
  const pct = durationMs > 0 ? progressMs / durationMs : 0;
  const ring = document.getElementById('sp-ring');
  if (ring) ring.style.strokeDashoffset = (RING_C * (1 - pct)).toFixed(2);
  setText('d-prog-cur',   fmtMs(progressMs));
  setText('d-prog-total', fmtMs(durationMs));
}

// ── Notes ─────────────────────────────────────────────────────────────────
function renderNotes(d) {
  const el = document.getElementById('d-notes');
  if (!el) return;
  const items = d.items || [];
  if (items.length === 0) {
    el.innerHTML = '<div class="empty-msg">No notes</div>';
    return;
  }
  el.innerHTML = items.map(n => `
    <div class="note-item">
      ${escHtml(n.text)}
      <div class="note-ts">${n.created_at ? n.created_at.slice(0,16).replace('T','  ') : ''}</div>
    </div>
  `).join('');
}

// ── Drag logic ────────────────────────────────────────────────────────────
function initDrag() {
  document.querySelectorAll('.widget').forEach(w => {
    const bar = w.querySelector('.widget-bar');
    if (!bar) return;
    let ox, oy, ol, ot;

    bar.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      ox = e.clientX;
      oy = e.clientY;
      ol = w.offsetLeft;
      ot = w.offsetTop;
      w.classList.add('dragging');
      w.style.zIndex = Date.now();

      const onMove = e => {
        const nx = ol + (e.clientX - ox);
        const ny = ot + (e.clientY - oy);
        w.style.left = clamp(nx, 0, window.innerWidth  - w.offsetWidth)  + 'px';
        w.style.top  = clamp(ny, 0, window.innerHeight - w.offsetHeight - 50) + 'px';
        w.style.right  = 'auto';
        w.style.bottom = 'auto';
      };
      const onUp = () => {
        w.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        savePositions();
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  });
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function savePositions() {
  const pos = {};
  document.querySelectorAll('.widget').forEach(w => {
    pos[w.dataset.wid] = { left: w.style.left, top: w.style.top };
  });
  try { localStorage.setItem('moti-wpos', JSON.stringify(pos)); } catch(e) {}
}

function loadPositions() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('moti-wpos') || '{}'); } catch(e) {}

  const cw = window.innerWidth;
  const ch = window.innerHeight - 50;

  document.querySelectorAll('.widget').forEach(w => {
    const id = w.dataset.wid;
    const s  = saved[id];
    const d  = DEFAULTS[id] || { left: 20, top: 20 };

    if (s?.left && s?.top) {
      w.style.left = s.left;
      w.style.top  = s.top;
    } else if (d.right != null) {
      w.style.left = (cw - (w.offsetWidth || 240) - d.right) + 'px';
      w.style.top  = (d.bottom != null ? ch - (w.offsetHeight || 200) - d.bottom : d.top) + 'px';
    } else if (d.bottom != null) {
      w.style.left = d.left + 'px';
      w.style.top  = (ch - (w.offsetHeight || 180) - d.bottom) + 'px';
    } else {
      w.style.left = d.left + 'px';
      w.style.top  = d.top  + 'px';
    }
  });
}

// ── Clock ─────────────────────────────────────────────────────────────────
function startClock() {
  const tick = () => {
    if (state.system?.time) return;
    const now = new Date();
    setText('d-clock', now.toLocaleTimeString('en-GB', { hour12: false }));
    setText('d-date',  now.toLocaleDateString('en-GB', {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric'
    }).toUpperCase());
  };
  tick();
  setInterval(tick, 1000);
}

// ── Utilities ─────────────────────────────────────────────────────────────
function setPill(id, active) {
  document.getElementById(id)?.classList.toggle('active', !!active);
}
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}
function fmtMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtNet(b) {
  if (b == null || b === 0) return '0 B/s';
  if (b < 1024)        return b.toFixed(0)          + ' B/s';
  if (b < 1048576)     return (b / 1024).toFixed(1) + ' KB/s';
  return (b / 1048576).toFixed(1) + ' MB/s';
}
function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadPositions();
  initDrag();
  connectWS();
  startClock();
});
