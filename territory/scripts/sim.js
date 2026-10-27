// Headless simulation: how expensive is a tick, and do bots behave?
//   node scripts/sim.js [players=12] [ticks=3000]
import { Game, mulberry32, MAX_PLAYERS } from '../server/game.js';
import { botThink } from '../server/bots.js';

const players = Math.min(MAX_PLAYERS, Number(process.argv[2]) || 12);
const ticks = Number(process.argv[3]) || 3000;

const g = new Game({ rng: mulberry32(2024) });
for (let id = 1; id <= players; id++) g.addPlayer(id, `Bot${id}`, true);

let captures = 0;
let kills = 0;
let worst = 0;
let total = 0;
for (let t = 0; t < ticks; t++) {
  const t0 = performance.now();
  for (const p of g.players.values()) botThink(g, p);
  g.tick();
  const dt = performance.now() - t0;
  total += dt;
  worst = Math.max(worst, dt);
  for (const e of g.flush().events) {
    if (e.e === 'capture') captures++;
    else if (e.e === 'kill') kills++;
  }
}

console.log(`${players} bots, ${ticks} ticks`);
console.log(`avg tick ${(total / ticks).toFixed(3)} ms, worst ${worst.toFixed(3)} ms (budget at 10 Hz: 100 ms)`);
console.log(`captures ${captures}, eliminations ${kills}`);
console.table(g.standings().slice(0, 5).map((s) => ({ name: s.name, pct: s.pct.toFixed(1), kills: s.kills })));
