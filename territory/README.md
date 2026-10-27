# Paintrush

A real-time multiplayer territory-capture game (think paper.io / Splatoon-lite).
Authoritative Node.js server, plain-Canvas neon client, no build step.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Open it in two browser tabs (or on your phone via your LAN IP) and hit **Quick play**.
The lobby is auto-filled with bots, so it is never empty. Use **Create private room**
and share the invite link (click the room code in-game to copy it).

| Command | What it does |
|---|---|
| `npm start` | Run the server (serves the client too) |
| `npm run dev` | Same, restarting on file changes |
| `npm test` | 18 unit/integration tests (flood-fill, collisions, bots, rooms) |
| `npm run sim` | Headless bot simulation + tick-time benchmark |
| `npm run load -- 60 20` | 60 fake clients against a running server for 20s |

## How to play

Steer with **WASD / arrows** (or swipe on mobile). Leave your colour to draw a trail, come
back to your territory to claim everything you enclosed. Touching anyone's trail (including
your own) eliminates that player, and so does enclosing their trail. Most land after 2 minutes wins.

## Architecture

```
server/game.js        pure rules: grid, trails, flood-fill capture, collisions (no I/O, fully tested)
server/bots.js        bot brain
server/room.js        one match: tick loop (10 Hz), clients, bots, round timer, broadcasts
server/manager.js     room codes, quick-play matchmaking, cleanup
server/leaderboard.js "today's best" (memory + JSON file)
server/index.js       HTTP (static + /health, /api/*) and WebSocket at /ws
public/               index.html, style.css, client.js (renderer, input, audio, HUD)
```

**Server is authoritative.** Clients only send `{"t":"dir","d":0-3}`. The server owns positions,
trails and scoring, so a modified client cannot claim land.

**Protocol (JSON over WebSocket)**

- client to server: `join {mode: quick|create|join, code, name}`, `dir {d}`
- server to client: `welcome`/`reset` (full snapshot), `s` (per tick: players, changed cells, events),
  `roster`, `end` (results), `error`

State is delta-compressed: each tick sends only changed cells as a flat `[index, owner, trail, ...]` array.

**Backend features included:** rooms and room codes, quick-play matchmaking (fills the busiest room),
bot fill so seats are never empty, round loop (play, results, auto-restart), per-socket rate limiting,
input validation, name sanitising, per-IP connection cap, WebSocket heartbeat, graceful shutdown,
`/health` endpoint, daily leaderboard.

**Measured:** a 12-player tick costs about 0.05 ms on average (budget is 100 ms), so a single
process can host a very large number of rooms.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | HTTP/WS port |
| `ROUND_SECONDS` | 120 | Round length |
| `END_SECONDS` | 8 | Results screen length |
| `MAX_CONN_PER_IP` | 8 | Concurrent sockets per IP |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy so the per-IP cap uses `X-Forwarded-For` |

## Deploy

A `Dockerfile` is included. On Fly.io or Railway, point at this repo and expose the `PORT`;
WebSockets work out of the box. The client uses `wss://` automatically on HTTPS.

## What is not built yet (good next steps)

- **Reconnect:** a dropped player is removed immediately. Add a short grace period keyed by a session token.
- **Accounts and persistence:** guests only. Leaderboard lives in memory plus a JSON file, so it is
  single-process. Swap `Leaderboard` for Postgres (history, lifetime stats) and Redis (sorted sets) to scale out.
- **Multi-process scaling:** rooms live in one process. To scale, shard by room code behind a sticky
  load balancer, or move to Colyseus with its Redis driver.
- **Client-side prediction:** not needed at 10 Hz for a grid game (the client interpolates), but add it if you raise the speed.
- **Game modes and polish:** power-ups (speed, paint bomb, shield), team mode, skins, a proper sound track.
