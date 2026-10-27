// "Today's best" leaderboard: best round per player name in the last 24 hours.
// Held in memory and persisted to a JSON file (best effort). Swap for Redis or
// Postgres when you outgrow one process.
import fs from 'node:fs';
import path from 'node:path';

export class Leaderboard {
  constructor(file = null, { ttlMs = 24 * 3600 * 1000, max = 20 } = {}) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.max = max;
    this.entries = [];
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data)) this.entries = data.filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.pct));
    } catch { /* first run */ }
    this.prune();
  }

  prune() {
    const cutoff = Date.now() - this.ttlMs;
    this.entries = this.entries
      .filter((e) => e.t >= cutoff)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, this.max);
  }

  record({ name, pct, kills }) {
    if (!(pct > 0)) return;
    const now = Date.now();
    const existing = this.entries.find((e) => e.name === name);
    if (existing) {
      if (pct > existing.pct) Object.assign(existing, { pct, kills, t: now });
    } else {
      this.entries.push({ name, pct, kills, t: now });
    }
    this.prune();
    this.save();
  }

  top(n = 10) {
    this.prune();
    return this.entries.slice(0, n).map(({ name, pct, kills }) => ({ name, pct, kills }));
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries));
      fs.renameSync(tmp, this.file);
    } catch { /* non-fatal */ }
  }
}
