/* ── MOTI Display JS ── */
let state = { lights: {}, spotify: {}, pc: {}, notes: { items: [] }, system: {} };
let progressMs = 0, durationMs = 0, progressTimer = null;
let wsRetryDelay = 1000;

// Arc gauge circumferences
const ARC_C  = 201.1;   // r=32 → 2π×32 ≈ 201.06
const RING_C = 395.8;   // r=63 → 2π×63 ≈ 395.84

// ── WebSocket ───────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen  = () => { wsRetryDelay = 1000; };
  ws.onclose = () => { setTimeout(connectWS, wsRetryDelay); wsRetryDelay = Math.min(wsRetryDelay * 2, 16000); };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.topic === 'full_state') {
      state = msg.data;
      renderAll();
    } else if (msg.topic && msg.data) {
      state[msg.topic] = msg.data;
      render(msg.topic, msg.data);
    }
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

// ── Clock / system ──────────────────────────────────────────────────────────
function renderSystem(d) {
  if (d.time) setText('d-clock', d.time);
  setArcGauge('arc-cpu', 'gauge-cpu-val', d.cpu);
  setArcGauge('arc-ram', 'gauge-ram-val', d.ram);
  setSvgText('core-cpu-label', d.cpu  != null ? 'CPU ' + d.cpu.toFixed(0)  + '%' : 'CPU —');
  setSvgText('core-ram-label', d.ram  != null ? 'RAM ' + d.ram.toFixed(0)  + '%' : 'RAM —');
}

function renderPC(d) {
  setArcGauge('arc-disk', 'gauge-disk-val', d.disk);
  const netUp   = fmtNet(d.net_sent);
  const netDown = fmtNet(d.net_recv);
  setText('d-net-up',   netUp);
  setText('d-net-down', netDown);
}

// ── Arc gauge ───────────────────────────────────────────────────────────────
function setArcGauge(circleId, textId, pct) {
  const circle = document.getElementById(circleId);
  const label  = document.getElementById(textId);
  const val    = pct != null ? Math.max(0, Math.min(100, pct)) : 0;
  if (circle) circle.style.strokeDashoffset = (ARC_C * (1 - val / 100)).toFixed(2);
  if (label)  label.textContent = (pct != null ? val.toFixed(0) : '—') + '%';
}

// ── Lights ──────────────────────────────────────────────────────────────────
function renderLights(lights) {
  const entries = Object.entries(lights || {});
  const container = document.getElementById('d-lights');
  if (!container) return;

  const anyOn        = entries.some(([, v]) => v.on);
  const anyReachable = entries.some(([, v]) => v.reachable);
  setPill('pill-lights', anyReachable);

  if (entries.length === 0) {
    container.innerHTML = '<div style="color:var(--dim);font-size:11px;font-family:var(--mono);padding:4px">No lights<br/>configured</div>';
    return;
  }

  container.innerHTML = entries.map(([id, l]) => `
    <div class="light-card ${l.on ? 'on' : ''}">
      <div class="light-header">
        <span class="light-dot"></span>
        <span class="light-name">${escHtml(l.name || id)}</span>
        <span class="light-status">${l.reachable ? (l.on ? 'ON' : 'OFF') : '<span style="color:var(--red)">OFFLINE</span>'}</span>
      </div>
      <div class="light-bar">
        <div class="light-bar-fill" style="width:${l.on ? (l.brightness || 0) : 0}%"></div>
      </div>
    </div>
  `).join('');

  updateCoreState(lights, state.spotify);
}

// ── Spotify ─────────────────────────────────────────────────────────────────
function renderSpotify(d) {
  setPill('pill-spotify', d.connected);

  const art = document.getElementById('d-album-art');
  if (art) art.innerHTML = d.album_art ? `<img src="${d.album_art}" alt=""/>` : '♪';

  setText('d-track',  d.track  || 'Nothing playing');
  setText('d-artist', d.artist || '—');

  progressMs = d.progress_ms  || 0;
  durationMs = d.duration_ms  || 0;
  updateProgress();

  const volFill = document.getElementById('d-vol-fill');
  if (volFill) volFill.style.width = (d.volume || 0) + '%';
  setText('d-vol-pct', (d.volume || 0) + '%');

  const eq = document.getElementById('eq-bars');
  if (d.playing) {
    eq?.classList.add('eq-active');
    startProgressTick();
  } else {
    eq?.classList.remove('eq-active');
    stopProgressTick();
  }

  updateCoreState(state.lights, d);
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

// ── Notes ticker ─────────────────────────────────────────────────────────────
function renderNotes(d) {
  const el = document.getElementById('d-notes-ticker');
  if (!el) return;
  const items = d.items || [];
  if (items.length === 0) { el.textContent = ''; return; }
  el.textContent = items.map(n => `[ ${n.text} ]`).join('   ·   ');
}

// ── Core state label ─────────────────────────────────────────────────────────
function updateCoreState(lights, sp) {
  const anyOn = Object.values(lights || {}).some(l => l.on);
  let label = 'STANDBY';
  if (sp?.playing)        label = 'AUDIO STREAM ACTIVE';
  else if (sp?.connected) label = 'CONNECTED — IDLE';
  if (anyOn && !sp?.playing)  label = 'AMBIENT MODE';
  if (anyOn && sp?.playing)   label = 'AUDIO STREAM ACTIVE';
  setText('d-char-state', label);
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function setPill(id, active) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('active', !!active);
}
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}
function setSvgText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function fmtMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function fmtNet(bytesPerSec) {
  if (bytesPerSec == null) return '0 B/s';
  if (bytesPerSec < 1024)       return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Local clock tick (fallback until WS sends system.time) ─────────────────
function startClock() {
  const tick = () => {
    const now = new Date();
    const t = now.toLocaleTimeString('en-GB', { hour12: false });
    const d = now.toLocaleDateString('en-GB', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }).toUpperCase();
    const clockEl = document.getElementById('d-clock');
    const dateEl  = document.getElementById('d-date');
    if (clockEl && !state.system?.time) clockEl.textContent = t;
    if (dateEl  && !state.system?.time) dateEl.textContent  = d;
  };
  tick();
  setInterval(tick, 1000);
}

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  startClock();
});
