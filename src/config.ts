import { readFileSync } from 'node:fs';

export interface AppConfig {
  description: string;
  url?: string;
  exe?: string;
  args?: string[];
  confirm: boolean;
}

export interface WorkspaceConfig {
  description: string;
  folder: string;
  claude: { mode: 'continue' | 'resume' | 'none'; sessionId?: string };
  confirm: boolean;
}

export interface RoutineConfig {
  description: string;
  steps: string[];
  confirm: boolean;
}

export interface JarvisConfig {
  chrome: { path: string; profile: string };
  vscode: { path: string };
  claude: { path: string };
  terminal: { path: string };
  apps: Record<string, AppConfig>;
  workspaces: Record<string, WorkspaceConfig>;
  routines: Record<string, RoutineConfig>;
  memory: { suggestAfter: number };
  face: { display: number; fullscreen: boolean };
  voice: { voice: string; wakeWord: string; wakeWordModel: string; listenTimeoutMs: number; maxUtteranceMs: number; asrModel: string };
  agent: { enabled: boolean; maxWorkers: number; managerModel: string; workerModel: string; worktreeRoot: string; projectsRoot: string; atlassianUrl: string };
}

type Env = Record<string, string | undefined>;
type Obj = Record<string, any>;

const KEY_PATTERN = /^[a-z0-9_-]+$/;
const STEP_PATTERN = /^(app|workspace):([a-z0-9_-]+)$/;
const DEFAULT_TERMINAL_PATH = '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe';

export function expandEnv(value: string, env: Env = process.env): string {
  return value.replace(/%([A-Za-z0-9_]+)%/g, (match: string, name: string) => env[name] ?? match);
}

function fail(message: string): never {
  throw new Error(`Invalid jarvis.config.json: ${message}`);
}

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} must be a non-empty string`);
  return value;
}

function requireSection(raw: Obj, name: string): Obj {
  const value = raw[name];
  if (!isObj(value)) fail(`"${name}" must be an object`);
  return value;
}

function checkKey(kind: string, key: string): void {
  if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(`${kind} key "${key}" is reserved`);
  if (!KEY_PATTERN.test(key)) fail(`${kind} key "${key}" must use lowercase letters, digits, _ or -`);
}

function optionalInt(section: Obj, key: string, where: string, fallback: number, min: number): number {
  const v = section[key];
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < min) fail(`${where}.${key} must be a whole number of at least ${min}`);
  return v;
}

export function validateConfig(raw: unknown, env: Env = process.env): JarvisConfig {
  if (!isObj(raw)) fail('top level must be an object');
  const chrome = requireSection(raw, 'chrome');
  const vscode = requireSection(raw, 'vscode');
  const claude = requireSection(raw, 'claude');
  const terminalPath = raw.terminal === undefined
    ? expandEnv(DEFAULT_TERMINAL_PATH, env)
    : expandEnv(requireString(requireSection(raw, 'terminal').path, 'terminal.path'), env);

  const apps: Record<string, AppConfig> = {};
  for (const [key, app] of Object.entries(requireSection(raw, 'apps'))) {
    checkKey('app', key);
    if (!isObj(app)) fail(`apps.${key} must be an object`);
    if (app.url !== undefined && typeof app.url !== 'string') fail(`apps.${key}.url must be a string`);
    if (typeof app.url === 'string' && app.url !== '' && !/^https?:\/\//i.test(app.url)) {
      fail(`apps.${key}.url must start with http:// or https://`);
    }
    if (app.exe !== undefined) requireString(app.exe, `apps.${key}.exe`);
    if (app.args !== undefined && !(Array.isArray(app.args) && app.args.every((a: unknown) => typeof a === 'string'))) {
      fail(`apps.${key}.args must be an array of strings`);
    }
    if (app.confirm !== undefined && typeof app.confirm !== 'boolean') {
      fail(`apps.${key}.confirm must be true or false`);
    }
    apps[key] = {
      description: requireString(app.description, `apps.${key}.description`),
      url: app.url ? app.url : undefined,
      exe: app.exe ? expandEnv(app.exe, env) : undefined,
      args: app.args,
      confirm: app.confirm === true,
    };
  }

  const workspaces: Record<string, WorkspaceConfig> = {};
  for (const [key, ws] of Object.entries(requireSection(raw, 'workspaces'))) {
    checkKey('workspace', key);
    if (!isObj(ws)) fail(`workspaces.${key} must be an object`);
    const c = ws.claude === undefined ? { mode: 'none' } : ws.claude;
    if (!isObj(c) || !['continue', 'resume', 'none'].includes(c.mode)) {
      fail(`workspaces.${key}.claude.mode must be "continue", "resume" or "none"`);
    }
    if (c.mode === 'resume') requireString(c.sessionId, `workspaces.${key}.claude.sessionId`);
    if (ws.confirm !== undefined && typeof ws.confirm !== 'boolean') {
      fail(`workspaces.${key}.confirm must be true or false`);
    }
    workspaces[key] = {
      description: requireString(ws.description, `workspaces.${key}.description`),
      folder: expandEnv(requireString(ws.folder, `workspaces.${key}.folder`), env),
      claude: c.mode === 'resume' ? { mode: 'resume', sessionId: c.sessionId } : { mode: c.mode },
      confirm: ws.confirm === true,
    };
  }

  const routines: Record<string, RoutineConfig> = {};
  for (const [key, routine] of Object.entries(requireSection(raw, 'routines'))) {
    checkKey('routine', key);
    if (!isObj(routine)) fail(`routines.${key} must be an object`);
    if (!Array.isArray(routine.steps) || routine.steps.length === 0) fail(`routines.${key}.steps must be a non-empty array`);
    for (const step of routine.steps) {
      const match = typeof step === 'string' ? STEP_PATTERN.exec(step) : null;
      if (!match) fail(`routines.${key} step "${step}" must look like "app:<key>" or "workspace:<key>"`);
      const known = match[1] === 'app' ? apps[match[2]] : workspaces[match[2]];
      if (!known) fail(`routines.${key} step "${step}" refers to an unknown ${match[1]}`);
    }
    if (routine.confirm !== undefined && typeof routine.confirm !== 'boolean') {
      fail(`routines.${key}.confirm must be true or false`);
    }
    routines[key] = {
      description: requireString(routine.description, `routines.${key}.description`),
      steps: [...routine.steps],
      confirm: routine.confirm === true,
    };
  }

  const memory = raw.memory === undefined ? {} : requireSection(raw, 'memory');
  const suggestAfter = memory.suggestAfter ?? 3;
  if (!Number.isInteger(suggestAfter) || suggestAfter < 1) fail('memory.suggestAfter must be a whole number of at least 1');

  const faceRaw = raw.face === undefined ? {} : requireSection(raw, 'face');
  if (faceRaw.fullscreen !== undefined && typeof faceRaw.fullscreen !== 'boolean') fail('face.fullscreen must be true or false');
  const face = { display: optionalInt(faceRaw, 'display', 'face', 0, 0), fullscreen: faceRaw.fullscreen ?? true };
  const voiceRaw = raw.voice === undefined ? {} : requireSection(raw, 'voice');
  const voice = {
    voice: voiceRaw.voice === undefined ? 'af_heart' : requireString(voiceRaw.voice, 'voice.voice'),
    wakeWord: voiceRaw.wakeWord === undefined ? 'hey izza' : requireString(voiceRaw.wakeWord, 'voice.wakeWord'),
    wakeWordModel: voiceRaw.wakeWordModel === undefined ? 'assets/hey-izza.ppn' : requireString(voiceRaw.wakeWordModel, 'voice.wakeWordModel'),
    listenTimeoutMs: optionalInt(voiceRaw, 'listenTimeoutMs', 'voice', 6000, 1000),
    maxUtteranceMs: optionalInt(voiceRaw, 'maxUtteranceMs', 'voice', 10000, 1000),
    asrModel: voiceRaw.asrModel === undefined ? 'onnx-community/whisper-base.en' : requireString(voiceRaw.asrModel, 'voice.asrModel'),
  };

  const agentRaw = raw.agent === undefined ? {} : requireSection(raw, 'agent');
  if (agentRaw.enabled !== undefined && typeof agentRaw.enabled !== 'boolean') fail('agent.enabled must be true or false');
  const atlassianUrl = agentRaw.atlassianUrl === undefined ? 'https://mcp.atlassian.com/v2/mcp' : requireString(agentRaw.atlassianUrl, 'agent.atlassianUrl');
  if (!/^https:\/\//i.test(atlassianUrl)) fail('agent.atlassianUrl must start with https://');
  const agent = {
    enabled: agentRaw.enabled ?? true,
    maxWorkers: optionalInt(agentRaw, 'maxWorkers', 'agent', 3, 1),
    managerModel: agentRaw.managerModel === undefined ? 'sonnet' : requireString(agentRaw.managerModel, 'agent.managerModel'),
    workerModel: typeof agentRaw.workerModel === 'string' ? agentRaw.workerModel : '',
    worktreeRoot: expandEnv(agentRaw.worktreeRoot === undefined ? '%LOCALAPPDATA%\\izza\\worktrees' : requireString(agentRaw.worktreeRoot, 'agent.worktreeRoot'), env),
    projectsRoot: expandEnv(agentRaw.projectsRoot === undefined ? 'C:\\Zilmoney' : requireString(agentRaw.projectsRoot, 'agent.projectsRoot'), env),
    atlassianUrl,
  };

  return {
    chrome: {
      path: expandEnv(requireString(chrome.path, 'chrome.path'), env),
      profile: typeof chrome.profile === 'string' && chrome.profile.trim() ? chrome.profile : 'Default',
    },
    vscode: { path: expandEnv(requireString(vscode.path, 'vscode.path'), env) },
    claude: { path: expandEnv(requireString(claude.path, 'claude.path'), env) },
    terminal: { path: terminalPath },
    apps,
    workspaces,
    routines,
    memory: { suggestAfter },
    face,
    voice,
    agent,
  };
}

export function loadConfig(path: string, env: Env = process.env): JarvisConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Cannot read config file at ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    fail(`not valid JSON (${(e as Error).message})`);
  }
  return validateConfig(raw, env);
}
