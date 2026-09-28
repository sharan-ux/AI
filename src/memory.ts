import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { findEntry } from './catalog.ts';
import { normalizePhrase } from './normalize.ts';
import type { Catalog, Intent } from './types.ts';

export interface Shortcut {
  intent: Intent;
  target: string;
}

export interface MemoryState {
  shortcuts: Map<string, Shortcut>;
  facts: string[];
  projects: Map<string, string>;
  warnings: string[];
}

export const MEMORY_HEADER =
  '# Jarvis memory - edit freely. Lines: "shortcut: <phrase> => <intent> <target>", "fact: <text>" or "project: <KEY> => <folder>"\n';

const SHORTCUT_LINE = /^shortcut:\s*(.+?)\s*=>\s*(\S+)\s+(\S+)\s*$/i;
const FACT_LINE = /^fact:\s*(.+)$/i;
const PROJECT_LINE = /^project:\s*([A-Za-z][A-Za-z0-9]*)\s*=>\s*(.+)$/i;

export function parseMemory(text: string, catalog: Catalog): MemoryState {
  const state: MemoryState = { shortcuts: new Map(), facts: [], projects: new Map(), warnings: [] };
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const shortcut = SHORTCUT_LINE.exec(line);
    if (shortcut) {
      const phrase = normalizePhrase(shortcut[1]);
      const intent = shortcut[2];
      const target = shortcut[3];
      if (!phrase || intent === 'remember_fact' || !findEntry(catalog, intent, target)) {
        state.warnings.push(`memory line ${index + 1} ignored: "${intent} ${target}" is not on the allowlist`);
        return;
      }
      state.shortcuts.set(phrase, { intent: intent as Intent, target });
      return;
    }
    const project = PROJECT_LINE.exec(line);
    if (project) {
      state.projects.set(project[1].toUpperCase(), project[2].trim());
      return;
    }
    const fact = FACT_LINE.exec(line);
    if (fact) {
      state.facts.push(fact[1].trim());
      return;
    }
    state.warnings.push(`memory line ${index + 1} ignored: not a shortcut or fact`);
  });
  return state;
}

export function loadMemory(path: string, catalog: Catalog): MemoryState {
  if (!existsSync(path)) return parseMemory('', catalog);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    return { shortcuts: new Map(), facts: [], projects: new Map(), warnings: [`memory file at ${path} could not be read: ${(e as Error).message}`] };
  }
  return parseMemory(text, catalog);
}

function appendLine(path: string, line: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, MEMORY_HEADER, 'utf8');
  } else {
    const current = readFileSync(path, 'utf8');
    if (current.length > 0 && !current.endsWith('\n')) appendFileSync(path, '\n', 'utf8');
  }
  appendFileSync(path, `${line}\n`, 'utf8');
}

function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

export function appendShortcut(path: string, phrase: string, intent: string, target: string): void {
  appendLine(path, `shortcut: ${oneLine(phrase)} => ${intent} ${target}`);
}

export function appendFact(path: string, fact: string): void {
  appendLine(path, `fact: ${oneLine(fact)}`);
}

const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

export function appendProject(path: string, key: string, folder: string): void {
  if (!PROJECT_KEY.test(key)) throw new Error(`invalid project key: ${key}`);
  appendLine(path, `project: ${key.toUpperCase()} => ${oneLine(folder)}`);
}
