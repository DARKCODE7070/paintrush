// Spawn N fake players against a running server and report how it holds up.
//   node scripts/loadtest.js [clients=60] [seconds=20] [url=ws://localhost:3000/ws]
import WebSocket from 'ws';

const clients = Number(process.argv[2]) || 60;
const seconds = Number(process.argv[3]) || 20;
const url = process.argv[4] || 'ws://localhost:3000/ws';

let open = 0;
let messages = 0;
let bytes = 0;
let errors = 0;

function spawn(i) {
  const ws = new WebSocket(url);
  let timer;
  ws.on('open', () => {
    open++;
    ws.send(JSON.stringify({ t: 'join', mode: 'quick', name: `load${i}` }));
    timer = setInterval(() => ws.send(JSON.stringify({ t: 'dir', d: Math.floor(Math.random() * 4) })), 250 + Math.random() * 500);
  });
  ws.on('message', (d) => { messages++; bytes += d.length; });
  ws.on('error', () => { errors++; });
  ws.on('close', () => { clearInterval(timer); open--; });
  return ws;
}

const sockets = Array.from({ length: clients }, (_, i) => spawn(i));
const started = Date.now();
const report = setInterval(() => {
  const s = (Date.now() - started) / 1000;
  console.log(`${s.toFixed(0)}s open=${open} msgs/s=${(messages / s).toFixed(0)} KB/s=${(bytes / 1024 / s).toFixed(0)} errors=${errors}`);
}, 5000);

setTimeout(() => {
  clearInterval(report);
  for (const ws of sockets) ws.close();
  setTimeout(() => process.exit(0), 500);
}, seconds * 1000);
