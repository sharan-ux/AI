import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// Spawns and supervises the Jarvis core (JSON lines over stdio).
export class CoreClient extends EventEmitter {
  constructor({ spawn, maxRestarts = 3, windowMs = 60000, now = Date.now }) {
    super();
    Object.assign(this, { spawnChild: spawn, maxRestarts, windowMs, now });
    this.child = null;
    this.inflight = new Set();
    this.restarts = [];
    this.stopping = false;
  }

  start() { this.stopping = false; this.restarts = []; this.spawn(); }

  spawn() {
    const child = this.spawnChild();
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { this.emit('message', { type: 'warning', message: 'core printed a line that is not JSON' }); return; }
      if (msg.type === 'done') this.inflight.delete(msg.id);
      this.emit('message', msg);
    });
    child.stderr?.on('data', (d) => this.emit('log', String(d)));
    child.on('error', (e) => this.emit('message', { type: 'warning', message: `core failed to start: ${e.message}` }));
    child.stdin.on('error', () => {});
    child.on('close', (code) => { if (this.child === child) this.onExit(code); });
  }

  onExit(code) {
    this.child = null;
    for (const id of this.inflight) {
      this.emit('message', { type: 'done', id, outcome: 'failed', say: 'Something went wrong, please try again.', lines: [] });
    }
    this.inflight.clear();
    if (this.stopping) return;
    const t = this.now();
    this.restarts = this.restarts.filter((x) => t - x < this.windowMs);
    if (this.restarts.length >= this.maxRestarts) { this.emit('down', code); return; }
    this.restarts.push(t);
    this.emit('restarting', code);
    this.spawn();
  }

  send(msg) {
    if (!this.child) return false;
    if (msg.type === 'command') this.inflight.add(msg.id);
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
