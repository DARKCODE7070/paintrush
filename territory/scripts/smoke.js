// End-to-end check against a running server:  PORT=3100 node scripts/smoke.js
import WebSocket from 'ws';

const PORT = process.env.PORT || 3000;
const base = `http://localhost:${PORT}`;
let failed = 0;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed++; };

function client(name, join) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, msgs: [], closed: false };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, ...join })));
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  ws.on('close', () => { c.closed = true; });
  c.of = (t) => c.msgs.filter((m) => m.t === t);
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// http
const health = await (await fetch(`${base}/health`)).json();
ok(health.ok === true, 'GET /health');
const html = await fetch(`${base}/`);
ok(html.status === 200 && (await html.text()).includes('<title>Paintrush'), 'GET / serves the client');
ok((await fetch(`${base}/client.js`)).status === 200, 'GET /client.js');
ok((await fetch(`${base}/..%2fpackage.json`)).status !== 200, 'path traversal blocked');
ok((await fetch(`${base}/nope.txt`)).status === 404, '404 for unknown file');
ok(Array.isArray(await (await fetch(`${base}/api/leaderboard`)).json()), 'GET /api/leaderboard');

// quick play
const a = client('Alice  <script>', { mode: 'quick' });
await wait(400);
const welcome = a.of('welcome')[0];
ok(!!welcome, 'quick play: welcome received');
ok(welcome && welcome.owner.length === 3600 && welcome.roster.length === 6, 'welcome has full grid and 6 players (bots fill seats)');
ok(welcome && !/[<>]/.test(welcome.roster.find((r) => r.id === welcome.you).name), 'name is sanitised');

// state stream + input
a.ws.send(JSON.stringify({ t: 'dir', d: 1 }));
await wait(1200);
const states = a.of('s');
ok(states.length >= 8, `receives ~10 state msgs/sec (got ${states.length} in 1.2s)`);
const me = (m) => m.p.find((p) => p[0] === welcome.you);
ok(me(states.at(-1))[1] > me(states[0])[1] || me(states.at(-1))[3] === 1, 'player moved after sending a direction');
ok(states.at(-1).p.length === 6, 'state lists all players');

// cheating attempts are ignored
a.ws.send(JSON.stringify({ t: 'dir', d: 99 }));
a.ws.send(JSON.stringify({ t: 'teleport', x: 1, y: 1 }));
a.ws.send('not json');
await wait(300);
ok(!a.closed, 'garbage / invalid input does not crash or kick');

// second quick-play player lands in the same room and bots make way
const b = client('Bob', { mode: 'quick' });
await wait(400);
ok(b.of('welcome')[0]?.code === welcome.code, 'second quick-play joins the same room');
ok((b.of('welcome')[0]?.roster.length ?? 0) === 6, 'still 6 seats (one bot replaced)');
ok(a.of('roster').length >= 1, 'existing player is told about the new roster');

// private room
const host = client('Host', { mode: 'create' });
await wait(300);
const code = host.of('welcome')[0]?.code;
ok(/^[A-Z0-9]{4}$/.test(code || ''), `private room created (${code})`);
const friend = client('Friend', { mode: 'join', code });
await wait(300);
ok(friend.of('welcome')[0]?.code === code, 'friend joins by code');
const lost = client('Lost', { mode: 'join', code: 'ZZZZ' });
await wait(300);
ok(lost.of('error').length === 1, 'unknown code returns an error');

// disconnect cleans up
friend.ws.close();
await wait(300);
ok(host.of('roster').length >= 2, 'roster update after a player leaves');

const after = await (await fetch(`${base}/health`)).json();
ok(after.rooms >= 2 && after.players >= 3, `health reports rooms/players (${after.rooms} rooms, ${after.players} players)`);

for (const c of [a, b, host, lost]) c.ws.close();
await wait(200);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll smoke checks passed');
process.exit(failed ? 1 : 0);
