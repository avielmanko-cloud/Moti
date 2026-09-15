/* ── MOTI Mixed Reality — WebXR holo-room ──────────────────────────────────────
   Turns the control-panel's live state (lights / spotify / notes / pc / clock)
   into floating holographic windows. Pinch a window's title bar to grab it,
   poke a button with a fingertip to click it, carry a window into the glowing
   trash bin and let go to dismiss it. Works with hand-tracking, controllers,
   or (for preview on a normal screen) the mouse.
*/
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── Moti palette ────────────────────────────────────────────────────────────
const COLOR = {
  bg: 0x070b14, surface: 0x0d1526, surface2: 0x111e35, border: 0x1a3060,
  accent: '#00d4ff', accent2: '#7b61ff', green: '#00ffb3', yellow: '#ffd600',
  red: '#ff3860', text: '#cce4ff', textDim: '#4a6a9a',
};
const FONT = "'Rajdhani', 'Segoe UI', sans-serif";
const MONO = "'Share Tech Mono', 'Consolas', monospace";

// ── Tunables ────────────────────────────────────────────────────────────────
const GRAB_RADIUS = 0.09;       // m — pinch/controller distance to title bar to grab
const POKE_DEPTH = 0.035;       // m — fingertip band in front of a window that counts as a poke
const POKE_COOLDOWN = 400;      // ms between repeat pokes of the same button
const TRASH_CAPTURE_RADIUS = 0.32; // m — release-inside-this radius of the bin = dismiss
const MIN_HOLD_DIST = 0.3, MAX_HOLD_DIST = 2.6; // m — how far a settled window may drift from user

// ── DOM ─────────────────────────────────────────────────────────────────────
const sceneRoot = document.getElementById('mr-scene-root');
const overlay = document.getElementById('mr-overlay');
const landing = document.getElementById('mr-landing');
const xrHint = document.getElementById('mr-xr-hint');
const exitBtn = document.getElementById('btn-exit-xr');
const supportStatus = document.getElementById('mr-support-status');
const btnAR = document.getElementById('btn-enter-ar');
const btnVR = document.getElementById('btn-enter-vr');
const btnPreview = document.getElementById('btn-preview');

// ── Renderer / scene / camera ───────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
sceneRoot.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.02, 100);
camera.position.set(0, 1.6, 2.2);

const hemi = new THREE.HemisphereLight(0x335577, 0x05070d, 1.1);
const key = new THREE.DirectionalLight(0x8fd7ff, 0.6);
key.position.set(1, 2, 1);
scene.add(hemi, key);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.5, 0);
controls.enableDamping = true;
controls.enabled = false; // only for desktop preview

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Ambient environment (grid + starfield) — hidden during AR passthrough ───
const envGroup = new THREE.Group();
{
  const grid = new THREE.GridHelper(10, 40, 0x00d4ff, 0x1a3060);
  grid.material.transparent = true;
  grid.material.opacity = 0.25;
  envGroup.add(grid);

  const starCount = 200;
  const starGeo = new THREE.BufferGeometry();
  const pos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 4 + Math.random() * 5;
    const theta = Math.random() * Math.PI * 2;
    const y = Math.random() * 4 + 0.2;
    pos[i * 3] = Math.cos(theta) * r;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = Math.sin(theta) * r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x7b61ff, size: 0.02, transparent: true, opacity: 0.6 }));
  envGroup.add(stars);
}
scene.add(envGroup);

// ── Floating ambient particles ("full of floating things") ─────────────────
const PARTICLE_COUNT = 42;
const particleMesh = new THREE.InstancedMesh(
  new THREE.IcosahedronGeometry(0.012, 0),
  new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.55 }),
  PARTICLE_COUNT
);
const particles = [];
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 1.0 + Math.random() * 1.6;
  particles.push({
    baseAngle: angle,
    radius,
    height: 0.4 + Math.random() * 1.8,
    speed: 0.05 + Math.random() * 0.08,
    bobPhase: Math.random() * Math.PI * 2,
    bobAmp: 0.05 + Math.random() * 0.08,
  });
}
scene.add(particleMesh);

// ── Live Moti state (mirrors app.js) ────────────────────────────────────────
let state = { lights: {}, spotify: {}, pc: {}, notes: { items: [] }, system: {} };
let wsConnected = false;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsConnected = true; };
  ws.onclose = () => { wsConnected = false; setTimeout(connectWS, 2000); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.topic === 'full_state') { state = msg.data; }
    else if (msg.topic && msg.data) { state[msg.topic] = msg.data; }
    onStateChanged(msg.topic || 'full_state');
  };
}
connectWS();

async function callApi(method, url, body) {
  try {
    await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) { /* best-effort from the holo-room */ }
}

// ── Canvas card drawing helpers (mirrors style.css look) ────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCardFrame(ctx, w, h, title, icon, statusText, statusColor) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(13,21,38,0.92)';
  roundRect(ctx, 4, 4, w - 8, h - 8, 18);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLOR.accent;
  ctx.shadowColor = COLOR.accent;
  ctx.shadowBlur = 18;
  roundRect(ctx, 4, 4, w - 8, h - 8, 18);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // title bar (also the grabbable strip)
  const barH = 64;
  ctx.strokeStyle = 'rgba(26,48,96,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(16, barH); ctx.lineTo(w - 16, barH); ctx.stroke();

  ctx.font = `600 30px ${FONT}`;
  ctx.fillStyle = COLOR.text;
  ctx.textBaseline = 'middle';
  ctx.fillText(`${icon}  ${title}`, 26, barH / 2 + 2);

  if (statusText) {
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = statusColor || COLOR.textDim;
    ctx.textAlign = 'right';
    ctx.fillText(statusText, w - 24, barH / 2 + 2);
    ctx.textAlign = 'left';
  }

  // drag handle dots
  ctx.fillStyle = COLOR.textDim;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(w - 26, 20 + i * 8, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  return barH;
}

function drawButton(ctx, rect, label, opts = {}) {
  const { active, pressed, danger } = opts;
  const color = danger ? COLOR.red : (active ? COLOR.green : COLOR.accent);
  ctx.fillStyle = pressed ? 'rgba(0,212,255,0.35)' : (active ? 'rgba(0,255,179,0.12)' : 'rgba(17,30,53,0.9)');
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `600 ${Math.floor(rect.h * 0.42)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
  ctx.textAlign = 'left';
}

// ── HoloWindow ───────────────────────────────────────────────────────────────
class HoloWindow {
  constructor(id, { title, icon, w = 0.56, h = 0.36, canvasW = 720, canvasH = 460, fixed = false }) {
    this.id = id;
    this.title = title;
    this.icon = icon;
    this.width = w;
    this.height = h;
    this.fixed = fixed; // dock panel: not grabbable, always follows head
    this.buttons = []; // {x,y,w,h,action,label,pressedUntil}
    this.titleBarH = 0; // fraction of canvas height reserved as the grab strip

    this.canvas = document.createElement('canvas');
    this.canvas.width = canvasW;
    this.canvas.height = canvasH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(geo, mat);
    this.group = new THREE.Group();
    this.group.add(this.mesh);

    this.anchor = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.grabbedBy = null; // inputId currently holding this window
    this.grabOffset = new THREE.Vector3();
    this.bobPhase = Math.random() * Math.PI * 2;
    this.state = 'idle'; // idle | grabbed | settling | trashing | closed

    scene.add(this.group);
  }

  redraw() { /* overridden per-window-type */ }

  markButton(id, rect, label, opts) {
    this.buttons.push({ id, ...rect, label, opts: opts || {} });
  }

  press(buttonId) {
    this._pressed = buttonId;
    this.redraw();
    setTimeout(() => { this._pressed = null; this.redraw(); }, 150);
  }

  setAnchor(v) { this.anchor.copy(v); this.group.position.copy(v); }

  dispose() {
    scene.remove(this.group);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}

// ── Window instances ─────────────────────────────────────────────────────────
const windows = new Map();
const closedWindows = []; // {id} — dismissed, can be restored

function makeLightsWindow() {
  const win = new HoloWindow('lights', { title: 'LIGHTS', icon: '💡', w: 0.58, h: 0.4 });
  win.redraw = () => {
    const { ctx, canvas } = win;
    const entries = Object.entries(state.lights || {});
    const anyOn = entries.some(([, l]) => l.reachable);
    win.buttons = [];
    const barH = drawCardFrame(ctx, canvas.width, canvas.height, 'LIGHTS', '💡',
      anyOn ? 'ONLINE' : 'OFFLINE', anyOn ? COLOR.green : COLOR.red);

    if (!entries.length) {
      ctx.fillStyle = COLOR.textDim;
      ctx.font = `18px ${FONT}`;
      ctx.fillText('No lights configured', 30, barH + 50);
      win.texture.needsUpdate = true;
      return;
    }
    let y = barH + 24;
    const rowH = 78;
    entries.slice(0, 4).forEach(([id, l]) => {
      ctx.fillStyle = 'rgba(17,30,53,0.7)';
      roundRect(ctx, 20, y, canvas.width - 40, rowH - 10, 10);
      ctx.fill();
      ctx.fillStyle = COLOR.text;
      ctx.font = `600 22px ${FONT}`;
      ctx.fillText(l.name || id, 34, y + 30);
      ctx.font = `13px ${MONO}`;
      ctx.fillStyle = l.on ? COLOR.accent : COLOR.textDim;
      ctx.fillText(l.on ? `ON · ${l.brightness ?? 100}%` : 'OFF', 34, y + 54);

      const btnRect = { x: canvas.width - 150, y: y + 10, w: 120, h: rowH - 30 };
      drawButton(ctx, btnRect, l.on ? 'TURN OFF' : 'TURN ON', {
        active: l.on, pressed: win._pressed === `light-${id}`,
      });
      win.markButton(`light-${id}`, btnRect, l.on ? 'TURN OFF' : 'TURN ON');
      y += rowH;
    });
    win.texture.needsUpdate = true;
  };
  win.onButton = (id) => {
    const lightId = id.replace('light-', '');
    const l = state.lights?.[lightId];
    callApi('POST', `/api/lights/${lightId}/power`, { on: !(l && l.on) });
  };
  return win;
}

function makeSpotifyWindow() {
  const win = new HoloWindow('spotify', { title: 'SPOTIFY', icon: '♫', w: 0.58, h: 0.38 });
  win.redraw = () => {
    const { ctx, canvas } = win;
    const d = state.spotify || {};
    win.buttons = [];
    const barH = drawCardFrame(ctx, canvas.width, canvas.height, 'SPOTIFY', '♫',
      d.playing ? '● LIVE' : (d.connected ? 'PAUSED' : 'OFFLINE'),
      d.playing ? COLOR.green : COLOR.textDim);

    ctx.fillStyle = COLOR.text;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText((d.track || 'Nothing playing').slice(0, 26), 30, barH + 50);
    ctx.font = `16px ${FONT}`;
    ctx.fillStyle = COLOR.textDim;
    ctx.fillText((d.artist || '—').slice(0, 34), 30, barH + 80);

    const pct = d.duration_ms > 0 ? d.progress_ms / d.duration_ms : 0;
    const barY = barH + 110, barX = 30, barW = canvas.width - 60;
    ctx.fillStyle = 'rgba(26,48,96,0.6)';
    roundRect(ctx, barX, barY, barW, 6, 3); ctx.fill();
    ctx.fillStyle = COLOR.accent;
    roundRect(ctx, barX, barY, barW * Math.min(1, pct), 6, 3); ctx.fill();

    const by = barY + 40, bh = 64;
    const bw = 100, gap = 16;
    const totalW = bw * 3 + gap * 2;
    let bx = (canvas.width - totalW) / 2;
    [['prev', '⏮'], ['playpause', d.playing ? '⏸' : '▶'], ['next', '⏭']].forEach(([id, label]) => {
      const rect = { x: bx, y: by, w: bw, h: bh };
      drawButton(ctx, rect, label, { active: id === 'playpause' && d.playing, pressed: win._pressed === id });
      win.markButton(id, rect, label);
      bx += bw + gap;
    });
    win.texture.needsUpdate = true;
  };
  win.onButton = (id) => {
    if (id === 'prev') callApi('POST', '/api/spotify/prev');
    if (id === 'next') callApi('POST', '/api/spotify/next');
    if (id === 'playpause') callApi('POST', '/api/spotify/play_pause');
  };
  return win;
}

function makeNotesWindow() {
  const win = new HoloWindow('notes', { title: 'NOTES', icon: '📝', w: 0.5, h: 0.36 });
  win.redraw = () => {
    const { ctx, canvas } = win;
    const items = (state.notes && state.notes.items) || [];
    win.buttons = [];
    const barH = drawCardFrame(ctx, canvas.width, canvas.height, 'NOTES', '📝', `${items.length} note${items.length !== 1 ? 's' : ''}`);
    if (!items.length) {
      ctx.fillStyle = COLOR.textDim;
      ctx.font = `18px ${FONT}`;
      ctx.fillText('No notes yet', 30, barH + 50);
    } else {
      let y = barH + 34;
      items.slice(-4).reverse().forEach((n) => {
        ctx.fillStyle = 'rgba(17,30,53,0.7)';
        roundRect(ctx, 20, y - 22, canvas.width - 40, 46, 8);
        ctx.fill();
        ctx.fillStyle = COLOR.text;
        ctx.font = `16px ${FONT}`;
        const text = String(n.text || '').slice(0, 40);
        ctx.fillText(text, 32, y + 4);
        y += 56;
      });
    }
    win.texture.needsUpdate = true;
  };
  win.onButton = () => {};
  return win;
}

function makePCWindow() {
  const win = new HoloWindow('pc', { title: 'PC STATS', icon: '🖥', w: 0.5, h: 0.34 });
  win.redraw = () => {
    const { ctx, canvas } = win;
    const d = state.pc || {};
    win.buttons = [];
    const barH = drawCardFrame(ctx, canvas.width, canvas.height, 'PC STATS', '🖥');
    const rows = [['CPU', d.cpu], ['RAM', d.ram], ['DISK', d.disk]];
    let y = barH + 30;
    rows.forEach(([label, val]) => {
      ctx.fillStyle = COLOR.textDim;
      ctx.font = `13px ${MONO}`;
      ctx.fillText(label, 30, y);
      const barX = 110, barW = canvas.width - 150, barH2 = 14;
      ctx.fillStyle = 'rgba(26,48,96,0.6)';
      roundRect(ctx, barX, y - 11, barW, barH2, 7); ctx.fill();
      const pct = Math.max(0, Math.min(100, val || 0));
      const color = pct > 90 ? COLOR.red : pct > 70 ? COLOR.yellow : COLOR.accent;
      ctx.fillStyle = color;
      roundRect(ctx, barX, y - 11, barW * (pct / 100), barH2, 7); ctx.fill();
      ctx.fillStyle = COLOR.text;
      ctx.font = `13px ${MONO}`;
      ctx.fillText(val != null ? Math.round(val) + '%' : '—', barX + barW + 10, y);
      y += 46;
    });
    win.texture.needsUpdate = true;
  };
  win.onButton = () => {};
  return win;
}

function makeClockWindow() {
  const win = new HoloWindow('clock', { title: 'MOTI', icon: '⬡', w: 0.34, h: 0.2, canvasW: 480, canvasH: 280 });
  win.redraw = () => {
    const { ctx, canvas } = win;
    win.buttons = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(13,21,38,0.9)';
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18); ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = COLOR.accent2;
    ctx.shadowColor = COLOR.accent2; ctx.shadowBlur = 16;
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 18); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLOR.accent;
    ctx.font = `700 46px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(state.system?.time || '--:--:--', canvas.width / 2, 110);
    ctx.font = `14px ${MONO}`;
    ctx.fillStyle = COLOR.textDim;
    ctx.fillText('ROOM AI CONTROL', canvas.width / 2, 150);
    ctx.font = `13px ${MONO}`;
    ctx.fillStyle = wsConnected ? COLOR.green : COLOR.red;
    ctx.fillText(wsConnected ? '● SERVER LINKED' : '● SERVER OFFLINE', canvas.width / 2, 200);
    ctx.textAlign = 'left';
    win.texture.needsUpdate = true;
  };
  win.onButton = () => {};
  return win;
}

function makeDockWindow() {
  const win = new HoloWindow('dock', { title: 'DOCK', icon: '⚙', w: 0.38, h: 0.16, canvasW: 520, canvasH: 220, fixed: true });
  win.redraw = () => {
    const { ctx, canvas } = win;
    win.buttons = [];
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(13,21,38,0.85)';
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 16); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = COLOR.border;
    roundRect(ctx, 4, 4, canvas.width - 8, canvas.height - 8, 16); ctx.stroke();

    ctx.fillStyle = wsConnected ? COLOR.green : COLOR.red;
    ctx.beginPath(); ctx.arc(30, 34, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COLOR.textDim;
    ctx.font = `13px ${MONO}`;
    ctx.fillText(wsConnected ? 'LINKED' : 'OFFLINE', 44, 39);

    ctx.fillStyle = COLOR.text;
    ctx.font = `18px ${FONT}`;
    ctx.fillText(`🗑 Dismissed: ${closedWindows.length}`, 24, 90);

    const rect = { x: 24, y: 120, w: canvas.width - 48, h: 60 };
    drawButton(ctx, rect, '↺  RESTORE ALL', { pressed: win._pressed === 'restore', active: closedWindows.length > 0 });
    win.markButton('restore', rect, '↺  RESTORE ALL');
    win.texture.needsUpdate = true;
  };
  win.onButton = (id) => { if (id === 'restore') restoreAll(); };
  return win;
}

function onStateChanged() {
  ['lights', 'spotify', 'notes', 'pc'].forEach((id) => windows.get(id)?.redraw());
}
setInterval(() => { windows.get('clock')?.redraw(); windows.get('dock')?.redraw(); }, 1000);

function buildAllWindows() {
  windows.set('lights', makeLightsWindow());
  windows.set('spotify', makeSpotifyWindow());
  windows.set('notes', makeNotesWindow());
  windows.set('pc', makePCWindow());
  windows.set('clock', makeClockWindow());
  windows.set('dock', makeDockWindow());
  windows.forEach((w) => w.redraw());
}
buildAllWindows();

// ── Layout: arrange windows around wherever the user is standing/looking ────
const up = new THREE.Vector3(0, 1, 0);
function getForwardXZ(cam) {
  const dir = new THREE.Vector3();
  cam.getWorldDirection(dir);
  dir.y = 0;
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); else dir.normalize();
  return dir;
}
function getRightXZ(forward) {
  return new THREE.Vector3().crossVectors(forward, up).normalize();
}

let roomAnchor = null; // { pos: Vector3 (xz + eye height), forward, right }

function layoutWorld(anchor) {
  roomAnchor = anchor;
  const { pos, forward, right } = anchor;
  const arc = [
    ['lights', -45, -0.05, 1.25],
    ['spotify', -20, 0.12, 1.2],
    ['clock', 0, 0.22, 1.05],
    ['notes', 20, 0.1, 1.2],
    ['pc', 45, -0.05, 1.25],
  ];
  arc.forEach(([id, deg, hOff, radius]) => {
    const win = windows.get(id);
    if (!win) return;
    const rad = (deg * Math.PI) / 180;
    const dir = forward.clone().multiplyScalar(Math.cos(rad)).add(right.clone().multiplyScalar(Math.sin(rad)));
    const p = pos.clone().add(dir.multiplyScalar(radius));
    p.y = pos.y + hOff;
    win.setAnchor(p);
    win.velocity.set(0, 0, 0);
  });

  placeTrashBinDefault(anchor);
}

function updateDockFollow(dt) {
  const dock = windows.get('dock');
  if (!dock) return;
  const forward = getForwardXZ(camera);
  const target = camera.position.clone()
    .add(forward.clone().multiplyScalar(0.6))
    .add(new THREE.Vector3(0, -0.42, 0));
  dock.group.position.lerp(target, Math.min(1, dt * 4));
  billboardY(dock.group, camera.position);
}

function billboardY(group, camPos) {
  const dx = camPos.x - group.position.x;
  const dz = camPos.z - group.position.z;
  const yaw = Math.atan2(dx, dz);
  group.rotation.set(0, yaw, 0);
}

// ── Trash bin ────────────────────────────────────────────────────────────────
const trashBin = new THREE.Group();
{
  const cyl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.15, 0.12, 0.32, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: COLOR.surface2, transparent: true, opacity: 0.6, side: THREE.DoubleSide, roughness: 0.7 })
  );
  cyl.position.y = 0.16;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(0.155, 0.012, 10, 32),
    new THREE.MeshBasicMaterial({ color: COLOR.red })
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.32;
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 32),
    new THREE.MeshBasicMaterial({ color: COLOR.red, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.01;
  const captureRing = new THREE.Mesh(
    new THREE.RingGeometry(TRASH_CAPTURE_RADIUS - 0.015, TRASH_CAPTURE_RADIUS, 48),
    new THREE.MeshBasicMaterial({ color: COLOR.red, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
  );
  captureRing.rotation.x = -Math.PI / 2;
  captureRing.position.y = 0.005;

  trashBin.add(cyl, rim, glow, captureRing);
  trashBin.userData.glow = glow;
  trashBin.userData.ring = captureRing;
  trashBin.userData.rim = rim;
}

// label sprite
const labelWin = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 360; canvas.height = 90;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(13,21,38,0.85)';
  roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, 16); ctx.fill();
  ctx.strokeStyle = COLOR.red; ctx.lineWidth = 3;
  roundRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, 16); ctx.stroke();
  ctx.fillStyle = COLOR.red;
  ctx.font = `700 34px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('🗑 TRASH', canvas.width / 2, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.26, 0.065),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  mesh.position.y = 0.44;
  return mesh;
})();
trashBin.add(labelWin);
scene.add(trashBin);
trashBin.visible = false;

function placeTrashBinDefault(anchor) {
  const { pos, forward, right } = anchor;
  const rad = (-65 * Math.PI) / 180;
  const dir = forward.clone().multiplyScalar(Math.cos(rad)).add(right.clone().multiplyScalar(Math.sin(rad)));
  const p = new THREE.Vector3(pos.x, 0, pos.z).add(dir.multiplyScalar(0.95));
  trashBin.position.copy(p);
  trashBin.visible = true;
}

function placeTrashBinAt(pose) {
  trashBin.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
  trashBin.visible = true;
}

// ── Placement (hit-test) mode for AR ────────────────────────────────────────
let placementMode = false;
let hitTestSource = null;
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.09, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: COLOR.accent })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

async function tryStartPlacement(session) {
  try {
    const viewerSpace = await session.requestReferenceSpace('viewer');
    hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    placementMode = true;
    xrHint.hidden = false;
    xrHint.textContent = 'Point at your real floor and pinch/click to place the trash bin';
  } catch (err) {
    hitTestSource = null;
    finishPlacement(null);
  }
}

function finishPlacement(pose) {
  placementMode = false;
  reticle.visible = false;
  if (pose) placeTrashBinAt(pose);
  const anchor = computeRoomAnchor();
  layoutWorld(anchor);
  if (pose) trashBin.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
  xrHint.hidden = false;
  xrHint.textContent = 'Pinch a title bar to grab a window · poke a button to click it';
  setTimeout(() => { xrHint.hidden = true; }, 5000);
}

function computeRoomAnchor() {
  const forward = getForwardXZ(camera);
  const right = getRightXZ(forward);
  return { pos: camera.position.clone(), forward, right };
}

// ── Grab / poke logic (shared by hands, controllers, mouse) ─────────────────
const grabMap = new Map(); // inputId -> { win, mode, offset/offsetMatrix, lastPoint, velocity }
const pokeState = new Map(); // "handedness:winId" -> { buttonId, lastFired }

function nearestGrabbableAt(point) {
  let best = null, bestDist = Infinity;
  windows.forEach((win) => {
    if (win.fixed || win.grabbedBy) return;
    const barFrac = 64 / win.canvas.height; // title bar strip fraction from drawCardFrame
    const barCenterLocal = new THREE.Vector3(0, win.height / 2 - (win.height * barFrac) / 2, 0.01);
    const barWorld = win.group.localToWorld(barCenterLocal.clone());
    const d = barWorld.distanceTo(point);
    if (d < GRAB_RADIUS && d < bestDist) { best = win; bestDist = d; }
  });
  return best;
}

function beginGrab(inputId, win, point) {
  win.grabbedBy = inputId;
  win.state = 'grabbed';
  win.velocity.set(0, 0, 0);
  grabMap.set(inputId, {
    win, offset: win.group.position.clone().sub(point), lastPoint: point.clone(), velocity: new THREE.Vector3(),
  });
}

function updateGrab(inputId, point, dt) {
  const g = grabMap.get(inputId);
  if (!g) return;
  const newPos = point.clone().add(g.offset);
  if (dt > 0) g.velocity.copy(newPos).sub(g.win.group.position).divideScalar(dt);
  g.win.group.position.copy(newPos);
  g.lastPoint = point.clone();
}

function endGrab(inputId) {
  const g = grabMap.get(inputId);
  if (!g) return;
  const { win, velocity } = g;
  grabMap.delete(inputId);
  win.grabbedBy = null;

  const flatDist = trashBin.visible ? win.group.position.distanceTo(trashBin.position) : Infinity;
  if (flatDist < TRASH_CAPTURE_RADIUS) {
    trashify(win);
  } else {
    win.state = 'settling';
    win.velocity.copy(velocity).clampLength(0, 1.5);
    win.anchor.copy(win.group.position);
    clampToReach(win);
  }
}

function clampToReach(win) {
  if (!roomAnchor) return;
  const flat = new THREE.Vector3(win.anchor.x - roomAnchor.pos.x, 0, win.anchor.z - roomAnchor.pos.z);
  const dist = flat.length();
  if (dist > MAX_HOLD_DIST) { flat.setLength(MAX_HOLD_DIST); win.anchor.x = roomAnchor.pos.x + flat.x; win.anchor.z = roomAnchor.pos.z + flat.z; }
  if (dist < MIN_HOLD_DIST) { flat.setLength(MIN_HOLD_DIST); win.anchor.x = roomAnchor.pos.x + flat.x; win.anchor.z = roomAnchor.pos.z + flat.z; }
}

let audioCtx = null;
function playTrashSound() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(520, audioCtx.currentTime);
    o.frequency.exponentialRampToValueAtTime(90, audioCtx.currentTime + 0.28);
    g.gain.setValueAtTime(0.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.3);
  } catch (err) { /* audio optional */ }
}

function trashify(win) {
  win.state = 'trashing';
  win.trashStart = performance.now();
  win.trashFrom = win.group.position.clone();
  playTrashSound();
}

function finalizeTrash(win) {
  win.state = 'closed';
  win.group.visible = false;
  closedWindows.push(win.id);
  windows.get('dock')?.redraw();
}

function restoreAll() {
  if (!roomAnchor) return;
  closedWindows.length = 0;
  windows.forEach((win) => {
    if (win.id === 'dock') return;
    win.group.visible = true;
    win.state = 'idle';
    win.mesh.material.opacity = 1;
    win.group.scale.set(1, 1, 1);
  });
  layoutWorld(roomAnchor);
  windows.get('dock')?.redraw();
}

function computeCanvasHit(win, worldPoint) {
  const local = win.group.worldToLocal(worldPoint.clone());
  const halfW = win.width / 2, halfH = win.height / 2;
  if (Math.abs(local.x) > halfW || Math.abs(local.y) > halfH) return null;
  if (local.z < -0.015 || local.z > POKE_DEPTH) return null;
  const u = local.x / halfW / 2 + 0.5;
  const v = 0.5 - local.y / halfH / 2;
  const px = u * win.canvas.width, py = v * win.canvas.height;
  const hit = win.buttons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
  return hit ? hit.id : null;
}

function tryPoke(handKey, win, fingerWorldPos) {
  const buttonId = computeCanvasHit(win, fingerWorldPos);
  const key = `${handKey}:${win.id}`;
  const prev = pokeState.get(key);
  if (buttonId) {
    if (!prev || prev.buttonId !== buttonId) {
      const now = performance.now();
      if (!prev || now - prev.lastFired > POKE_COOLDOWN) {
        win.onButton && win.onButton(buttonId);
        win.press(buttonId);
        pokeState.set(key, { buttonId, lastFired: now });
      } else {
        pokeState.set(key, { buttonId, lastFired: prev.lastFired });
      }
    }
  } else if (prev) {
    pokeState.delete(key);
  }
}

// ── Hands & controllers ──────────────────────────────────────────────────────
const HAND_JOINTS = ['thumb-tip', 'index-finger-tip'];

function pinchPointFromHand(inputSource, frame, refSpace) {
  const thumb = inputSource.hand.get('thumb-tip');
  const index = inputSource.hand.get('index-finger-tip');
  if (!thumb || !index) return null;
  const tp = frame.getJointPose(thumb, refSpace);
  const ip = frame.getJointPose(index, refSpace);
  if (!tp || !ip) return null;
  const t = new THREE.Vector3(tp.transform.position.x, tp.transform.position.y, tp.transform.position.z);
  const i = new THREE.Vector3(ip.transform.position.x, ip.transform.position.y, ip.transform.position.z);
  return { pinch: t.clone().lerp(i, 0.5), indexTip: i, thumbTip: t };
}

function controllerPoint(inputSource, frame, refSpace) {
  const pose = frame.getPose(inputSource.targetRaySpace, refSpace);
  if (!pose) return null;
  return new THREE.Vector3(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
}

function onSelectStart(e) {
  const { inputSource, frame } = e;
  const refSpace = renderer.xr.getReferenceSpace();
  if (placementMode) {
    if (hitTestSource) {
      const results = frame.getHitTestResults(hitTestSource);
      if (results.length) { finishPlacement(results[0].getPose(refSpace)); return; }
    }
    finishPlacement(null);
    return;
  }
  if (inputSource.hand) {
    const p = pinchPointFromHand(inputSource, frame, refSpace);
    if (!p) return;
    const win = nearestGrabbableAt(p.pinch);
    if (win) beginGrab(inputSource, win, p.pinch);
  } else {
    const point = controllerPoint(inputSource, frame, refSpace);
    if (!point) return;
    // raycast along the ray for a title-bar grab or a button poke
    const pose = frame.getPose(inputSource.targetRaySpace, refSpace);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(
      new THREE.Quaternion(pose.transform.orientation.x, pose.transform.orientation.y, pose.transform.orientation.z, pose.transform.orientation.w)
    );
    const raycaster = new THREE.Raycaster(point, dir, 0, 4);
    const hits = raycaster.intersectObjects([...windows.values()].map((w) => w.mesh));
    if (hits.length) {
      const win = [...windows.values()].find((w) => w.mesh === hits[0].object);
      const worldPoint = hits[0].point;
      const buttonId = computeCanvasHit(win, worldPoint);
      if (buttonId) { win.onButton && win.onButton(buttonId); win.press(buttonId); return; }
      if (!win.fixed) beginGrab(inputSource, win, worldPoint);
    }
  }
}

function onSelectEnd(e) { endGrab(e.inputSource); }

function updateInputsPerFrame(frame, dt) {
  if (!frame) return;
  const refSpace = renderer.xr.getReferenceSpace();
  const session = frame.session;
  if (placementMode && hitTestSource) {
    const results = frame.getHitTestResults(hitTestSource);
    if (results.length) {
      const pose = results[0].getPose(refSpace);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
    } else reticle.visible = false;
  }

  for (const inputSource of session.inputSources) {
    if (inputSource.hand) {
      const p = pinchPointFromHand(inputSource, frame, refSpace);
      if (!p) continue;
      if (grabMap.has(inputSource)) updateGrab(inputSource, p.pinch, dt);
      windows.forEach((win) => { if (!win.fixed) tryPoke(inputSource.handedness, win, p.indexTip); });
    } else if (grabMap.has(inputSource)) {
      const point = controllerPoint(inputSource, frame, refSpace);
      if (point) updateGrab(inputSource, point, dt);
    }
  }
}

// ── Desktop / preview mouse fallback ────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let mouseDragPlane = null;
const MOUSE_ID = 'mouse';

function meshList() { return [...windows.values()].map((w) => w.mesh); }
function winForMesh(mesh) { return [...windows.values()].find((w) => w.mesh === mesh); }

function onPointerDown(ev) {
  if (renderer.xr.isPresenting) return;
  ndc.x = (ev.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(meshList());
  if (!hits.length) return;
  const win = winForMesh(hits[0].object);
  const worldPoint = hits[0].point;
  const buttonId = computeCanvasHit(win, worldPoint);
  if (buttonId) { win.onButton && win.onButton(buttonId); win.press(buttonId); return; }
  if (win.fixed) return;
  const local = win.group.worldToLocal(worldPoint.clone());
  const barFrac = 64 / win.canvas.height;
  if (local.y < win.height / 2 - win.height * barFrac) return; // only title bar grabs
  controls.enabled = false;
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  mouseDragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, worldPoint);
  beginGrab(MOUSE_ID, win, worldPoint);
}
function onPointerMove(ev) {
  if (!grabMap.has(MOUSE_ID)) return;
  ndc.x = (ev.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(ev.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const target = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(mouseDragPlane, target)) updateGrab(MOUSE_ID, target, 1 / 60);
}
function onPointerUp() {
  if (grabMap.has(MOUSE_ID)) endGrab(MOUSE_ID);
  controls.enabled = currentMode === 'preview';
}
renderer.domElement.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);

// ── Session lifecycle ────────────────────────────────────────────────────────
let currentMode = 'none';
let xrSession = null;

async function checkSupport() {
  if (!navigator.xr) {
    supportStatus.textContent = 'WebXR not available — use Preview';
    btnAR.disabled = true; btnVR.disabled = true;
    return;
  }
  const ar = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
  const vr = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  btnAR.disabled = !ar; btnVR.disabled = !vr;
  supportStatus.textContent = ar ? 'Mixed Reality ready' : (vr ? 'AR unsupported — VR available' : 'No immersive session on this device');
}
checkSupport();

async function enterXR(mode) {
  try {
    const optionalFeatures = ['hand-tracking', 'dom-overlay'];
    if (mode === 'immersive-ar') optionalFeatures.push('hit-test');
    const session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures,
      domOverlay: { root: overlay },
    });
    await onSessionStarted(session, mode);
  } catch (err) {
    supportStatus.textContent = `Could not start: ${err.message || err}`;
  }
}

async function onSessionStarted(session, mode) {
  xrSession = session;
  currentMode = mode;
  controls.enabled = false;
  session.addEventListener('end', onSessionEnded);
  session.addEventListener('selectstart', onSelectStart);
  session.addEventListener('selectend', onSelectEnd);
  try {
    await renderer.xr.setSession(session);
  } catch (err) {
    supportStatus.textContent = `Session failed: ${err.message || err}`;
    session.end();
    return;
  }
  applyEnvironmentForMode(mode);
  landing.hidden = true;
  exitBtn.hidden = false;
  xrHint.hidden = false;
  xrHint.textContent = 'Setting up your holo-room…';

  if (mode === 'immersive-ar') {
    await tryStartPlacement(session);
    if (!placementMode) finishPlacement(null);
  } else {
    finishPlacement(null);
  }
}

function onSessionEnded() {
  currentMode = 'none';
  xrSession = null;
  grabMap.clear();
  landing.hidden = false;
  exitBtn.hidden = true;
  xrHint.hidden = true;
  applyEnvironmentForMode('preview');
}

exitBtn.addEventListener('click', () => {
  if (xrSession) { xrSession.end(); return; }
  if (currentMode === 'preview') {
    currentMode = 'none';
    landing.hidden = false;
    exitBtn.hidden = true;
    controls.enabled = false;
  }
});
btnAR.addEventListener('click', () => enterXR('immersive-ar'));
btnVR.addEventListener('click', () => enterXR('immersive-vr'));
btnPreview.addEventListener('click', () => {
  currentMode = 'preview';
  landing.hidden = true;
  exitBtn.hidden = false;
  controls.enabled = true;
  applyEnvironmentForMode('preview');
  const anchor = { pos: new THREE.Vector3(0, 1.6, 0), forward: new THREE.Vector3(0, 0, -1), right: new THREE.Vector3(1, 0, 0) };
  layoutWorld(anchor);
});

function applyEnvironmentForMode(mode) {
  if (mode === 'immersive-ar') {
    scene.background = null;
    envGroup.visible = false;
  } else {
    scene.background = new THREE.Color(COLOR.bg);
    envGroup.visible = true;
  }
}
applyEnvironmentForMode('preview');

// ── Animation loop ───────────────────────────────────────────────────────────
let lastTime = 0;
renderer.setAnimationLoop((time, frame) => {
  const dt = lastTime ? Math.min(0.05, (time - lastTime) / 1000) : 0;
  lastTime = time;

  if (frame) updateInputsPerFrame(frame, dt);
  if (controls.enabled) controls.update();

  // dock always follows the head a little
  updateDockFollow(dt || 0.016);

  // ambient particles drift
  const t = time / 1000;
  const dummy = new THREE.Object3D();
  particles.forEach((p, i) => {
    const angle = p.baseAngle + t * p.speed;
    const y = p.height + Math.sin(t * 0.6 + p.bobPhase) * p.bobAmp;
    dummy.position.set(Math.cos(angle) * p.radius, y, Math.sin(angle) * p.radius);
    if (roomAnchor) dummy.position.add(new THREE.Vector3(roomAnchor.pos.x, 0, roomAnchor.pos.z));
    dummy.updateMatrix();
    particleMesh.setMatrixAt(i, dummy.matrix);
  });
  particleMesh.instanceMatrix.needsUpdate = true;

  // trash bin idle pulse + drag-proximity highlight
  let nearBin = false;
  grabMap.forEach((g) => {
    if (trashBin.visible && g.win.group.position.distanceTo(trashBin.position) < TRASH_CAPTURE_RADIUS * 1.4) nearBin = true;
  });
  const pulse = 0.5 + Math.sin(t * (nearBin ? 8 : 2)) * 0.5;
  trashBin.userData.ring.material.opacity = nearBin ? 0.35 + pulse * 0.5 : 0.2 + pulse * 0.15;
  trashBin.userData.rim.scale.setScalar(nearBin ? 1 + pulse * 0.15 : 1);
  labelWin.quaternion.copy(camera.quaternion); // screen-aligned billboard (label is a child of trashBin, which never rotates)

  // windows: billboard + settle physics + bob + trash animation
  windows.forEach((win) => {
    if (win.fixed || win.state === 'closed') return;

    if (win.state === 'trashing') {
      const elapsed = (performance.now() - win.trashStart) / 450;
      if (elapsed >= 1) { finalizeTrash(win); return; }
      win.group.position.lerpVectors(win.trashFrom, trashBin.position, elapsed * 0.9);
      win.group.position.y += 0.15 * Math.sin(elapsed * Math.PI);
      win.group.scale.setScalar(1 - elapsed);
      win.mesh.material.opacity = 1 - elapsed;
      win.group.rotation.y += dt * 10;
      return;
    }

    if (win.grabbedBy) {
      billboardY(win.group, camera.position);
      return;
    }

    if (win.state === 'settling' && win.velocity.lengthSq() > 0.0004) {
      win.group.position.addScaledVector(win.velocity, dt);
      win.velocity.multiplyScalar(Math.max(0, 1 - dt * 4));
      win.anchor.copy(win.group.position);
      clampToReach(win);
    } else {
      win.state = 'idle';
      win.velocity.set(0, 0, 0);
      const bob = Math.sin(t * 0.8 + win.bobPhase) * 0.012;
      win.group.position.set(win.anchor.x, win.anchor.y + bob, win.anchor.z);
    }
    billboardY(win.group, camera.position);
  });

  renderer.render(scene, camera);
});
