import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, isInside, splitCommand } from '../../src/agent/gate.ts';
import type { GateContext } from '../../src/agent/gate.ts';

const WT = 'C:\\izza\\worktrees\\payments-api\\PAY-142';
const REPO = 'C:\\Zilmoney\\payments-api';
const worker: GateContext = { cwd: WT, readRoots: [WT, REPO], writeRoots: [WT] };
const manager: GateContext = { cwd: 'C:\\Zilmoney\\Agentic\\data\\agent', readRoots: [REPO, 'C:\\izza\\worktrees'], writeRoots: [] };
const w = (tool: string, input: Record<string, unknown>) => decide({ actor: 'worker:PAY-142', tool, input }, worker).action;
const m = (tool: string, input: Record<string, unknown>) => decide({ actor: 'manager', tool, input }, manager).action;

test('paths', () => {
  assert.equal(isInside(`${WT}\\src\\a.ts`, WT, WT), true);
  assert.equal(isInside('src\\a.ts', WT, WT), true);
  assert.equal(isInside(`${WT}\\..\\PAY-143\\a.ts`, WT, WT), false);
  assert.equal(isInside('c:/izza/worktrees/payments-api/pay-142/x', WT, WT), true);
  assert.deepEqual(splitCommand('npm test && git push; ls | grep a'), ['npm test', 'git push', 'ls', 'grep a']);
});

test('worker file tools', () => {
  assert.equal(w('Read', { file_path: `${REPO}\\README.md` }), 'allow');
  assert.equal(w('Read', { file_path: 'C:\\Users\\USER\\Documents\\x.txt' }), 'deny');
  assert.equal(w('Read', { file_path: 'C:\\Users\\USER\\.ssh\\id_rsa' }), 'deny');
  assert.equal(w('Grep', { pattern: 'x' }), 'allow');
  assert.equal(w('Write', { file_path: `${WT}\\src\\a.ts`, content: '' }), 'allow');
  assert.equal(w('Edit', { file_path: `${REPO}\\src\\a.ts` }), 'deny');
  assert.equal(w('Write', { file_path: `${WT}\\.env.local` }), 'ask');
  assert.equal(w('TodoWrite', { todos: [] }), 'allow');
  assert.equal(w('WebFetch', { url: 'https://x' }), 'ask');
});

test('worker bash', () => {
  assert.equal(w('Bash', { command: 'npm test' }), 'allow');
  assert.equal(w('Bash', { command: 'git status && git diff' }), 'allow');
  assert.equal(w('Bash', { command: 'git add -A && git commit -m "fix"' }), 'allow');
  assert.equal(w('Bash', { command: 'git push origin izza/PAY-142' }), 'ask');
  assert.equal(w('Bash', { command: 'npm test && git push --force origin main' }), 'deny');
  assert.equal(w('Bash', { command: 'git push -f origin izza/PAY-142' }), 'ask');
  assert.equal(w('Bash', { command: 'git branch -D feature/x' }), 'deny');
  assert.equal(w('Bash', { command: 'gh pr create --fill' }), 'ask');
  assert.equal(w('Bash', { command: 'curl https://example.com' }), 'ask');
  assert.equal(w('Bash', { command: 'npm install lodash' }), 'ask');
  assert.equal(w('Bash', { command: 'aws s3 ls' }), 'ask');
  assert.equal(w('Bash', { command: 'cat ~/.aws/credentials' }), 'deny');
  assert.equal(w('Bash', { command: 'rm -rf C:\\Zilmoney' }), 'deny');
  assert.equal(w('Bash', { command: 'rm src\\old.ts' }), 'ask');
  assert.equal(w('Bash', { command: 'echo hi > out.txt' }), 'ask');
  assert.equal(w('Bash', { command: 'make deploy' }), 'ask');
  assert.equal(w('Bash', { command: '' }), 'ask');
});

test('mcp tools', () => {
  assert.equal(w('mcp__izza__start_worker', {}), 'deny');
  assert.equal(m('mcp__izza__start_worker', {}), 'allow');
  assert.equal(m('mcp__izza__permission', {}), 'deny');
  assert.equal(m('mcp__atlassian__getJiraIssue', { issueIdOrKey: 'PAY-142' }), 'allow');
  assert.equal(m('mcp__atlassian__searchJiraIssuesUsingJql', { jql: 'x' }), 'allow');
  assert.equal(m('mcp__atlassian__addCommentToJiraIssue', {}), 'ask');
  assert.equal(m('mcp__atlassian__transitionJiraIssue', {}), 'ask');
  assert.equal(w('mcp__atlassian__getJiraIssue', {}), 'deny');
  assert.equal(m('mcp__other__thing', {}), 'ask');
});

test('manager never edits and may only verify', () => {
  assert.equal(m('Write', { file_path: `${REPO}\\a.ts` }), 'deny');
  assert.equal(m('Read', { file_path: `${WT}\\src\\a.ts` }), 'allow');
  assert.equal(m('Bash', { command: `cd ${WT} && npm test` }), 'allow');
  assert.equal(m('Bash', { command: `cd ${WT} && git diff main...izza/PAY-142` }), 'allow');
  assert.equal(m('Bash', { command: `cd ${WT} && git commit -m x` }), 'ask');
  assert.equal(m('Bash', { command: 'cd C:\\Windows && dir' }), 'deny');
});

test('describe says exactly what will happen', () => {
  const d = decide({ actor: 'worker:PAY-142', tool: 'Bash', input: { command: 'git push origin izza/PAY-142' } }, worker);
  assert.match(d.describe, /git push origin izza\/PAY-142/);
});

test('finding 1: bash read commands respect path restrictions', () => {
  assert.equal(w('Bash', { command: 'cat C:\\Users\\USER\\Documents\\confidential.txt' }), 'deny');
  assert.equal(w('Bash', { command: 'findstr /s password C:\\Users\\USER\\Documents\\*.txt' }), 'deny');
  assert.equal(m('Bash', { command: 'type C:\\Windows\\win.ini' }), 'deny');
  assert.equal(w('Bash', { command: 'cat README.md' }), 'allow');
});

test('finding 2: quote-splitting does not dodge secret and env-file checks', () => {
  assert.equal(w('Bash', { command: "cat ~/.a''ws/credentials" }), 'deny');
  assert.equal(w('Bash', { command: "cat ~/.s''sh/id_rsa" }), 'deny');
  assert.equal(w('Bash', { command: "type ~/.git-cred''entials" }), 'deny');
  assert.equal(w('Bash', { command: `cat ${WT}\\.e''nv` }), 'ask');
  assert.equal(w('Bash', { command: 'cat ~/.npmrc' }), 'deny');
  assert.equal(w('Bash', { command: 'cat ~/.netrc' }), 'deny');
  assert.equal(w('Bash', { command: 'cat ~/.docker/config.json' }), 'deny');
  assert.equal(w('Bash', { command: 'cat ~/.azure/foo' }), 'deny');
  assert.equal(w('Bash', { command: 'cat ~/.kube/config' }), 'deny');
});

test('finding 2b: shell expansion is at least asked, and denied when it reaches a secret', () => {
  assert.equal(w('Bash', { command: 'echo $(cat ~/.ssh/id_rsa)' }), 'deny');
  assert.equal(w('Bash', { command: 'echo `whoami`' }), 'ask');
  assert.equal(w('Bash', { command: 'echo ${HOME}' }), 'ask');
  assert.equal(w('Bash', { command: 'echo %USERPROFILE%' }), 'ask');
  assert.equal(w('Bash', { command: 'echo $env:USERPROFILE' }), 'ask');
  assert.equal(w('Bash', { command: 'echo $HOME' }), 'ask');
});

test('finding 3: a lone & separates commands too, so a trailing read is judged on its own', () => {
  assert.deepEqual(splitCommand('npm test & git push'), ['npm test', 'git push']);
  assert.equal(w('Bash', { command: 'npm test & type C:\\Users\\USER\\Documents\\confidential.txt' }), 'deny');
  assert.equal(w('Bash', { command: 'npm run build & cat ~/.npmrc' }), 'deny');
});

test('fix round 2: a read command with no path arguments checks the tracked cwd, not just its args', () => {
  assert.equal(m('Bash', { command: 'dir' }), 'deny');
  assert.equal(m('Bash', { command: 'findstr /s /i token' }), 'deny');
  assert.equal(w('Bash', { command: 'dir' }), 'allow');
  assert.equal(m('Bash', { command: `cd ${REPO} && dir` }), 'allow');
});
