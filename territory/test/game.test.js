import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, mulberry32 } from '../server/game.js';
import { botThink } from '../server/bots.js';
import { Room, MAX_HUMANS } from '../server/room.js';
import { RoomManager } from '../server/manager.js';
import { Leaderboard } from '../server/leaderboard.js';

// ---- helpers ----
function mk(seed = 1, size = 20) {
  return new Game({ w: size, h: size, rng: mulberry32(seed) });
}
// Put a player's 3x3 home territory centred on (x, y).
function place(game, p, x, y) {
  for (let i = 0; i < game.N; i++) if (game.owner[i] === p.id) game.setOwner(i, 0);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) game.setOwner((y + dy) * game.w + x + dx, p.id);
  p.x = x; p.y = y; p.dir = -1; p.queue = []; p.trail = [];
}
function walk(game, p, dirs) {
  for (const d of dirs) { game.setDir(p.id, d); game.tick(); }
}
const LOOP = [1, 1, 1, 1, 2, 2, 3, 3, 3, 0]; // right x4, down x2, left x3, up x1

function checkInvariants(game) {
  const counts = new Array(13).fill(0);
  for (let i = 0; i < game.N; i++) {
    const o = game.owner[i];
    if (o) { counts[o]++; assert.ok(game.players.has(o), `cell ${i} owned by unknown player ${o}`); }
    const t = game.trail[i];
    if (t) {
      const p = game.players.get(t);
      assert.ok(p && p.alive, `trail ${i} belongs to dead/unknown player ${t}`);
      assert.ok(p.trail.includes(i), `trail ${i} missing from player's list`);
    }
  }
  for (const p of game.players.values()) {
    assert.equal(game.counts[p.id], counts[p.id], `count mismatch for ${p.id}`);
    for (const i of p.trail) assert.equal(game.trail[i], p.id);
    if (!p.alive) { assert.equal(p.trail.length, 0); assert.equal(counts[p.id], 0); }
  }
}

// ---- game rules ----
test('closing a loop claims the trail and everything enclosed', () => {
  const g = mk();
  const p = g.addPlayer(1, 'A');
  place(g, p, 6, 6);
  assert.equal(g.counts[1], 9);
  walk(g, p, LOOP);
  // 9 home + 8 trail + 2 enclosed cells
  assert.equal(g.counts[1], 19);
  assert.equal(p.trail.length, 0);
  assert.ok(g.owner[7 * g.w + 8] === 1 && g.owner[7 * g.w + 9] === 1, 'interior claimed');
  checkInvariants(g);
});

test('running into your own trail eliminates you and wipes your land', () => {
  const g = mk();
  const p = g.addPlayer(1, 'A');
  place(g, p, 6, 6);
  walk(g, p, [1, 1, 1, 1, 2, 2, 3, 0, 0]); // loops back onto own trail at (9,6)
  assert.equal(p.alive, false);
  assert.equal(g.counts[1], 0);
  assert.equal(p.trail.length, 0);
  assert.equal(p.deaths, 1);
  checkInvariants(g);
});

test('cutting another player\'s trail eliminates them and credits the kill', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  const b = g.addPlayer(2, 'B');
  place(g, a, 4, 4);
  place(g, b, 14, 14);
  const idx = 4 * g.w + 7;
  g.setTrail(idx, 2);
  b.trail.push(idx);
  walk(g, a, [1, 1, 1]); // (5,4) own, (6,4) trail, (7,4) b's trail
  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  assert.equal(g.trail[idx], 1, 'cell is now a\'s trail');
  checkInvariants(g);
});

test('enclosing another player\'s trail eliminates them', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  const b = g.addPlayer(2, 'B');
  place(g, a, 6, 6);
  place(g, b, 15, 15);
  const idx = 7 * g.w + 9; // inside the loop a is about to draw
  g.setTrail(idx, 2);
  b.trail.push(idx);
  walk(g, a, LOOP);
  assert.equal(b.alive, false);
  assert.equal(a.kills, 1);
  assert.equal(g.counts[1], 19);
  checkInvariants(g);
});

test('enclosed enemy territory is stolen', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  const b = g.addPlayer(2, 'B');
  place(g, a, 6, 6);
  place(g, b, 15, 15);
  g.setOwner(7 * g.w + 9, 2); // one enemy cell inside a's future loop
  assert.equal(g.counts[2], 10);
  walk(g, a, LOOP);
  assert.equal(g.counts[2], 9);
  assert.equal(g.counts[1], 19);
  checkInvariants(g);
});

test('losing all territory eliminates a player', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  const b = g.addPlayer(2, 'B');
  place(g, a, 6, 6);
  place(g, b, 15, 15);
  for (let i = 0; i < g.N; i++) if (g.owner[i] === 2) g.setOwner(i, 0);
  g.tick();
  assert.equal(b.alive, false);
  checkInvariants(g);
});

test('dead players respawn after the delay', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  place(g, a, 6, 6);
  g.kill(a, null);
  assert.equal(a.alive, false);
  for (let i = 0; i < 40; i++) g.tick();
  assert.equal(a.alive, true);
  assert.equal(g.counts[1], 9);
  checkInvariants(g);
});

test('walls block movement instead of killing', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  place(g, a, 1, 1);
  walk(g, a, [0, 0, 0, 3, 3, 3]);
  assert.equal(a.alive, true);
  assert.equal(a.x, 0);
  assert.equal(a.y, 0);
});

test('180-degree turns and invalid inputs are ignored', () => {
  const g = mk();
  const a = g.addPlayer(1, 'A');
  place(g, a, 6, 6);
  walk(g, a, [1]);
  assert.equal(a.dir, 1);
  walk(g, a, [3]); // reverse: ignored
  assert.equal(a.dir, 1);
  g.setDir(1, 99);
  g.setDir(1, -1);
  g.setDir(1, 1.5);
  g.setDir(1, '2');
  assert.equal(a.queue.length, 0);
});

test('flush reports changed cells once', () => {
  const g = mk();
  g.addPlayer(1, 'A');
  const first = g.flush();
  assert.ok(first.cells.length >= 27); // 9 cells * 3 values
  assert.equal(g.flush().cells.length, 0);
});

// ---- long-running simulation with bots ----
test('bot-only simulation keeps every invariant for 4000 ticks', () => {
  const g = new Game({ rng: mulberry32(42) });
  for (let id = 1; id <= 10; id++) g.addPlayer(id, `Bot${id}`, true);
  let captures = 0;
  let kills = 0;
  let peak = 0;
  for (let t = 0; t < 4000; t++) {
    for (const p of g.players.values()) botThink(g, p);
    g.tick();
    const { events } = g.flush();
    for (const e of events) { if (e.e === 'capture') captures++; if (e.e === 'kill') kills++; }
    for (const p of g.players.values()) peak = Math.max(peak, g.counts[p.id]);
    if (t % 50 === 0) checkInvariants(g);
  }
  checkInvariants(g);
  assert.ok(captures > 50, `bots should capture land (got ${captures})`);
  assert.ok(peak > 30, `some bot should grow (peak ${peak})`);
  assert.ok(kills >= 0);
});

test('a single bot alone expands its territory', () => {
  const g = new Game({ rng: mulberry32(7) });
  g.addPlayer(1, 'Solo', true);
  for (let t = 0; t < 1500; t++) {
    for (const p of g.players.values()) botThink(g, p);
    g.tick();
  }
  assert.ok(g.counts[1] > 40, `expected growth, got ${g.counts[1]}`);
});

// ---- rooms ----
function fakeWs() {
  return {
    readyState: 1, bufferedAmount: 0, sent: [], closed: false,
    send(s) { this.sent.push(JSON.parse(s)); },
    close() { this.closed = true; this.readyState = 3; },
  };
}

test('room: bots fill empty seats and make way for humans', () => {
  const room = new Room('TEST', { autostart: false, rng: mulberry32(3) });
  const ws = fakeWs();
  const id = room.join(ws, 'Tester');
  assert.ok(id);
  assert.equal(ws.sent[0].t, 'welcome');
  assert.equal(ws.sent[0].owner.length, 3600);
  assert.equal(room.game.players.size, 6);
  assert.equal(room.botCount, 5);

  const more = [];
  for (let i = 0; i < 3; i++) { const w = fakeWs(); more.push([w, room.join(w, `P${i}`)]); }
  assert.equal(room.botCount, 2);
  assert.equal(room.game.players.size, 6);

  room.leave(more[0][1]);
  assert.equal(room.game.players.size, 6);
  room.dispose();
});

test('room: capacity is enforced', () => {
  const room = new Room('FULL', { autostart: false, rng: mulberry32(5) });
  const ids = [];
  for (let i = 0; i < MAX_HUMANS; i++) ids.push(room.join(fakeWs(), `P${i}`));
  assert.ok(ids.every(Boolean));
  assert.equal(room.join(fakeWs(), 'Late'), 0);
  assert.equal(room.botCount, 0);
  room.dispose();
});

test('room: only direction input is accepted and state is broadcast each tick', () => {
  const room = new Room('MOVE', { autostart: false, rng: mulberry32(9) });
  const ws = fakeWs();
  const id = room.join(ws, 'Mover');
  const me = room.game.players.get(id);
  const x0 = me.x;
  room.onMessage(id, { t: 'dir', d: 1 });
  room.onMessage(id, { t: 'teleport', x: 0, y: 0 }); // ignored
  room.step();
  const s = ws.sent.at(-1);
  assert.equal(s.t, 's');
  assert.equal(me.x, x0 + 1);
  assert.ok(Array.isArray(s.p) && Array.isArray(s.c) && Array.isArray(s.e));
  room.dispose();
});

test('room: round ends, results are broadcast, then a new round starts', () => {
  const recorded = [];
  const room = new Room('RND', {
    autostart: false, roundSeconds: 1, endSeconds: 1, tickMs: 100,
    rng: mulberry32(11), onRoundEnd: (r) => recorded.push(...r),
  });
  const ws = fakeWs();
  room.join(ws, 'Racer');
  for (let i = 0; i < 10; i++) room.step();
  assert.equal(room.phase, 'ended');
  const end = ws.sent.find((m) => m.t === 'end');
  assert.ok(end && end.results.length === 6);
  assert.equal(recorded.length, 1); // only the human is recorded
  for (let i = 0; i < 10; i++) room.step();
  assert.equal(room.phase, 'playing');
  assert.ok(ws.sent.some((m) => m.t === 'reset'));
  assert.equal(room.ticksLeft, room.roundTicks);
  room.dispose();
});

test('manager: quick play joins the busiest public room; private rooms are separate', () => {
  const m = new RoomManager({ roomOpts: { autostart: false } });
  const r1 = m.quickPlay();
  r1.join(fakeWs(), 'A');
  const again = m.quickPlay();
  assert.equal(again, r1);
  const priv = m.create(true);
  priv.join(fakeWs(), 'B');
  assert.notEqual(m.quickPlay(), priv);
  assert.equal(m.find(priv.code), priv);
  assert.equal(m.publicRooms().length, 1);
  m.shutdown();
});

test('leaderboard keeps each name\'s best score, sorted', () => {
  const lb = new Leaderboard(null);
  lb.record({ name: 'A', pct: 10, kills: 1 });
  lb.record({ name: 'B', pct: 25, kills: 0 });
  lb.record({ name: 'A', pct: 5, kills: 9 }); // worse: ignored
  lb.record({ name: 'A', pct: 30, kills: 2 });
  const top = lb.top();
  assert.deepEqual(top.map((e) => e.name), ['A', 'B']);
  assert.equal(top[0].pct, 30);
});
