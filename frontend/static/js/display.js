/* ── MOTI Display ── */
let state = { lights: {}, spotify: {}, pc: {}, notes: { items: [] }, system: {} };
let progressMs = 0, durationMs = 0, progressTimer = null;
let wsRetryDelay = 1000;
let blinkTimer = null;

// ── WebSocket ──────────────────────────────────────────────────────────────
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

// ── System ─────────────────────────────────────────────────────────────────
function renderSystem(d) {
  setText('d-cpu',   d.cpu  != null ? d.cpu.toFixed(0)  + '%' : '—');
  setText('d-ram',   d.ram  != null ? d.ram.toFixed(0)  + '%' : '—');
  if (d.time) setText('d-clock', d.time);
}

function renderPC(d) {
  setText('d-disk', d.disk != null ? d.disk.toFixed(0) + '%' : '—');
}

// ── Lights ─────────────────────────────────────────────────────────────────
function renderLights(lights) {
  const entries = Object.entries(lights || {});
  const container = document.getElementById('d-lights');
  if (!container) return;

  const anyOn       = entries.some(([,v]) => v.on);
  const anyReachable = entries.some(([,v]) => v.reachable);

  // Connection indicator
  const dot = document.getElementById('dc-lights');
  if (dot) {
    dot.className = 'd-conn ' + (anyReachable ? 'online' : 'offline');
  }

  if (entries.length === 0) {
    container.innerHTML = '<div style="color:var(--dim);font-size:12px;font-family:var(--mono)">No lights<br/>configured</div>';
    return;
  }

  container.innerHTML = entries.map(([id, l]) => `
    <div class="d-light-row ${l.on ? 'on' : ''}">
      <span class="d-light-bulb">💡</span>
      <div class="d-light-info">
        <div class="d-light-name">${l.name || id}</div>
        <div class="d-light-meta">
          ${l.reachable
            ? (l.on ? `ON · ${l.brightness}%` : 'OFF')
            : '<span style="color:var(--red)">OFFLINE</span>'}
        </div>
        <div class="d-light-bar-wrap">
          <div class="d-light-bar">
            <div class="d-light-bar-fill" style="width:${l.on ? l.brightness : 0}%"></div>
          </div>
        </div>
      </div>
    </div>
  `).join('');

  // Update chest status dots
  updateChestDots(entries);
  // Character reacts to lights
  updateCharState();
}

function updateChestDots(entries) {
  const dots = document.querySelectorAll('.status-dot');
  dots.forEach((dot, i) => {
    const light = entries[i];
    if (light && light[1].on) {
      dot.classList.add('active');
    } else {
      dot.classList.remove('active');
    }
  });
}

// ── Spotify ────────────────────────────────────────────────────────────────
function renderSpotify(d) {
  const dot = document.getElementById('dc-spotify');
  if (dot) dot.className = 'd-conn ' + (d.connected ? 'online' : 'offline');

  // Album art
  const art = document.getElementById('d-album-art');
  if (art) {
    art.innerHTML = d.album_art ? `<img src="${d.album_art}" alt=""/>` : '♪';
  }

  setText('d-track',  d.track  || 'Nothing playing');
  setText('d-artist', d.artist || '—');

  // Progress
  progressMs  = d.progress_ms  || 0;
  durationMs  = d.duration_ms  || 0;
  updateProgress();

  // Volume
  const volFill = document.getElementById('d-vol-fill');
  if (volFill) volFill.style.width = (d.volume || 0) + '%';
  setText('d-vol-pct', (d.volume || 0) + '%');

  // EQ bars + character dance
  const eq = document.getElementById('eq-bars');
  const wrap = document.getElementById('d-char-wrap');
  if (d.playing) {
    eq?.classList.add('eq-active');
    wrap?.classList.add('dancing');
  } else {
    eq?.classList.remove('eq-active');
    wrap?.classList.remove('dancing');
  }

  // Mouth width reacts: wider when playing
  const mouthInner = document.querySelector('.mouth-inner');
  if (mouthInner) {
    mouthInner.setAttribute('width', d.playing ? '56' : '30');
    mouthInner.setAttribute('x', d.playing ? '52' : '65');
  }

  updateCharState();

  if (d.playing) startProgressTick();
  else stopProgressTick();
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
  const pct = durationMs > 0 ? (progressMs / durationMs) * 100 : 0;
  const fill = document.getElementById('d-progress-fill');
  if (fill) fill.style.width = pct.toFixed(1) + '%';
  setText('d-prog-cur',   fmtMs(progressMs));
  setText('d-prog-total', fmtMs(durationMs));
}

// ── Notes ticker ───────────────────────────────────────────────────────────
function renderNotes(d) {
  const el = document.getElementById('d-notes-ticker');
  if (!el) return;
  const items = d.items || [];
  if (items.length === 0) { el.innerHTML = ''; return; }
  const text = items.map(n => `[ ${n.text} ]`).join('   ·   ');
  el.innerHTML = `<span class="d-ticker-inner">${escHtml(text)}</span>`;
}

// ── Character state label ──────────────────────────────────────────────────
function updateCharState() {
  const sp = state.spotify || {};
  const lights = state.lights || {};
  const anyOn = Object.values(lights).some(l => l.on);

  let label = 'STANDBY';
  if (sp.playing)       label = 'VIBING 🎵';
  else if (sp.connected) label = 'LISTENING';
  if (anyOn && !sp.playing) label = 'AMBIENT';
  if (anyOn && sp.playing)  label = 'VIBING 🎵';

  setText('d-char-state', label);
}

// ── Eye blink ──────────────────────────────────────────────────────────────
function startBlink() {
  function blink() {
    const eyes = document.querySelectorAll('.eye-inner');
    eyes.forEach(e => e.classList.add('blink'));
    setTimeout(() => eyes.forEach(e => e.classList.remove('blink')), 120);
    // Schedule next blink (random 2-6 seconds)
    blinkTimer = setTimeout(blink, 2000 + Math.random() * 4000);
  }
  blinkTimer = setTimeout(blink, 1500);
}

// ── Utilities ──────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}
function fmtMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  startBlink();
});
