import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(APP, 'node_modules', 'three');
const OUT = join(APP, 'renderer', 'vendor');
const ENTRIES = [
  'postprocessing/EffectComposer.js', 'postprocessing/RenderPass.js', 'postprocessing/UnrealBloomPass.js',
  'postprocessing/ShaderPass.js', 'postprocessing/OutputPass.js',
];
const posix = (p) => p.split('\\').join('/');

mkdirSync(OUT, { recursive: true });
copyFileSync(join(SRC, 'build', 'three.module.js'), join(OUT, 'three.module.js'));

const done = new Set();
function copyAddon(rel) {
  if (done.has(rel)) return;
  done.add(rel);
  const src = join(SRC, 'examples', 'jsm', rel);
  const dst = join(OUT, 'addons', rel);
  const original = readFileSync(src, 'utf8');
  for (const m of original.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) copyAddon(posix(join(dirname(rel), m[1])));
  let threeRel = posix(relative(dirname(dst), join(OUT, 'three.module.js')));
  if (!threeRel.startsWith('.')) threeRel = './' + threeRel;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, original.replace(/from\s+'three'/g, `from '${threeRel}'`));
}
ENTRIES.forEach(copyAddon);
console.log(`vendored three.module.js + ${done.size} add-on files into renderer/vendor`);
