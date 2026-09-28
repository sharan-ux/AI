// Small LRU of synthesized replies, keyed by voice + text.
export class ReplyCache {
  constructor(max = 200) { this.max = max; this.map = new Map(); }
  key(voice, text) { return `${voice}|${String(text).trim()}`; }
  get(voice, text) {
    const k = this.key(voice, text);
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(voice, text, value) {
    const k = this.key(voice, text);
    this.map.delete(k);
    this.map.set(k, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
