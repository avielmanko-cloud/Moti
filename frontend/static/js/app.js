/* ── MOTI front-end app ─────────────────────────────────────── */

// ── State ────────────────────────────────────────────────────────
let state = { lights: {}, spotify: {}, phone: {}, whatsapp: {}, system: {} };
let progressTimer = null;
let wsRetryDelay = 1000;

// ── WebSocket ─────────────────────────────────────────────────────
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsRetryDelay = 1000;
    document.getElementById('ws-status').textContent = '●';
    document.getElementById('ws-status').style.color = 'var(--green)';
  };

  ws.onclose = () => {
    document.getElementById('ws-status').textContent = '●';
    document.getElementById('ws-status').style.color = 'var(--red)';
    setTimeout(connectWS, wsRetryDelay);
    wsRetryDelay = Math.min(wsRetryDelay * 2, 16000);
  };

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

// ── API helper ────────────────────────────────────────────────────
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

// ── Navigation ────────────────────────────────────────────────────
function navigate(el) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  if (el && el.dataset) {
    el.classList.add('active');
    document.getElementById('panel-' + el.dataset.panel)?.classList.add('active');
  }
}

// ── Render dispatch ───────────────────────────────────────────────
function renderAll() {
  render('lights',    state.lights);
  render('spotify',   state.spotify);
  render('phone',     state.phone);
  render('whatsapp',  state.whatsapp);
  render('system',    state.system);
}

function render(topic, data) {
  switch (topic) {
    case 'lights':    renderLights(data);   break;
    case 'spotify':   renderSpotify(data);  break;
    case 'phone':     renderPhone(data);    break;
    case 'whatsapp':  renderWhatsApp(data); break;
    case 'system':    renderSystem(data);   break;
  }
}

// ── System ────────────────────────────────────────────────────────
function renderSystem(d) {
  setText('sys-cpu', d.cpu != null ? d.cpu.toFixed(0) + '%' : '—');
  setText('sys-ram', d.ram != null ? d.ram.toFixed(0) + '%' : '—');
  if (d.time) setText('clock', d.time);
}

// ── Lights ────────────────────────────────────────────────────────
function renderLights(lights) {
  const entries = Object.entries(lights || {});
  const dot = document.getElementById('dot-xiaomi');
  const anyReachable = entries.some(([,v]) => v.reachable);
  dot.className = 'conn-dot ' + (anyReachable ? 'on' : 'off');

  // Dashboard quick lights
  renderLightList('dash-lights', entries, true);
  // Lights panel
  renderLightList('lights-list', entries, false);

  const empty = document.getElementById('lights-empty');
  if (empty) empty.style.display = entries.length === 0 ? 'block' : 'none';

  // Dashboard tile
  const onCount = entries.filter(([,v]) => v.on).length;
  setText('dash-lights-count', entries.length ? `${onCount}/${entries.length}` : '—');
  setText('dash-lights-sub', entries.length ? `${onCount} light(s) on` : 'No devices');
}

function renderLightList(containerId, entries, compact) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (entries.length === 0) {
    container.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:8px 0">No lights configured.</div>';
    return;
  }
  container.innerHTML = entries.map(([id, l]) => lightRowHTML(id, l, compact)).join('');
}

function lightRowHTML(id, l, compact) {
  const kelvinColor = kelvinToHex(l.color_temp || 4000);
  return `
  <div class="light-row ${l.on ? 'active' : ''}" id="lr-${id}">
    <div class="light-icon">💡</div>
    <div class="light-info">
      <div class="light-name">${l.name || id}</div>
      <div class="light-meta">
        ${l.reachable ? `<span style="color:var(--green)">●</span> ONLINE` : `<span style="color:var(--red)">●</span> OFFLINE`}
        ${l.on ? ` · ${l.brightness}% · ${l.color_temp}K` : ''}
      </div>
    </div>
    <div class="light-controls">
      ${!compact ? `
      <div class="kelvin-display" style="background:${kelvinColor}" title="${l.color_temp}K"></div>
      <div class="slider-wrap">
        <span class="slider-label">BRIGHT</span>
        <input type="range" min="1" max="100" value="${l.brightness||100}"
          oninput="api('POST','/api/lights/${id}/brightness',{value:+this.value})"/>
      </div>
      <div class="slider-wrap">
        <span class="slider-label">TEMP</span>
        <input type="range" min="1700" max="6500" value="${l.color_temp||4000}"
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
  Object.keys(state.lights || {}).forEach(id => {
    api('POST', `/api/lights/${id}/power`, { on });
  });
}

// ── Spotify ───────────────────────────────────────────────────────
function renderSpotify(d) {
  const dot = document.getElementById('dot-spotify');
  dot.className = 'conn-dot ' + (d.connected ? 'on' : 'off');

  const playing = d.playing;
  const trackName  = d.track  || 'Nothing playing';
  const artistName = d.artist || '—';

  // Spotify panel
  setAlbumArt('sp-album-art',   d.album_art);
  setAlbumArt('dash-album-art', d.album_art);
  setText('sp-track-name',    trackName);
  setText('sp-track-artist',  artistName);
  setText('dash-track-name',  trackName);
  setText('dash-track-artist', artistName);

  setPlayBtn('sp-play-btn',   playing);
  setPlayBtn('dash-play-btn', playing);

  const indicator = document.getElementById('dash-playing-indicator');
  if (indicator) indicator.style.display = playing ? 'block' : 'none';

  // Shuffle
  ['sp-shuffle-btn','dash-shuffle-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', !!d.shuffle);
  });

  // Repeat
  const rb = document.getElementById('sp-repeat-btn');
  if (rb) {
    rb.classList.toggle('active', d.repeat !== 'off');
    rb.textContent = d.repeat === 'track' ? '↺¹' : '↻';
  }

  // Volume
  const vol = document.getElementById('sp-volume');
  if (vol) vol.value = d.volume || 50;
  setText('sp-vol-label', (d.volume || 50) + '%');

  // Progress
  renderProgress(d);

  // Dashboard tile
  setText('dash-spotify-state', playing ? 'LIVE' : (d.connected ? 'PAUSE' : 'OFF'));
  setText('dash-spotify-track', d.track ? `${d.track} — ${d.artist}` : 'Not connected');
  document.getElementById('dash-spotify-state').style.color = playing ? 'var(--green)' : '';

  // Auth button
  const authBtn = document.getElementById('spotify-auth-btn');
  if (authBtn) authBtn.style.display = d.connected ? 'none' : '';

  // Progress auto-tick
  if (playing) startProgressTick(d);
  else stopProgressTick();
}

function renderProgress(d) {
  const pct = d.duration_ms > 0 ? (d.progress_ms / d.duration_ms) * 100 : 0;
  setStyle('sp-progress-fill',   'width', pct.toFixed(1) + '%');
  setStyle('dash-progress-fill', 'width', pct.toFixed(1) + '%');
  setText('sp-progress-time',   fmtMs(d.progress_ms));
  setText('dash-progress-time', fmtMs(d.progress_ms));
  setText('sp-duration-time',   fmtMs(d.duration_ms));
  setText('dash-duration-time', fmtMs(d.duration_ms));
}

let _progressMs = 0, _durationMs = 0;
function startProgressTick(d) {
  stopProgressTick();
  _progressMs  = d.progress_ms  || 0;
  _durationMs  = d.duration_ms  || 0;
  progressTimer = setInterval(() => {
    _progressMs = Math.min(_progressMs + 1000, _durationMs);
    const pct = _durationMs > 0 ? (_progressMs / _durationMs) * 100 : 0;
    setStyle('sp-progress-fill',   'width', pct.toFixed(1) + '%');
    setStyle('dash-progress-fill', 'width', pct.toFixed(1) + '%');
    setText('sp-progress-time',   fmtMs(_progressMs));
    setText('dash-progress-time', fmtMs(_progressMs));
  }, 1000);
}
function stopProgressTick() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function cycleRepeat() {
  const modes = ['off','track','context'];
  const cur   = state.spotify?.repeat || 'off';
  const next  = modes[(modes.indexOf(cur) + 1) % modes.length];
  api('POST', `/api/spotify/repeat/${next}`);
}

async function spotifyAuth() {
  const res = await api('POST', '/api/spotify/auth');
  if (res?.auth_url) {
    window.open(res.auth_url, '_blank', 'width=500,height=700');
  }
}

// ── Phone ─────────────────────────────────────────────────────────
function renderPhone(d) {
  const dot = document.getElementById('dot-phone');
  dot.className = 'conn-dot ' + (d.connected ? 'on' : 'off');

  setText('ph-model',   d.model   || '—');
  setText('ph-wifi',    d.wifi    || '—');
  setText('ph-status',  d.connected ? 'Online' : 'Offline');
  document.getElementById('ph-status').style.color = d.connected ? 'var(--green)' : 'var(--red)';

  if (d.battery != null) {
    setText('ph-battery', d.battery + '%');
    const bar = document.getElementById('ph-battery-bar');
    if (bar) {
      bar.style.width = d.battery + '%';
      bar.className = 'battery-fill' + (d.battery < 20 ? ' low' : d.battery < 40 ? ' warn' : '');
    }
  } else {
    setText('ph-battery', '—');
  }

  setText('dash-phone-battery', d.battery != null ? d.battery + '%' : '—');
  setText('dash-phone-model',   d.model || (d.connected ? 'Connected' : 'Not connected'));
}

async function connectPhone() {
  const res = await api('POST', '/api/phone/connect');
  toast(res?.ok ? 'Phone connected!' : 'Could not connect. Check ADB setup.', res?.ok ? 'success' : 'error');
}

// ── WhatsApp ──────────────────────────────────────────────────────
function renderWhatsApp(d) {
  const dot = document.getElementById('dot-whatsapp');
  dot.className = 'conn-dot ' + (d.connected ? 'on' : 'off');

  const badge = document.getElementById('wa-badge');
  if (badge) {
    badge.textContent = d.unread || 0;
    badge.style.display = (d.unread > 0) ? 'inline' : 'none';
  }
  setText('wa-unread-count', (d.unread || 0) + ' unread');
  setText('dash-wa-unread', d.unread || 0);
}

async function sendWhatsApp() {
  const to  = document.getElementById('wa-to')?.value.trim();
  const msg = document.getElementById('wa-msg')?.value.trim();
  if (!to || !msg) { toast('Fill in number and message', 'error'); return; }
  const res = await api('POST', '/api/whatsapp/send', { to, message: msg });
  if (res?.ok) {
    toast('Message sent!', 'success');
    document.getElementById('wa-msg').value = '';
    loadMessages();
  } else {
    toast('Send failed. Check Twilio config.', 'error');
  }
}

async function loadMessages() {
  const msgs = await api('GET', '/api/whatsapp/messages');
  if (!msgs) return;
  const feed = document.getElementById('wa-feed');
  if (!feed) return;
  if (!msgs.length) {
    feed.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:12px 0">No messages yet.</div>';
    return;
  }
  feed.innerHTML = msgs.map(m => `
    <div class="wa-msg ${m.direction}">
      <div>${escHtml(m.body)}</div>
      <div class="wa-msg-meta">${m.direction === 'in' ? m.from : 'You → ' + m.to}</div>
    </div>
  `).join('');
  feed.scrollTop = feed.scrollHeight;
}

// ── Settings table ────────────────────────────────────────────────
function buildSettingsTable() {
  const rows = [
    ['SPOTIFY_CLIENT_ID',     state.spotify?.connected,  'Spotify API client ID'],
    ['SPOTIFY_CLIENT_SECRET', state.spotify?.connected,  'Spotify API client secret'],
    ['XIAOMI_LIGHT_IP',       Object.values(state.lights||{}).some(l=>l.reachable), 'Xiaomi bulb local IP'],
    ['XIAOMI_LIGHT_TOKEN',    Object.values(state.lights||{}).some(l=>l.reachable), 'Xiaomi bulb token (32 chars)'],
    ['TWILIO_ACCOUNT_SID',    state.whatsapp?.connected, 'Twilio account SID'],
    ['TWILIO_AUTH_TOKEN',     state.whatsapp?.connected, 'Twilio auth token'],
    ['ADB_DEVICE_IP',         state.phone?.connected,    'Android phone IP for ADB'],
  ];
  const tbody = document.getElementById('settings-table');
  if (!tbody) return;
  tbody.innerHTML = rows.map(([key, ok, desc]) => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 12px;color:var(--accent)">${key}</td>
      <td style="padding:8px 12px">
        <span style="color:${ok ? 'var(--green)' : 'var(--red)'}">${ok ? '✓ OK' : '✗ Missing'}</span>
      </td>
      <td style="padding:8px 12px;color:var(--text-dim);font-family:var(--font);font-size:12px">${desc}</td>
    </tr>
  `).join('');
}

// ── Utilities ─────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '—';
}
function setStyle(id, prop, val) {
  const el = document.getElementById(id);
  if (el) el.style[prop] = val;
}
function setPlayBtn(id, playing) {
  const btn = document.getElementById(id);
  if (btn) btn.textContent = playing ? '⏸' : '▶';
}
function setAlbumArt(id, url) {
  const el = document.getElementById(id);
  if (!el) return;
  if (url) {
    el.innerHTML = `<img src="${url}" alt="album art"/>`;
  } else {
    el.innerHTML = '♪';
  }
}
function fmtMs(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function kelvinToHex(k) {
  // Approximate colour temperature to hex
  k = Math.max(1000, Math.min(10000, k));
  let r, g, b;
  if (k <= 6600) {
    r = 255;
    g = Math.min(255, Math.max(0, Math.round(99.4708025861 * Math.log(k/100) - 161.1195681661)));
    b = k <= 1900 ? 0 : Math.min(255, Math.max(0, Math.round(138.5177312231 * Math.log(k/100 - 10) - 305.0447927307)));
  } else {
    r = Math.min(255, Math.max(0, Math.round(329.698727446 * Math.pow(k/100 - 60, -0.1332047592))));
    g = Math.min(255, Math.max(0, Math.round(288.1221695283 * Math.pow(k/100 - 60, -0.0755148492))));
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

// ── Init ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  connectWS();
  loadMessages();
  setInterval(loadMessages, 30000);
  setInterval(buildSettingsTable, 5000);
  buildSettingsTable();
});
