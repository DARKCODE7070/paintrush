// Paintrush client: canvas renderer, input, audio, HUD. The server is authoritative;
// this file only sends direction inputs and draws what the server says.
'use strict';

// ---------- palette ----------
const PAL = ['#ff3d71', '#00e5ff', '#ffd60a', '#7cff4d', '#b26bff', '#ff8a00', '#2d7dff', '#ff4dd2', '#00ffa3', '#ff5e3a', '#c6ff00', '#9aa7ff'];
const RGB = PAL.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const LIGHT = RGB.map(([r, g, b]) => `rgb(${(r + (255 - r) * 0.5) | 0},${(g + (255 - g) * 0.5) | 0},${(b + (255 - b) * 0.5) | 0})`);
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const FONT = 'ui-rounded, "SF Pro Rounded", "Segoe UI", system-ui, sans-serif';
const col = (id) => PAL[(id - 1) % PAL.length];
const idx = (id) => (id - 1) % PAL.length;

const $ = (s) => document.querySelector(s);
const cv = $('#game');
const ctx = cv.getContext('2d');
const mini = $('#mini');
const mctx = mini.getContext('2d');

// ---------- state ----------
const S = {
  ws: null, inGame: false, you: 0, code: '',
  w: 60, h: 60, tickMs: 100, roundTicks: 1200, left: 1200, phase: 'playing',
  owner: new Uint8Array(3600), trail: new Uint8Array(3600), ownT: new Float32Array(3600),
  players: new Map(), dirty: true,
};
const cam = { x: 30, y: 30, zoom: 1 };
const parts = [];
const floaters = [];
const confetti = [];
let W = 0, H = 0, dpr = 1, ts = 30, ox = 0, oy = 0;
let shake = 0;
let deathUntil = 0;
let resultsEndAt = 0;
let lastFrame = performance.now();

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth;
  H = window.innerHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = `${W}px`;
  cv.style.height = `${H}px`;
}
window.addEventListener('resize', resize);
resize();

// ---------- audio (tiny synth, no assets) ----------
let actx = null;
let muted = false;
try { muted = localStorage.getItem('pr_mute') === '1'; } catch { /* ignore */ }
function audio() {
  if (muted) return null;
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function tone(f, dur, type = 'sine', vol = 0.07, slide = 0, delay = 0) {
  const a = audio();
  if (!a) return;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, f + slide), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}
function noise(dur, vol = 0.12) {
  const a = audio();
  if (!a) return;
  const len = (a.sampleRate * dur) | 0;
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = vol;
  s.buffer = buf;
  s.connect(g).connect(a.destination);
  s.start();
}
const sfx = {
  capture(n) { tone(360 + Math.min(n, 120) * 5, 0.14, 'triangle', 0.08, 220); tone(560 + Math.min(n, 120) * 6, 0.18, 'sine', 0.05, 0, 0.07); },
  kill() { tone(520, 0.1, 'square', 0.04, 300); tone(780, 0.16, 'square', 0.04, 0, 0.08); },
  death() { noise(0.45, 0.14); tone(240, 0.5, 'sawtooth', 0.06, -170); },
  start() { tone(440, 0.09, 'triangle', 0.07); tone(660, 0.14, 'triangle', 0.07, 0, 0.09); },
  win() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.28, 'triangle', 0.07, 0, i * 0.1)); },
};
const muteBtn = $('#mute');
function syncMute() { muteBtn.textContent = muted ? 'Sound off' : 'Sound on'; }
muteBtn.addEventListener('click', () => {
  muted = !muted;
  try { localStorage.setItem('pr_mute', muted ? '1' : '0'); } catch { /* ignore */ }
  syncMute();
  if (!muted) sfx.start();
});
syncMute();

// ---------- networking ----------
const lobbyEl = $('#lobby');
const hudEl = $('#hud');
const resultsEl = $('#results');
const deathEl = $('#death');
const nameEl = $('#name');
const codeEl = $('#code');
const toastEl = $('#toast');
let toastTimer = 0;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function setBusy(b) {
  for (const id of ['quick', 'create', 'join']) {
    const el = $(`#${id}`);
    el.disabled = b;
    el.style.opacity = b ? 0.6 : 1;
  }
}

function connect(mode, code = '') {
  if (S.ws) return;
  const name = nameEl.value.trim();
  try { localStorage.setItem('pr_name', name); } catch { /* ignore */ }
  audio();
  setBusy(true);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', mode, code, name }));
  ws.onmessage = (ev) => {
    try { onMessage(JSON.parse(ev.data)); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.ws = null;
    setBusy(false);
    if (S.inGame) { toast('Disconnected from the server'); toLobby(); } else toast('Could not reach the server');
  };
}

function sendDir(d) {
  if (S.ws && S.ws.readyState === 1 && S.inGame && S.phase === 'playing') S.ws.send(`{"t":"dir","d":${d}}`);
}

function onMessage(m) {
  switch (m.t) {
    case 'welcome':
    case 'reset': loadSnapshot(m); break;
    case 's': applyState(m); break;
    case 'roster': applyRoster(m.roster); updateHud(); break;
    case 'end': showResults(m); break;
    case 'error': {
      const ws = S.ws;
      S.ws = null;
      if (ws) ws.close();
      setBusy(false);
      toast(m.msg);
      break;
    }
    default: break;
  }
}

function loadSnapshot(m) {
  const first = m.t === 'welcome';
  S.you = m.you; S.w = m.w; S.h = m.h; S.tickMs = m.tickMs; S.roundTicks = m.roundTicks;
  S.left = m.ticksLeft; S.phase = m.phase; S.code = m.code;
  S.owner = Uint8Array.from(m.owner);
  S.trail = Uint8Array.from(m.trail);
  S.ownT = new Float32Array(S.w * S.h);
  if (first) S.players.clear();
  applyRoster(m.roster);
  const now = performance.now();
  for (const pl of m.players) setPlayerState(pl, true, now);
  parts.length = 0; floaters.length = 0;
  S.dirty = true;
  const me = S.players.get(S.you);
  if (me) { cam.x = me.cx + 0.5; cam.y = me.cy + 0.5; }
  resultsEl.classList.add('hidden');
  deathEl.classList.add('hidden');
  if (first) {
    S.inGame = true;
    lobbyEl.classList.add('hidden');
    hudEl.classList.remove('hidden');
    $('#roomcode').textContent = S.code;
    setBusy(false);
    try { history.replaceState(null, '', location.pathname); } catch { /* ignore */ }
  }
  sfx.start();
  updateHud();
}

function applyRoster(roster) {
  const seen = new Set();
  for (const e of roster) {
    seen.add(e.id);
    let p = S.players.get(e.id);
    if (!p) {
      p = { id: e.id, px: 0, py: 0, cx: 0, cy: 0, dir: -1, face: 1, alive: false, count: 0, kills: 0, tAt: 0 };
      S.players.set(e.id, p);
    }
    p.name = e.name;
    p.bot = e.bot;
  }
  for (const id of [...S.players.keys()]) if (!seen.has(id)) S.players.delete(id);
}

function setPlayerState(a, snap, now) {
  const [id, x, y, d, alive, count, kills] = a;
  const p = S.players.get(id);
  if (!p) return;
  const was = p.alive;
  p.alive = !!alive; p.dir = d; p.count = count; p.kills = kills;
  if (d >= 0) p.face = d;
  if (snap || !was || !p.alive) { p.px = p.cx = x; p.py = p.cy = y; } else { p.px = p.cx; p.py = p.cy; p.cx = x; p.cy = y; }
  p.tAt = now;
}

function applyState(m) {
  const now = performance.now();
  S.left = m.left;
  const c = m.c;
  for (let i = 0; i < c.length; i += 3) {
    const k = c[i];
    if (S.owner[k] !== c[i + 1]) { S.owner[k] = c[i + 1]; S.ownT[k] = now; }
    S.trail[k] = c[i + 2];
  }
  if (c.length) S.dirty = true;
  for (const pl of m.p) setPlayerState(pl, false, now);
  for (const e of m.e) handleEvent(e, now);
  updateHud();
}

function handleEvent(e) {
  if (e.e === 'capture') {
    const color = col(e.id);
    burst(e.x + 0.5, e.y + 0.5, color, Math.min(40, 8 + (e.n >> 1)), 6);
    floaters.push({ text: `+${e.n}`, x: e.x + 0.5, y: e.y - 0.3, color, life: 0, max: 1.2 });
    if (e.id === S.you) { sfx.capture(e.n); shake = Math.max(shake, Math.min(9, e.n / 7)); }
  } else if (e.e === 'kill') {
    burst(e.x + 0.5, e.y + 0.5, col(e.victim), 46, 10);
    addFeed(e);
    if (e.victim === S.you) {
      sfx.death();
      shake = 14;
      showDeath(e);
    } else if (e.killer === S.you) {
      sfx.kill();
      shake = Math.max(shake, 7);
    }
  } else if (e.e === 'spawn') {
    burst(e.x + 0.5, e.y + 0.5, col(e.id), 16, 4);
    if (e.id === S.you) deathEl.classList.add('hidden');
  }
}

// ---------- particles ----------
function burst(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random() * 0.9);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.45 + Math.random() * 0.6, size: 0.07 + Math.random() * 0.14, color });
  }
  if (parts.length > 700) parts.splice(0, parts.length - 700);
}

function partyTime() {
  for (let i = 0; i < 140; i++) {
    confetti.push({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.5,
      vx: (Math.random() - 0.5) * 160, vy: 120 + Math.random() * 240,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 12,
      c: PAL[(Math.random() * PAL.length) | 0], s: 5 + Math.random() * 6,
    });
  }
}

// ---------- HUD ----------
const boardEl = $('#board');
const feedEl = $('#feed');
const rows = new Map();

function makeRow(p) {
  const el = document.createElement('div');
  el.className = 'row';
  const bar = document.createElement('i');
  bar.className = 'bar';
  bar.style.background = col(p.id);
  const nm = document.createElement('span');
  nm.className = 'nm';
  const pc = document.createElement('span');
  el.append(bar, nm, pc);
  boardEl.append(el);
  return { el, bar, nm, pc };
}

function updateHud() {
  const total = S.w * S.h;
  const list = [...S.players.values()].sort((a, b) => b.count - a.count);
  const max = Math.max(1, list.length ? list[0].count : 1);
  const keep = new Set();
  list.forEach((p, rank) => {
    keep.add(p.id);
    let r = rows.get(p.id);
    if (!r) { r = makeRow(p); rows.set(p.id, r); }
    r.el.style.order = rank;
    r.el.style.display = rank < 6 || p.id === S.you ? '' : 'none';
    r.el.classList.toggle('me', p.id === S.you);
    r.el.classList.toggle('dead', !p.alive);
    r.bar.style.width = `${(p.count / max) * 100}%`;
    if (r.nm.textContent !== p.name) r.nm.textContent = p.name;
    r.pc.textContent = `${((p.count / total) * 100).toFixed(1)}%`;
  });
  for (const [id, r] of rows) if (!keep.has(id)) { r.el.remove(); rows.delete(id); }

  const secs = Math.max(0, Math.ceil((S.left * S.tickMs) / 1000));
  const t = $('#timer');
  t.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  t.classList.toggle('urgent', secs <= 10 && S.phase === 'playing');

  const me = S.players.get(S.you);
  if (me) {
    const pe = $('#mePct');
    pe.textContent = `${((me.count / total) * 100).toFixed(1)}%`;
    pe.style.color = col(me.id);
    $('#meSub').textContent = `${me.kills} ${me.kills === 1 ? 'elimination' : 'eliminations'}`;
    $('#hint').classList.toggle('hidden', !(me.alive && me.dir < 0 && S.phase === 'playing'));
  }
}

function addFeed(e) {
  const v = S.players.get(e.victim);
  const k = e.killer ? S.players.get(e.killer) : null;
  if (!v) return;
  const div = document.createElement('div');
  const tag = (p) => { const b = document.createElement('b'); b.textContent = p.name; b.style.color = col(p.id); return b; };
  if (k) div.append(tag(k), ' cut off ', tag(v));
  else div.append(tag(v), e.why === 'wiped' ? ' lost everything' : ' tangled up');
  feedEl.append(div);
  while (feedEl.children.length > 4) feedEl.firstChild.remove();
  setTimeout(() => { div.classList.add('out'); setTimeout(() => div.remove(), 520); }, 4200);
}

function showDeath(e) {
  const k = e.killer ? S.players.get(e.killer) : null;
  let why = 'You ran into your own trail';
  if (e.why === 'wiped') why = 'Your territory was captured';
  else if (e.why === 'enclosed' && k) why = `${k.name} enclosed your trail`;
  else if (k) why = `${k.name} cut your trail`;
  $('#deathBy').textContent = why;
  deathUntil = performance.now() + 3000;
  deathEl.classList.remove('hidden');
}

function showResults(m) {
  S.phase = 'ended';
  S.left = 0;
  deathEl.classList.add('hidden');
  $('#hint').classList.add('hidden');
  const list = $('#resList');
  list.textContent = '';
  const top = Math.max(1, m.results.length ? m.results[0].count : 1);
  m.results.slice(0, 8).forEach((r, i) => {
    const li = document.createElement('li');
    if (i === 0) li.classList.add('win');
    if (r.id === S.you) li.classList.add('you');
    const bar = document.createElement('i');
    bar.className = 'bar';
    bar.style.background = col(r.id);
    bar.style.width = `${(r.count / top) * 100}%`;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = r.name;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = `${r.kills} elim`;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = `${r.pct.toFixed(1)}%`;
    li.append(bar, n, k, v);
    list.append(li);
  });
  const win = m.results[0];
  $('#resTitle').textContent = win ? (win.id === S.you ? 'You win!' : `${win.name} wins`) : 'Round over';
  if (win && win.id === S.you) { partyTime(); sfx.win(); }
  resultsEndAt = performance.now() + m.next * 1000;
  resultsEl.classList.remove('hidden');
  updateHud();
}

function toLobby() {
  S.inGame = false;
  S.phase = 'playing';
  S.players.clear();
  for (const r of rows.values()) r.el.remove();
  rows.clear();
  hudEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  deathEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  loadLeaderboard();
}

async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard', { cache: 'no-store' });
    const data = await res.json();
    const ol = $('#lb');
    ol.textContent = '';
    if (!data.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No rounds finished yet. Be the first!';
      ol.append(li);
      return;
    }
    for (const e of data.slice(0, 5)) {
      const li = document.createElement('li');
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = e.name;
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = `${e.pct.toFixed(1)}%`;
      li.append(n, v);
      ol.append(li);
    }
  } catch { /* offline: leave placeholder */ }
}

// ---------- minimap ----------
const off = document.createElement('canvas');
const octx = off.getContext('2d');
let miniImg = null;
function drawMini() {
  if (S.dirty || !miniImg) {
    if (off.width !== S.w || off.height !== S.h) { off.width = S.w; off.height = S.h; miniImg = octx.createImageData(S.w, S.h); }
    const d = miniImg.data;
    for (let i = 0; i < S.w * S.h; i++) {
      let r = 14, g = 19, b = 34;
      const o = S.owner[i];
      if (o) [r, g, b] = RGB[idx(o)];
      const tr = S.trail[i];
      if (tr) { const c = RGB[idx(tr)]; r = (r + c[0] + 255) / 3; g = (g + c[1] + 255) / 3; b = (b + c[2] + 255) / 3; }
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
    octx.putImageData(miniImg, 0, 0);
    S.dirty = false;
  }
  mctx.imageSmoothingEnabled = false;
  mctx.clearRect(0, 0, mini.width, mini.height);
  mctx.drawImage(off, 0, 0, mini.width, mini.height);
  const sx = mini.width / S.w;
  const sy = mini.height / S.h;
  const vw = W / ts;
  const vh = H / ts;
  mctx.strokeStyle = 'rgba(255,255,255,0.75)';
  mctx.lineWidth = 1.5;
  mctx.strokeRect((cam.x - vw / 2) * sx, (cam.y - vh / 2) * sy, vw * sx, vh * sy);
  const me = S.players.get(S.you);
  if (me && me.alive) {
    const pos = posOf(me, performance.now());
    mctx.fillStyle = '#fff';
    mctx.beginPath();
    mctx.arc((pos.x + 0.5) * sx, (pos.y + 0.5) * sy, 3.2, 0, Math.PI * 2);
    mctx.fill();
  }
}

// ---------- rendering ----------
function posOf(p, t) {
  const k = Math.min(1, Math.max(0, (t - p.tAt) / S.tickMs));
  return { x: p.px + (p.cx - p.px) * k, y: p.py + (p.cy - p.py) * k };
}
const easeOutBack = (k) => { const c1 = 1.9; const c3 = c1 + 1; return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2; };

function drawIdle(t) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#080b14';
  ctx.fillRect(0, 0, W, H);
  const size = 54;
  ctx.globalAlpha = 0.9;
  for (let i = 0; i < 34; i++) {
    const sp = 12 + (i % 7) * 5;
    const x = ((i * 197 + t * 0.001 * sp) % (W + size * 2)) - size;
    const y = ((i * 131 + t * 0.001 * sp * 0.6) % (H + size * 2)) - size;
    ctx.fillStyle = PAL[i % PAL.length];
    ctx.globalAlpha = 0.07 + 0.05 * Math.sin(t * 0.001 + i);
    ctx.fillRect(x, y, size, size);
  }
  ctx.globalAlpha = 1;
}

function drawWorld(t, dt) {
  const { w, h, owner, trail } = S;
  const me = S.players.get(S.you);

  // camera: follow our head, zoom out gently as we grow
  const target = me ? posOf(me, t) : { x: w / 2, y: h / 2 };
  cam.x += (target.x + 0.5 - cam.x) * (1 - Math.exp(-dt * 9));
  cam.y += (target.y + 0.5 - cam.y) * (1 - Math.exp(-dt * 9));
  const frac = me ? me.count / (w * h) : 0;
  const zt = 1 - Math.min(0.3, frac * 0.9);
  cam.zoom += (zt - cam.zoom) * (1 - Math.exp(-dt * 2));
  ts = Math.min(46, Math.max(12, Math.min(W, H) / 17)) * cam.zoom;

  shake *= Math.exp(-dt * 9);
  if (shake < 0.1) shake = 0;
  const shx = (Math.random() - 0.5) * shake;
  const shy = (Math.random() - 0.5) * shake;
  ox = W / 2 - cam.x * ts + shx;
  oy = H / 2 - cam.y * ts + shy;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, W, H);

  // arena floor + glowing border
  ctx.fillStyle = '#0d1322';
  ctx.fillRect(ox, oy, w * ts, h * ts);

  const x0 = Math.max(0, Math.floor(-ox / ts));
  const x1 = Math.min(w - 1, Math.floor((W - ox) / ts));
  const y0 = Math.max(0, Math.floor(-oy / ts));
  const y1 = Math.min(h - 1, Math.floor((H - oy) / ts));

  // faint grid
  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(x * ts + ox, y0 * ts + oy); ctx.lineTo(x * ts + ox, (y1 + 1) * ts + oy); }
  for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(x0 * ts + ox, y * ts + oy); ctx.lineTo((x1 + 1) * ts + ox, y * ts + oy); }
  ctx.stroke();

  // territory (cells pop in with a little overshoot when captured)
  const gap = Math.max(1, ts * 0.06);
  ctx.globalAlpha = 0.9;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const o = owner[i];
      if (!o) continue;
      const age = t - S.ownT[i];
      const s = age < 300 ? Math.max(0.15, easeOutBack(age / 300)) : 1;
      const sz = (ts - gap) * s;
      ctx.fillStyle = PAL[idx(o)];
      ctx.fillRect(x * ts + ox + (ts - sz) / 2, y * ts + oy + (ts - sz) / 2, sz, sz);
    }
  }
  ctx.globalAlpha = 1;

  // territory outlines
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const o = owner[i];
      if (!o) continue;
      const sx = x * ts + ox;
      const sy = y * ts + oy;
      if (x === 0 || owner[i - 1] !== o) { ctx.moveTo(sx, sy); ctx.lineTo(sx, sy + ts); }
      if (x === w - 1 || owner[i + 1] !== o) { ctx.moveTo(sx + ts, sy); ctx.lineTo(sx + ts, sy + ts); }
      if (y === 0 || owner[i - w] !== o) { ctx.moveTo(sx, sy); ctx.lineTo(sx + ts, sy); }
      if (y === h - 1 || owner[i + w] !== o) { ctx.moveTo(sx, sy + ts); ctx.lineTo(sx + ts, sy + ts); }
    }
  }
  ctx.stroke();

  // trails (glowing)
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const tr = trail[y * w + x];
      if (!tr) continue;
      ctx.shadowColor = PAL[idx(tr)];
      ctx.shadowBlur = ts * 0.55;
      ctx.fillStyle = LIGHT[idx(tr)];
      const m = ts * 0.2;
      ctx.beginPath();
      ctx.roundRect(x * ts + ox + m, y * ts + oy + m, ts - m * 2, ts - m * 2, ts * 0.18);
      ctx.fill();
    }
  }
  ctx.shadowBlur = 0;

  // arena border
  ctx.strokeStyle = 'rgba(0,229,255,0.55)';
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 16;
  ctx.lineWidth = 3;
  ctx.strokeRect(ox, oy, w * ts, h * ts);
  ctx.shadowBlur = 0;

  // heads + names
  const t2 = t * 0.004;
  for (const p of S.players.values()) {
    if (!p.alive) continue;
    const pos = posOf(p, t);
    const sx = (pos.x + 0.5) * ts + ox;
    const sy = (pos.y + 0.5) * ts + oy;
    if (sx < -60 || sy < -60 || sx > W + 60 || sy > H + 60) continue;
    const r = ts * 0.38;
    const c = PAL[idx(p.id)];
    if (p.id === S.you) {
      ctx.strokeStyle = `rgba(255,255,255,${0.45 + 0.3 * Math.sin(t2)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r * (1.7 + 0.15 * Math.sin(t2)), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowColor = c;
    ctx.shadowBlur = ts * 0.8;
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(1.5, ts * 0.05);
    ctx.stroke();
    // eyes look where we're heading
    const [fx, fy] = DIRS[p.face];
    for (const sgn of [-1, 1]) {
      const ex = sx + fx * r * 0.28 + -fy * sgn * r * 0.4;
      const ey = sy + fy * r * 0.28 + fx * sgn * r * 0.4;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(ex, ey, r * 0.24, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0a0f1c';
      ctx.beginPath(); ctx.arc(ex + fx * r * 0.09, ey + fy * r * 0.09, r * 0.12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = `700 ${Math.max(10, ts * 0.27)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(5,7,13,0.85)';
    ctx.strokeText(p.name, sx, sy - r * 1.55);
    ctx.fillStyle = '#fff';
    ctx.fillText(p.name, sx, sy - r * 1.55);
  }

  // particles (additive)
  ctx.globalCompositeOperation = 'lighter';
  for (let i = parts.length - 1; i >= 0; i--) {
    const q = parts[i];
    q.life += dt;
    if (q.life >= q.max) { parts.splice(i, 1); continue; }
    const damp = Math.exp(-dt * 3);
    q.vx *= damp; q.vy *= damp;
    q.x += q.vx * dt; q.y += q.vy * dt;
    const k = 1 - q.life / q.max;
    ctx.globalAlpha = k;
    ctx.fillStyle = q.color;
    ctx.beginPath();
    ctx.arc(q.x * ts + ox, q.y * ts + oy, Math.max(0.5, q.size * ts * (0.4 + k)), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;

  // floating "+N"
  ctx.textAlign = 'center';
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life += dt;
    if (f.life >= f.max) { floaters.splice(i, 1); continue; }
    const k = f.life / f.max;
    ctx.globalAlpha = 1 - k * k;
    ctx.font = `900 ${Math.max(14, ts * 0.6)}px ${FONT}`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(5,7,13,0.8)';
    const fx = f.x * ts + ox;
    const fy = (f.y - k * 1.6) * ts + oy;
    ctx.strokeText(f.text, fx, fy);
    ctx.shadowColor = f.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#fff';
    ctx.fillText(f.text, fx, fy);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  drawMini();
}

function drawConfetti(dt) {
  if (!confetti.length) return;
  for (let i = confetti.length - 1; i >= 0; i--) {
    const c = confetti[i];
    c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
    c.vx *= Math.exp(-dt * 0.6);
    if (c.y > H + 30) { confetti.splice(i, 1); continue; }
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.fillStyle = c.c;
    ctx.fillRect(-c.s / 2, -c.s / 4, c.s, c.s / 2);
    ctx.restore();
  }
}

function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;
  if (!S.inGame) drawIdle(t); else drawWorld(t, dt);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawConfetti(dt);

  if (!deathEl.classList.contains('hidden')) {
    const n = Math.max(0, Math.ceil((deathUntil - t) / 1000));
    $('#deathTimer').textContent = n > 0 ? `Respawning in ${n}…` : 'Respawning…';
  }
  if (!resultsEl.classList.contains('hidden')) {
    $('#resNext').textContent = `Next round in ${Math.max(0, Math.ceil((resultsEndAt - t) / 1000))}s`;
  }
}

// ---------- input ----------
const KEYS = {
  ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3,
};
window.addEventListener('keydown', (e) => {
  if (!S.inGame || e.repeat) return;
  const d = KEYS[e.code];
  if (d === undefined) return;
  e.preventDefault();
  audio();
  sendDir(d);
});

let touch = null;
window.addEventListener('touchstart', (e) => {
  if (!S.inGame) return;
  const p = e.touches[0];
  touch = { x: p.clientX, y: p.clientY };
  audio();
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (!touch || !S.inGame) return;
  const p = e.touches[0];
  const dx = p.clientX - touch.x;
  const dy = p.clientY - touch.y;
  if (Math.hypot(dx, dy) > 20) {
    sendDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0));
    touch = { x: p.clientX, y: p.clientY };
  }
}, { passive: true });
window.addEventListener('touchend', () => { touch = null; }, { passive: true });

// ---------- lobby wiring ----------
try { nameEl.value = localStorage.getItem('pr_name') || ''; } catch { /* ignore */ }
const invite = new URLSearchParams(location.search).get('room');
if (invite) { codeEl.value = invite.toUpperCase().slice(0, 6); }

$('#quick').addEventListener('click', () => connect('quick'));
$('#create').addEventListener('click', () => connect('create'));
$('#join').addEventListener('click', () => {
  const code = codeEl.value.trim().toUpperCase();
  if (code.length < 4) { toast('Enter a 4-letter room code'); codeEl.focus(); return; }
  connect('join', code);
});
codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#join').click(); });
nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') (codeEl.value ? $('#join') : $('#quick')).click(); });
$('#roomcode').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${S.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(`Room code: ${S.code}`); }
});

loadLeaderboard();
requestAnimationFrame(frame);
if (invite) codeEl.focus(); else nameEl.focus();
