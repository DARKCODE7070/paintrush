// Creates, finds and disposes rooms; routes quick-play players to a busy room.
import { Room, MAX_HUMANS } from './room.js';
import { Leaderboard } from './leaderboard.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)

export class RoomManager {
  constructor({ leaderboard = new Leaderboard(), roomOpts = {} } = {}) {
    this.rooms = new Map();
    this.leaderboard = leaderboard;
    this.roomOpts = roomOpts;
  }

  newCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }

  create(isPrivate) {
    const code = this.newCode();
    const room = new Room(code, {
      ...this.roomOpts,
      isPrivate,
      onRoundEnd: (results) => {
        for (const r of results) this.leaderboard.record({ name: r.name, pct: r.pct, kills: r.kills });
      },
      onEmpty: (c) => this.rooms.delete(c),
    });
    this.rooms.set(code, room);
    return room;
  }

  find(code) {
    return this.rooms.get(code) || null;
  }

  // Prefer the fullest public room that still has space, otherwise open a new one.
  quickPlay() {
    let best = null;
    for (const r of this.rooms.values()) {
      if (r.isPrivate || r.disposed || r.humans === 0 || r.humans >= MAX_HUMANS) continue;
      if (!best || r.humans > best.humans) best = r;
    }
    return best || this.create(false);
  }

  stats() {
    let players = 0;
    let maxTickMs = 0;
    for (const r of this.rooms.values()) {
      players += r.humans;
      maxTickMs = Math.max(maxTickMs, r.maxTickMs);
    }
    return { rooms: this.rooms.size, players, maxTickMs: Math.round(maxTickMs * 100) / 100 };
  }

  publicRooms() {
    return [...this.rooms.values()]
      .filter((r) => !r.isPrivate && r.humans > 0)
      .map((r) => ({ code: r.code, players: r.humans, max: MAX_HUMANS, phase: r.phase }));
  }

  shutdown() {
    for (const r of [...this.rooms.values()]) r.dispose();
  }
}
