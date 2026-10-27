// One Room = one match. Owns a Game, the connected clients, bots and the round
// timer. Everything the clients see is derived from server state; clients only
// ever send direction inputs.
import { Game, MAX_PLAYERS } from './game.js';
import { botThink } from './bots.js';

export const MAX_HUMANS = 10;
const MIN_PLAYERS = 6; // humans + bots, so a lobby never feels empty
const BOT_NAMES = [
  'Pixel', 'Nova', 'Blitz', 'Echo', 'Zap', 'Mochi', 'Orbit',
  'Glitch', 'Turbo', 'Comet', 'Jinx', 'Ripple', 'Vortex', 'Sprout',
];

function send(ws, str) {
  if (ws.readyState === 1 && ws.bufferedAmount < 1_000_000) ws.send(str);
}

export class Room {
  constructor(code, opts = {}) {
    this.code = code;
    this.isPrivate = !!opts.isPrivate;
    this.tickMs = opts.tickMs ?? 100;
    this.roundSeconds = opts.roundSeconds ?? 120;
    this.endSeconds = opts.endSeconds ?? 8;
    this.roundTicks = Math.round((this.roundSeconds * 1000) / this.tickMs);
    this.endTicks = Math.round((this.endSeconds * 1000) / this.tickMs);
    this.game = new Game({ rng: opts.rng });
    this.clients = new Map(); // player id -> { ws, name }
    this.phase = 'playing';
    this.ticksLeft = this.roundTicks;
    this.endLeft = 0;
    this.onRoundEnd = opts.onRoundEnd || (() => {});
    this.onEmpty = opts.onEmpty || (() => {});
    this.emptySince = Date.now();
    this.disposed = false;
    this.timer = null;
    this.lastTickMs = 0;
    this.maxTickMs = 0;
    if (opts.autostart !== false) this.timer = setInterval(() => this.step(), this.tickMs);
  }

  get humans() { return this.clients.size; }
  get botCount() { return [...this.game.players.values()].filter((p) => p.bot).length; }

  freeId() {
    for (let id = 1; id <= MAX_PLAYERS; id++) if (!this.game.players.has(id)) return id;
    return 0;
  }

  join(ws, name) {
    if (this.disposed || this.humans >= MAX_HUMANS) return 0;
    let id = this.freeId();
    if (!id) { this.ensureBots(this.botCount - 1); id = this.freeId(); }
    if (!id) return 0;
    this.game.addPlayer(id, name, false);
    this.clients.set(id, { ws, name });
    this.emptySince = null;
    this.ensureBots();
    send(ws, JSON.stringify(this.snapshot('welcome', id)));
    this.broadcast({ t: 'roster', roster: this.roster() });
    return id;
  }

  leave(id) {
    if (!this.clients.delete(id)) return;
    this.game.removePlayer(id);
    this.ensureBots();
    this.broadcast({ t: 'roster', roster: this.roster() });
    if (this.humans === 0) this.emptySince = Date.now();
  }

  // Keep humans + bots at MIN_PLAYERS; bots make way for humans.
  ensureBots(limit) {
    const bots = [...this.game.players.values()].filter((p) => p.bot);
    const want = limit ?? Math.max(0, MIN_PLAYERS - this.humans);
    while (bots.length > want) this.game.removePlayer(bots.pop().id);
    while (bots.length < want) {
      const id = this.freeId();
      if (!id) break;
      const used = new Set([...this.game.players.values()].map((p) => p.name));
      const free = BOT_NAMES.filter((n) => !used.has(n));
      const name = free.length ? free[Math.floor(Math.random() * free.length)] : `Bot${id}`;
      bots.push(this.game.addPlayer(id, name, true));
    }
  }

  onMessage(id, msg) {
    if (msg.t === 'dir' && this.phase === 'playing') this.game.setDir(id, msg.d);
  }

  roster() {
    return [...this.game.players.values()].map((p) => ({ id: p.id, name: p.name, bot: p.bot }));
  }

  playerStates() {
    const g = this.game;
    return [...g.players.values()].map((p) => [p.id, p.x, p.y, p.dir, p.alive ? 1 : 0, g.counts[p.id], p.kills]);
  }

  snapshot(type, id) {
    const g = this.game;
    return {
      t: type, you: id, code: this.code, w: g.w, h: g.h,
      tickMs: this.tickMs, roundTicks: this.roundTicks, ticksLeft: this.ticksLeft,
      phase: this.phase,
      owner: Array.from(g.owner), trail: Array.from(g.trail),
      roster: this.roster(), players: this.playerStates(),
    };
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients.values()) send(c.ws, s);
  }

  broadcastState() {
    const { cells, events } = this.game.flush();
    this.broadcast({ t: 's', n: this.game.tickNo, left: this.ticksLeft, p: this.playerStates(), c: cells, e: events });
  }

  step() {
    if (this.disposed) return;
    if (this.humans === 0) {
      if (Date.now() - this.emptySince > 10_000) this.dispose();
      return;
    }
    const t0 = performance.now();
    if (this.phase === 'playing') {
      for (const p of this.game.players.values()) if (p.bot) botThink(this.game, p);
      this.game.tick();
      this.ticksLeft--;
      this.broadcastState();
      if (this.ticksLeft <= 0) this.endRound();
    } else if (--this.endLeft <= 0) {
      this.resetRound();
    }
    this.lastTickMs = performance.now() - t0;
    this.maxTickMs = Math.max(this.maxTickMs, this.lastTickMs);
  }

  endRound() {
    this.phase = 'ended';
    this.endLeft = this.endTicks;
    const results = this.game.standings().map((r) => ({ ...r, pct: Math.round(r.pct * 10) / 10 }));
    this.broadcast({ t: 'end', results, next: this.endSeconds });
    this.onRoundEnd(results.filter((r) => !r.bot));
  }

  resetRound() {
    this.game.reset();
    this.ticksLeft = this.roundTicks;
    this.phase = 'playing';
    this.ensureBots();
    for (const [id, c] of this.clients) send(c.ws, JSON.stringify(this.snapshot('reset', id)));
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.clients.values()) {
      try { c.ws.close(1001, 'room closed'); } catch { /* ignore */ }
    }
    this.clients.clear();
    this.onEmpty(this.code);
  }
}
