import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig } from '../src/config.ts';
import type { JarvisConfig } from '../src/config.ts';

export function rawConfig(): any {
  return {
    chrome: { path: 'C:\\chrome.exe', profile: 'Default' },
    vscode: { path: '%LOCALAPPDATA%\\Code.exe' },
    claude: { path: 'C:\\claude.exe' },
    terminal: { path: 'C:\\wt.exe' },
    apps: {
      teams: { description: 'Microsoft Teams', url: 'https://teams.microsoft.com/' },
      jira: { description: 'Jira', url: '' },
      notepad: { description: 'Notepad', exe: 'notepad.exe', confirm: true },
    },
    workspaces: {
      agentic: { description: 'Agentic dev', folder: 'C:\\Zilmoney\\Agentic', claude: { mode: 'resume', sessionId: 'abc-123' } },
    },
    routines: {
      start_day: { description: 'Start my workday', steps: ['app:teams', 'app:jira', 'workspace:agentic'] },
    },
    memory: { suggestAfter: 3 },
  };
}

export function sampleConfig(): JarvisConfig {
  return validateConfig(rawConfig(), { LOCALAPPDATA: 'C:\\Local' });
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jarvis-test-'));
}
