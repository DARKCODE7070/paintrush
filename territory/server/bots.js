// Simple bot brain: make rectangular excursions out of home territory, then
// head back to the nearest owned cell. Never steps into its own trail, happily
// cuts other players' trails when they happen to be in the way.
import { DIRS } from './game.js';

function canStep(game, p, d) {
  if (d < 0) return false;
  const nx = p.x + DIRS[d][0];
  const ny = p.y + DIRS[d][1];
  if (nx < 0 || ny < 0 || nx >= game.w || ny >= game.h) return false;
  if (p.dir >= 0 && d === (p.dir + 2) % 4) return false; // no U-turns
  return game.trail[ny * game.w + nx] !== p.id;
}

function roomAhead(game, p, d) {
  let n = 0;
  let x = p.x;
  let y = p.y;
  for (;;) {
    x += DIRS[d][0];
    y += DIRS[d][1];
    if (x < 0 || y < 0 || x >= game.w || y >= game.h) return n;
    n++;
  }
}

function nearestOwn(game, p) {
  const { w, N, owner } = game;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < N; i++) {
    if (owner[i] !== p.id) continue;
    const d = Math.abs((i % w) - p.x) + Math.abs(((i / w) | 0) - p.y);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function homeDir(game, p, ai) {
  if (ai.target < 0 || game.owner[ai.target] !== p.id || ai.age % 4 === 0) ai.target = nearestOwn(game, p);
  if (ai.target < 0) return -1;
  const dx = (ai.target % game.w) - p.x;
  const dy = ((ai.target / game.w) | 0) - p.y;
  const horiz = dx === 0 ? -1 : dx > 0 ? 1 : 3;
  const vert = dy === 0 ? -1 : dy > 0 ? 2 : 0;
  const order = Math.abs(dx) >= Math.abs(dy) ? [horiz, vert] : [vert, horiz];
  for (const d of order) if (canStep(game, p, d)) return d;
  return -1;
}

export function botThink(game, p) {
  if (!p.alive) return;
  const rng = game.rng;
  const ai = p.ai || (p.ai = { plan: [], left: false, target: -1, age: 0 });
  ai.age++;
  const onOwn = game.owner[p.y * game.w + p.x] === p.id;
  if (p.trail.length) ai.left = true;

  if (onOwn && p.trail.length === 0) {
    if (ai.left) { ai.plan = []; ai.left = false; } // finished an excursion
    if (!ai.plan.length) {
      let dirs = [0, 1, 2, 3].filter((d) => canStep(game, p, d) && roomAhead(game, p, d) >= 4);
      if (!dirs.length) dirs = [0, 1, 2, 3].filter((d) => canStep(game, p, d));
      if (dirs.length) {
        const d = dirs[Math.floor(rng() * dirs.length)];
        const L = Math.min(2 + Math.floor(rng() * 7), Math.max(2, roomAhead(game, p, d) - 1));
        const M = 2 + Math.floor(rng() * 6);
        const side = (d + (rng() < 0.5 ? 1 : 3)) % 4;
        ai.plan = [{ d, n: L }, { d: side, n: M }, { d: (d + 2) % 4, n: L + 3 }];
      }
    }
  }

  let want = -1;
  while (ai.plan.length) {
    const leg = ai.plan[0];
    if (leg.n <= 0 || !canStep(game, p, leg.d)) { ai.plan.shift(); continue; }
    want = leg.d;
    leg.n--;
    break;
  }
  if (want < 0) want = homeDir(game, p, ai);
  if (!canStep(game, p, want)) {
    const alts = [0, 1, 2, 3].filter((d) => canStep(game, p, d));
    want = alts.length ? alts[Math.floor(rng() * alts.length)] : -1;
  }
  if (want >= 0) p.queue = [want];
}
