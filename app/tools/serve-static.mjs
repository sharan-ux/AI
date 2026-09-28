import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.bin': 'application/octet-stream', '.pv': 'application/octet-stream' };
const port = +(process.argv[2] ?? 8765);
createServer(async (req, res) => {
  let file;
  try {
    file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  } catch { res.writeHead(400).end(); return; }
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch { res.writeHead(404).end(); }
}).listen(port, () => console.log(`serving ${ROOT} on http://localhost:${port}`));
