/* ── MOTI control panel ── */
let state = { lights: {}, spotify: {}, pc: {}, notes: { items: [] }, system: {} };
let progressTimer = null;
let wsRetryDelay  = 1000;
const cpuHistory  = [];

// ── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    wsRetryDelay = 1000;
    setWsDot(true);
  };
  ws.onclose = () => {
    setWsDot(false);
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 16000);
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.topic === 'full_state') { state = msg.data; renderAll(); }
    else if (msg.topic && msg.data) { state[msg.topic] = msg.data; render(msg.topic, msg.data); }
  };
}
function setWsDot(on) {
  const d = document.getElementById('dot-ws');
  if (d) d.className = 'conn-dot ' + (on ? 'on' : 'off');
}

// ── API ───────────────────────────────────────────────────────────────────────
async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  } catch (err) {
    toast(err.message || 'Request failed', 'error');
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(el) {
  if (!el || !el.dataset) return;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('panel-' + el.dataset.panel)?.classList.add('active');
}

// ── Render dispatch ───────────────────────────────────────────────────────────
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

// ── System ────────────────────────────────────────────────────────────────────
function renderSystem(d) {
  setText('sys-cpu',  d.cpu  != null ? d.cpu.toFixed(0) + '%' : '—');
  setText('sys-ram',  d.ram  != null ? d.ram.toFixed(0) + '%' : '—');
  if (d.time) setText('clock', d.time);
}

// ── PC Stats ──────────────────────────────────────────────────────────────────
function renderPC(d) {
  setText('sys-disk', d.disk != null ? d.disk.toFixed(0) + '%' : '—');
  setText('sys-up',   d.net_sent != null ? d.net_sent + 'K' : '—');
  setText('sys-down', d.net_recv != null ? d.net_recv + 'K' : '—');

  // PC panel
  const set = (id, bar, val) => {
    setText(id, val != null ? val.toFixed(0) + '%' : '—');
    const b = document.getElementById(bar);
    if (b) {
      b.style.width = (val || 0) + '%';
      b.className = 'battery-fill' + (val > 90 ? ' low' : val > 70 ? ' warn' : '');
    }
  };
  set('pc-cpu',  'pc-cpu-bar',  d.cpu);
  set('pc-ram',  'pc-ram-bar',  d.ram);
  set('pc-disk', 'pc-disk-bar', d.disk);
  setText('pc-net', `↑${d.net_sent ?? 0} KB/s  ↓${d.net_recv ?? 0} KB/s`);
  setText('dash-cpu', d.cpu  != null ? d.cpu.toFixed(0) + '%' : '—');
  setText('dash-ram', d.ram  != null ? '  RAM ' + d.ram.toFixed(0) + '%' : '—');

  // CPU history chart
  if (d.cpu != null) {
    cpuHistory.push(d.cpu);
    if (cpuHistory.length > 40) cpuHistory.shift();
    renderCpuChart();
  }
}

function renderCpuChart() {
  const container = document.getElementById('cpu-history');
  if (!container) return;
  const max = Math.max(...cpuHistory, 10);
  container.innerHTML = cpuHistory.map(v => {
    const h = Math.max(4, (v / max) * 76);
    const color = v > 80 ? 'var(--red)' : v > 60 ? 'var(--yellow)' : 'var(--accent)';
    return `<div style="flex:1;height:${h}px;background:${color};border-radius:2px 2px 0 0;min-width:3px;opacity:0.8;transition:height 0.3s"></div>`;
  }).join('');
}

// ── Lights ────────────────────────────────────────────────────────────────────
function renderLights(lights) {
  const entries = Object.entries(lights || {});
  const anyReachable = entries.some(([,v]) => v.reachable);
  document.getElementById('dot-xiaomi').className = 'conn-dot ' + (anyReachable ? 'on' : 'off');

  renderLightList('dash-lights',  entries, true);
  renderLightList('lights-list',  entries, false);

  const empty = document.getElementById('lights-empty');
  if (empty) empty.style.display = entries.length === 0 ? 'block' : 'none';

  const onCount = entries.filter(([,v]) => v.on).length;
  setText('dash-lights-count', entries.length ? `${onCount}/${entries.length}` : '—');
  setText('dash-lights-sub',   entries.length ? `${onCount} light(s) on` : 'No devices');
}

function renderLightList(id, entries, compact) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px 0">No lights configured.</div>';
    return;
  }
  el.innerHTML = entries.map(([id, l]) => lightRowHTML(id, l, compact)).join('');
}

function lightRowHTML(id, l, compact) {
  const kColor = kelvinToHex(l.color_temp || 4000);
  return `
  <div class="light-row ${l.on ? 'active' : ''}" id="lr-${id}">
    <div class="light-icon">💡</div>
    <div class="light-info">
      <div class="light-name">${l.name || id}</div>
      <div class="light-meta">
        ${l.reachable
          ? `<span style="color:var(--green)">●</span> ONLINE${l.on ? ` · ${l.brightness}% · ${l.color_temp}K` : ''}`
          : `<span style="color:var(--red)">●</span> OFFLINE`}
      </div>
    </div>
    <div class="light-controls">
      ${!compact ? `
        <div class="kelvin-display" style="background:${kColor}" title="${l.color_temp}K"></div>
        <div class="slider-wrap">
          <span class="slider-label">BRIGHT</span>
          <input type="range" min="1" max="100" value="${l.brightness || 100}"
            oninput="api('POST','/api/lights/${id}/brightness',{value:+this.value})"/>
        </div>
        <div class="slider-wrap">
          <span class="slider-label">TEMP</span>
          <input type="range" min="1700" max="6500" value="${l.color_temp || 4000}"
            oninput="api('POST','/api/lights/${id}/color_temp',{kelvin:+this.value})"/>
        </div>
      ` : ''}
      <label class="toggle">
        <input type="checkbox" ${l.on ? 'checked' : ''}
          onchange="api('POST','/api/lights/${id}/power',{on:this.checked})"/>
        <span class="toggle-slider"></span>
      </label>
    </div>
  </div>`;
}

function allLights(on) {
  Object.keys(state.lights || {}).forEach(id => api('POST', `/api/lights/${id}/power`, { on }));
}

// ── Spotify ───────────────────────────────────────────────────────────────────
function renderSpotify(d) {
  document.getElementById('dot-spotify').className = 'conn-dot ' + (d.connected ? 'on' : 'off');

  setAlbumArt('sp-album-art',   d.album_art);
  setAlbumArt('dash-album-art', d.album_art);
  setText('sp-track-name',    d.track  || 'Nothing playing');
  setText('sp-track-artist',  d.artist || '—');
  setText('dash-track-name',  d.track  || 'Nothing playing');
  setText('dash-track-artist',d.artist || '—');

  setPlayBtn('sp-play-btn',   d.playing);
  setPlayBtn('dash-play-btn', d.playing);

  const indicator = document.getElementById('dash-playing-indicator');
  if (indicator) indicator.style.display = d.playing ? 'block' : 'none';

  ['sp-shuffle-btn','dash-shuffle-btn'].forEach(id => {
    document.getElementById(id)?.classList.toggle('active', !!d.shuffle);
  });

  const rb = document.getElementById('sp-repeat-btn');
  if (rb) {
    rb.classList.toggle('active', d.repeat !== 'off');
    rb.textContent = d.repeat === 'track' ? '↺¹' : '↻';
  }

  const vol = document.getElementById('sp-volume');
  if (vol && document.activeElement !== vol) vol.value = d.volume || 50;
  setText('sp-vol-label', (d.volume || 50) + '%');

  const pct = d.duration_ms > 0 ? (d.progress_ms / d.duration_ms) * 100 : 0;
  setStyle('sp-progress-fill',   'width', pct.toFixed(1) + '%');
  setStyle('dash-progress-fill', 'width', pct.toFixed(1) + '%');
  setText('sp-progress-time',   fmtMs(d.progress_ms));
  setText('dash-progress-time', fmtMs(d.progress_ms));
  setText('sp-duration-time',   fmtMs(d.duration_ms));
  setText('dash-duration-time', fmtMs(d.duration_ms));

  setText('dash-spotify-state', d.playing ? 'LIVE' : (d.connected ? 'PAUSED' : 'OFF'));
  setText('dash-spotify-track', d.track ? `${d.track} — ${d.artist}` : 'Not connected');
  const sv = document.getElementById('dash-spotify-state');
  if (sv) sv.style.color = d.playing ? 'var(--green)' : '';

  const authBtn = document.getElementById('spotify-auth-btn');
  if (authBtn) authBtn.style.display = d.connected ? 'none' : '';

  if (d.playing) startProgressTick(d);
  else stopProgressTick();
}

let _pMs = 0, _dMs = 0;
function startProgressTick(d) {
  stopProgressTick();
  _pMs = d.progress_ms || 0;
  _dMs = d.duration_ms || 0;
  progressTimer = setInterval(() => {
    _pMs = Math.min(_pMs + 1000, _dMs);
    const pct = _dMs > 0 ? (_pMs / _dMs) * 100 : 0;
    setStyle('sp-progress-fill',   'width', pct.toFixed(1) + '%');
    setStyle('dash-progress-fill', 'width', pct.toFixed(1) + '%');
    setText('sp-progress-time',   fmtMs(_pMs));
    setText('dash-progress-time', fmtMs(_pMs));
  }, 1000);
}
function stopProgressTick() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function cycleRepeat() {
  const modes = ['off','track','context'];
  const next  = modes[(modes.indexOf(state.spotify?.repeat || 'off') + 1) % modes.length];
  api('POST', `/api/spotify/repeat/${next}`);
}

async function spotifyAuth() {
  const res = await api('POST', '/api/spotify/auth');
  if (res?.auth_url) window.open(res.auth_url, '_blank', 'width=500,height=700');
}

// ── Notes ─────────────────────────────────────────────────────────────────────
function renderNotes(d) {
  const items = d.items || [];
  const count = items.length;
  setText('notes-count-label', count + ' note' + (count !== 1 ? 's' : ''));
  setText('dash-notes-count', count);

  const badge = document.getElementById('notes-badge');
  if (badge) { badge.textContent = count; badge.style.display = count ? '' : 'none'; }

  const list = document.getElementById('notes-list');
  if (!list) return;
  if (!count) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px 0">No notes yet.</div>';
    return;
  }
  list.innerHTML = items.map(n => `
    <div class="note-item">
      <div class="note-text">${escHtml(n.text)}</div>
      <div class="note-meta">${fmtTs(n.ts)}</div>
      <button class="note-del" onclick="deleteNote(${n.id})" title="Delete">✕</button>
    </div>
  `).join('');
}

async function addNote() {
  const input = document.getElementById('note-input');
  const text = input?.value.trim();
  if (!text) return;
  await api('POST', '/api/notes', { text });
  if (input) input.value = '';
  toast('Note added', 'success');
}

async function deleteNote(id) {
  await api('DELETE', `/api/notes/${id}`);
}

async function clearNotes() {
  if (!confirm('Clear all notes?')) return;
  await api('DELETE', '/api/notes');
}

// ── Timers ────────────────────────────────────────────────────────────────────
const timers = [];
let timerIdCounter = 0;

function addTimer() {
  const secs = parseInt(prompt('Timer duration in minutes:', '5') || '0') * 60;
  if (!secs || secs <= 0) return;
  const id = ++timerIdCounter;
  const end = Date.now() + secs * 1000;
  timers.push({ id, end, label: `Timer ${id}` });
  renderTimers();
}

function removeTimer(id) {
  const idx = timers.findIndex(t => t.id === id);
  if (idx >= 0) timers.splice(idx, 1);
  renderTimers();
}

function renderTimers() {
  const list = document.getElementById('timers-list');
  const empty = document.getElementById('timers-empty');
  if (!list) return;
  if (empty) empty.style.display = timers.length ? 'none' : 'block';

  list.innerHTML = timers.map(t => {
    const left = Math.max(0, Math.ceil((t.end - Date.now()) / 1000));
    const m = Math.floor(left / 60), s = left % 60;
    const done = left === 0;
    return `
    <div class="timer-card ${done ? 'done' : ''}">
      <div class="timer-label">${escHtml(t.label)}</div>
      <div class="timer-time" id="tc-${t.id}">${m}:${String(s).padStart(2,'0')}</div>
      <button class="btn sm danger" onclick="removeTimer(${t.id})">✕</button>
    </div>`;
  }).join('');
}

setInterval(() => {
  timers.forEach(t => {
    const left = Math.max(0, Math.ceil((t.end - Date.now()) / 1000));
    const el = document.getElementById(`tc-${t.id}`);
    if (el) {
      const m = Math.floor(left / 60), s = left % 60;
      el.textContent = `${m}:${String(s).padStart(2,'0')}`;
      el.closest('.timer-card').classList.toggle('done', left === 0);
      if (left === 0 && !t.notified) { t.notified = true; toast(`⏰ ${t.label} done!`, 'success'); }
    }
  });
}, 500);

// ── Settings table ────────────────────────────────────────────────────────────
function buildSettingsTable() {
  const rows = [
    ['SPOTIFY_CLIENT_ID',     state.spotify?.connected, 'Spotify API client ID'],
    ['SPOTIFY_CLIENT_SECRET', state.spotify?.connected, 'Spotify API client secret'],
    ['XIAOMI_LIGHT_IP',       Object.values(state.lights||{}).some(l=>l.reachable), 'Yeelight bulb local IP'],
    ['XIAOMI_LIGHT_2_IP',     false, 'Second bulb (optional)'],
  ];
  const tbody = document.getElementById('settings-table');
  if (!tbody) return;
  tbody.innerHTML = rows.map(([key, ok, desc]) => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;color:var(--accent)">${key}</td>
      <td style="padding:8px 12px;color:${ok ? 'var(--green)' : 'var(--red)'}">${ok ? '✓ OK' : '✗ Not set'}</td>
      <td style="padding:8px 12px;color:var(--text-dim);font-family:var(--font);font-size:12px">${desc}</td>
    </tr>`).join('');
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function setText(id, val)      { const e = document.getElementById(id); if (e) e.textContent = val ?? '—'; }
function setStyle(id, p, v)    { const e = document.getElementById(id); if (e) e.style[p] = v; }
function setPlayBtn(id, p)     { const e = document.getElementById(id); if (e) e.textContent = p ? '⏸' : '▶'; }
function setAlbumArt(id, url)  {
  const e = document.getElementById(id);
  if (!e) return;
  e.innerHTML = url ? `<img src="${url}" alt="album art"/>` : '♪';
}
function fmtMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
function fmtTs(ts) {
  return new Date(ts * 1000).toLocaleString();
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function kelvinToHex(k) {
  k = Math.max(1000, Math.min(10000, k));
  let r, g, b;
  if (k <= 6600) {
    r = 255;
    g = Math.min(255, Math.max(0, Math.round(99.47 * Math.log(k/100) - 161.12)));
    b = k <= 1900 ? 0 : Math.min(255, Math.max(0, Math.round(138.52 * Math.log(k/100 - 10) - 305.04)));
  } else {
    r = Math.min(255, Math.max(0, Math.round(329.70 * Math.pow(k/100 - 60, -0.133))));
    g = Math.min(255, Math.max(0, Math.round(288.12 * Math.pow(k/100 - 60, -0.076))));
    b = 255;
  }
  return `rgb(${r},${g},${b})`;
}
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  setInterval(buildSettingsTable, 5000);
  buildSettingsTable();
});
