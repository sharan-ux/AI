import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same technique as reloadPolicy.test.js: main.js imports 'electron' so it can't be `import`-ed
// directly by the plain `node --test` runner. filterSpeechWorkerEnv() has no Electron dependency
// (the environment is passed in explicitly), so pull its exact source text out of main.js,
// along with the SPEECH_ENV_KEYS constant it closes over, and evaluate both in isolation.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(HERE, '..', 'main', 'main.js');
const src = readFileSync(MAIN_JS, 'utf8');
const keysMatch = src.match(/const SPEECH_ENV_KEYS = new Set\(\[[\s\S]*?\]\);/);
const fnMatch = src.match(/export function filterSpeechWorkerEnv\([\s\S]*?\n\}/);
assert.ok(keysMatch, 'SPEECH_ENV_KEYS not found in app/main/main.js — did the source change shape?');
assert.ok(fnMatch, 'filterSpeechWorkerEnv() not found in app/main/main.js — did the source change shape?');
const filterSpeechWorkerEnv = new Function(`'use strict'; ${keysMatch[0]} return (${fnMatch[0].replace('export function filterSpeechWorkerEnv', 'function filterSpeechWorkerEnv')});`)();

test('keeps only the allowlisted system variables and JARVIS_* variables', () => {
  const env = filterSpeechWorkerEnv({
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    APPDATA: 'C:\\AppData',
    LOCALAPPDATA: 'C:\\Local',
    USERPROFILE: 'C:\\Users\\me',
    JARVIS_VOICE: 'af_heart',
    JARVIS_MODELS_DIR: 'C:\\models',
  });
  assert.deepEqual(env, {
    PATH: 'C:\\bin',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    TMP: 'C:\\Temp',
    APPDATA: 'C:\\AppData',
    LOCALAPPDATA: 'C:\\Local',
    USERPROFILE: 'C:\\Users\\me',
    JARVIS_VOICE: 'af_heart',
    JARVIS_MODELS_DIR: 'C:\\models',
  });
});

test('drops API keys and other secrets that are not on the allowlist', () => {
  const env = filterSpeechWorkerEnv({
    PATH: 'C:\\bin',
    PICOVOICE_ACCESS_KEY: 'secret-key',
    ANTHROPIC_API_KEY: 'secret-key-2',
    SOME_RANDOM_VAR: 'x',
  });
  assert.deepEqual(env, { PATH: 'C:\\bin' });
});

test('the allowlist match is case-insensitive on key names', () => {
  const env = filterSpeechWorkerEnv({ path: 'C:\\bin', systemroot: 'C:\\Windows' });
  assert.deepEqual(env, { path: 'C:\\bin', systemroot: 'C:\\Windows' });
});
