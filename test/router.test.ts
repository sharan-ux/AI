import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preRouteToAgent } from '../src/router.ts';

test('ticket keys and work talk go to the manager', () => {
  for (const t of ['look at PAY-142', 'open jira and look for pay 142', 'look at Pay-142', 'work on that', "what's everyone doing?", 'how is the payment task going', 'what did you do today']) {
    assert.equal(preRouteToAgent(t), true, t);
  }
});

test('quick commands stay local', () => {
  for (const t of ['open teams', 'start my day', 'agentic dev', 'remember my board is PAY']) {
    assert.equal(preRouteToAgent(t), false, t);
  }
});

test('fall-through text is not pre-routed', () => {
  assert.equal(preRouteToAgent('summarize my calendar'), false);
});

test('a bare quick command with no ticket shape stays local even if it names jira', () => {
  assert.equal(preRouteToAgent('open jira'), false);
});

test('a quick verb followed by ticket-shaped talk still routes to the manager', () => {
  assert.equal(preRouteToAgent('open jira and look for pay 142'), true);
});
