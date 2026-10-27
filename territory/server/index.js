// HTTP + WebSocket entry point. Serves the client, a few JSON endpoints, and
// the realtime game socket at /ws.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './manager.js';
import { Leaderboard } from './leaderboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const MAX_CONN_PER_IP = Number(process.env.MAX_CONN_PER_IP) || 8;
const TRUST_PROXY = process.env.TRUST_PROXY === '1'; // set behind Fly/Railway/nginx

const manager = new RoomManager({
  leaderboard: new Leaderboard(path.join(ROOT, 'data', 'leaderboard.json')),
  roomOpts: {
    roundSeconds: Number(process.env.ROUND_SECONDS) || 120,
    endSeconds: Number(process.env.END_SECONDS) || 8,
  },
});
const startedAt = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }

  if (pathname === '/health') {
    return json(res, 200, { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), ...manager.stats() });
  }
  if (pathname === '/api/leaderboard') return json(res, 200, manager.leaderboard.top(10));
  if (pathname === '/api/rooms') return json(res, 200, manager.publicRooms());

  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---- realtime ----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 });
const perIp = new Map();

function cleanName(raw) {
  const n = String(raw ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  return n || `Player${Math.floor(Math.random() * 900 + 100)}`;
}
function cleanCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}
function reply(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws, req) => {
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const n = (perIp.get(ip) || 0) + 1;
  if (n > MAX_CONN_PER_IP) { ws.close(1013, 'too many connections'); return; }
  perIp.set(ip, n);

  const session = { room: null, id: 0 };
  let alive = true;
  ws.on('pong', () => { alive = true; });
  ws._alive = () => { const a = alive; alive = false; return a; };

  // token bucket: ~40 messages/second, burst 60
  let tokens = 60;
  let last = Date.now();

  ws.on('message', (data) => {
    const now = Date.now();
    tokens = Math.min(60, tokens + ((now - last) / 1000) * 40);
    last = now;
    if (--tokens < 0) { if (tokens < -120) ws.terminate(); return; }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'dir') {
      if (session.room) session.room.onMessage(session.id, msg);
      return;
    }
    if (msg.t === 'join' && !session.room) {
      let room = null;
      if (msg.mode === 'join') {
        room = manager.find(cleanCode(msg.code));
        if (!room) return reply(ws, { t: 'error', msg: 'Room not found. Check the code.' });
      } else if (msg.mode === 'create') {
        room = manager.create(true);
      } else {
        room = manager.quickPlay();
      }
      const id = room.join(ws, cleanName(msg.name));
      if (!id) return reply(ws, { t: 'error', msg: 'That room is full.' });
      session.room = room;
      session.id = id;
    }
  });

  ws.on('close', () => {
    perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1));
    if (session.room) session.room.leave(session.id);
  });
  ws.on('error', () => {});
});

// drop half-dead connections
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) if (!ws._alive()) ws.terminate(); else ws.ping();
}, 15_000);

server.listen(PORT, () => {
  console.log(`Paintrush running on http://localhost:${PORT}`);
});

function shutdown() {
  console.log('Shutting down...');
  clearInterval(heartbeat);
  manager.shutdown();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
