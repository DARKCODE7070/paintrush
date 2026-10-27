// Pure game rules: no networking, no timers. Easy to unit test and simulate.
//
// The world is a flat grid. Each cell has an owner (0 = nobody) and an optional
// trail (the id of the player currently drawing a line through it).
//
// Rules
//  - Leave your territory and you draw a trail. Return to it and the loop closes:
//    everything enclosed becomes yours (flood fill from the map border).
//  - Touch someone's trail (including your own) and that player is eliminated.
//  - Enclosing another player's trail also eliminates them.
//  - Losing all your territory eliminates you. Dead players respawn after a delay.

export const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up, right, down, left
export const MAX_PLAYERS = 12;
export const RESPAWN_TICKS = 30;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  constructor({ w = 60, h = 60, rng = Math.random } = {}) {
    this.w = w;
    this.h = h;
    this.N = w * h;
    this.rng = rng;
    this.owner = new Uint8Array(this.N);
    this.trail = new Uint8Array(this.N);
    this.counts = new Int32Array(MAX_PLAYERS + 1); // territory size per player id
    this.players = new Map();
    this.changed = new Set(); // cell indices modified since last flush()
    this.events = []; // events since last flush()
    this.tickNo = 0;
    this._seen = new Uint8Array(this.N);
    this._stack = new Int32Array(this.N);
  }

  // ---- low level cell writes (keep counts + change tracking correct) ----
  setOwner(i, o) {
    const old = this.owner[i];
    if (old === o) return;
    if (old) this.counts[old]--;
    if (o) this.counts[o]++;
    this.owner[i] = o;
    this.changed.add(i);
  }

  setTrail(i, t) {
    if (this.trail[i] === t) return;
    this.trail[i] = t;
    this.changed.add(i);
  }

  // ---- players ----
  addPlayer(id, name, bot = false) {
    const p = {
      id, name, bot,
      x: 0, y: 0, dir: -1,
      alive: false, trail: [], kills: 0, deaths: 0,
      queue: [], respawnAt: 0, ai: null,
    };
    this.players.set(id, p);
    this.spawn(p);
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    for (const i of p.trail) if (this.trail[i] === id) this.setTrail(i, 0);
    p.trail = [];
    for (let i = 0; i < this.N; i++) if (this.owner[i] === id) this.setOwner(i, 0);
    this.players.delete(id);
  }

  areaFree(cx, cy, r) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const i = (cy + dy) * this.w + cx + dx;
        if (this.owner[i] || this.trail[i]) return false;
      }
    }
    return true;
  }

  spawn(p) {
    const { w, h, rng } = this;
    const M = 3;
    const pick = () => [M + Math.floor(rng() * (w - 2 * M)), M + Math.floor(rng() * (h - 2 * M))];
    let [x, y] = pick();
    for (let tries = 0; tries < 400; tries++) {
      const [cx, cy] = pick();
      if (this.areaFree(cx, cy, 3)) { x = cx; y = cy; break; }
    }
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const i = (y + dy) * w + x + dx;
        const t = this.trail[i];
        if (t && t !== p.id) this.kill(this.players.get(t), null); // crowded map fallback
        this.setOwner(i, p.id);
      }
    }
    p.x = x; p.y = y; p.dir = -1;
    p.alive = true; p.trail = []; p.queue = [];
    this.events.push({ e: 'spawn', id: p.id, x, y });
  }

  setDir(id, d) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    if (!Number.isInteger(d) || d < 0 || d > 3) return;
    if (p.queue.length < 3) p.queue.push(d);
  }

  _applyQueue(p) {
    while (p.queue.length) {
      const d = p.queue.shift();
      if (p.dir < 0 || (d !== p.dir && d !== (p.dir + 2) % 4)) { p.dir = d; return; }
    }
  }

  kill(victim, killer, why = 'cut') {
    if (!victim || !victim.alive) return;
    victim.alive = false;
    victim.dir = -1;
    victim.queue = [];
    victim.deaths++;
    for (const i of victim.trail) if (this.trail[i] === victim.id) this.setTrail(i, 0);
    victim.trail = [];
    for (let i = 0; i < this.N; i++) if (this.owner[i] === victim.id) this.setOwner(i, 0);
    victim.respawnAt = this.tickNo + RESPAWN_TICKS;
    const k = killer && killer !== victim ? killer : null;
    if (k) k.kills++;
    this.events.push({ e: 'kill', victim: victim.id, killer: k ? k.id : 0, why, x: victim.x, y: victim.y });
  }

  // Close a loop: trail becomes territory, then everything the border flood
  // fill cannot reach (and that is not already ours) is enclosed and claimed.
  capture(p) {
    const { w, h, N, owner, trail } = this;
    let gained = p.trail.length;
    for (const i of p.trail) { this.setTrail(i, 0); this.setOwner(i, p.id); }
    p.trail = [];

    const seen = this._seen;
    const st = this._stack;
    seen.fill(0);
    let sp = 0;
    const push = (i) => {
      if (!seen[i] && owner[i] !== p.id) { seen[i] = 1; st[sp++] = i; }
    };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const i = st[--sp];
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }

    const victims = new Set();
    for (let i = 0; i < N; i++) {
      if (!seen[i] && owner[i] !== p.id) {
        const t = trail[i];
        if (t && t !== p.id) victims.add(t);
        this.setOwner(i, p.id);
        gained++;
      }
    }
    for (const v of victims) this.kill(this.players.get(v), p, 'enclosed');
    this.events.push({ e: 'capture', id: p.id, n: gained, x: p.x, y: p.y });
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Advance the simulation one step.
  tick() {
    this.tickNo++;
    const { w, h } = this;

    for (const p of this.players.values()) {
      if (!p.alive && this.tickNo >= p.respawnAt) this.spawn(p);
    }

    const order = this._shuffle([...this.players.values()].filter((p) => p.alive));
    for (const p of order) {
      if (!p.alive) continue; // killed earlier this tick
      this._applyQueue(p);
      if (p.dir < 0) continue;
      const nx = p.x + DIRS[p.dir][0];
      const ny = p.y + DIRS[p.dir][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // walls just block
      const idx = ny * w + nx;
      const t = this.trail[idx];
      if (t === p.id) { this.kill(p, p, 'self'); continue; } // ran into own trail
      if (t) this.kill(this.players.get(t), p); // cut someone's trail
      p.x = nx;
      p.y = ny;
      if (this.owner[idx] === p.id) {
        if (p.trail.length) this.capture(p);
      } else {
        this.setTrail(idx, p.id);
        p.trail.push(idx);
      }
    }

    for (const p of this.players.values()) {
      if (p.alive && this.counts[p.id] === 0) this.kill(p, null, 'wiped'); // lost everything
    }
  }

  // Cells and events changed since the last call, as compact arrays.
  flush() {
    const cells = [];
    for (const i of this.changed) cells.push(i, this.owner[i], this.trail[i]);
    this.changed.clear();
    const events = this.events;
    this.events = [];
    return { cells, events };
  }

  standings() {
    return [...this.players.values()]
      .map((p) => ({
        id: p.id, name: p.name, bot: p.bot,
        count: this.counts[p.id],
        pct: (this.counts[p.id] / this.N) * 100,
        kills: p.kills,
      }))
      .sort((a, b) => b.count - a.count || b.kills - a.kills);
  }

  // Start a fresh round with the same players.
  reset() {
    this.owner.fill(0);
    this.trail.fill(0);
    this.counts.fill(0);
    for (const p of this.players.values()) {
      p.kills = 0; p.deaths = 0; p.alive = false; p.trail = []; p.queue = []; p.ai = null;
    }
    for (const p of this.players.values()) this.spawn(p);
    this.changed.clear();
    this.events = [];
  }
}
