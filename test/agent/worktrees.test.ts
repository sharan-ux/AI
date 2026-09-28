import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureWorktree, isGitRepo, worktreePath } from '../../src/agent/worktrees.ts';
import { tempDir } from '../fixtures.ts';

function makeRepo() {
  const dir = join(tempDir(), 'demo-repo');
  mkdirSync(dir);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main');
  git('config', 'user.email', 'izza@test'); git('config', 'user.name', 'Izza Test');
  writeFileSync(join(dir, 'a.txt'), 'hi');
  git('add', '.'); git('commit', '-m', 'init');
  return dir;
}

test('creates a worktree on izza/<ticket> from the default branch, then reuses it', async () => {
  const repo = makeRepo();
  const root = join(tempDir(), 'wt');
  const first = await ensureWorktree({ repo, ticket: 'DEMO-1', root });
  assert.equal(first.created, true);
  assert.equal(first.branch, 'izza/DEMO-1');
  assert.equal(first.base, 'main');
  assert.equal(first.path, worktreePath(root, repo, 'DEMO-1'));
  assert.ok(existsSync(join(first.path, 'a.txt')));
  const second = await ensureWorktree({ repo, ticket: 'DEMO-1', root });
  assert.equal(second.created, false);
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).toString().trim();
  assert.equal(branch, 'main', 'the user checkout is untouched');
});

test('rejects things that are not ticket keys', async () => {
  const repo = makeRepo();
  await assert.rejects(ensureWorktree({ repo, ticket: '../evil', root: tempDir() }), /ticket/);
});

test('isGitRepo', async () => {
  assert.equal(await isGitRepo(makeRepo()), true);
  assert.equal(await isGitRepo(tempDir()), false);
});
