import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenReply } from '../src/spoken.ts';
import type { CommandSummary } from '../src/core.ts';

const sum = (over: Partial<CommandSummary> & { intent?: string; target?: string }): CommandSummary => ({
  decision: { intent: (over.intent ?? 'open_app') as any, target: over.target ?? 'teams', confidence: 0.9, source: 'test' },
  outcome: over.outcome ?? 'executed',
  results: over.results ?? [],
  errors: over.errors ?? [],
});

test('executed actions get short confirmations', () => {
  assert.equal(spokenReply(sum({ intent: 'open_app', target: 'teams' })), 'Opening Teams.');
  assert.equal(spokenReply(sum({ intent: 'open_workspace', target: 'agentic' })), 'Opening your agentic workspace.');
  assert.equal(spokenReply(sum({ intent: 'run_routine', target: 'start_day', results: [{ label: 'teams', ok: true }] })), 'Done.');
  assert.equal(spokenReply(sum({ intent: 'remember_fact', target: 'x' })), "Got it, I'll remember that.");
});

test('partly failed routine names each failure', () => {
  const s = sum({ intent: 'run_routine', target: 'start_day', outcome: 'failed', results: [
    { label: 'teams', ok: true },
    { label: 'jira', ok: false, message: 'jira has no URL configured - set apps.jira.url in jarvis.config.json' },
    { label: 'agentic', ok: false, message: 'VS Code not found at C:\\x' },
  ] });
  assert.equal(spokenReply(s), "Done. Jira has no link yet. Agentic didn't open.");
});

test('fully failed action', () => {
  const s = sum({ outcome: 'failed', results: [{ label: 'teams', ok: false, message: 'Chrome not found at C:\\x' }] });
  assert.equal(spokenReply(s), "That didn't work. Teams didn't open.");
});

test('other outcomes', () => {
  assert.equal(spokenReply(sum({ outcome: 'declined' })), 'Okay, cancelled.');
  assert.equal(spokenReply(sum({ outcome: 'rejected' })), "I can't do that.");
  assert.equal(spokenReply(sum({ intent: 'unknown', outcome: 'unknown' })), "I don't know how to do that yet.");
  assert.equal(spokenReply(sum({ intent: 'unknown', outcome: 'unknown', errors: ['claude-code: boom'] })), "I couldn't reach my brain.");
  assert.equal(spokenReply(sum({ outcome: 'none' })), '');
});

test('never says the wake word, even for an app named jarvis', () => {
  const s = spokenReply(sum({ intent: 'open_app', target: 'jarvis' }));
  assert.doesNotMatch(s, /jarvis/i);
});

test('never says the wake word, even for an app named izza', () => {
  const s = spokenReply(sum({ intent: 'open_app', target: 'izza' }));
  assert.doesNotMatch(s, /izza/i);
});
