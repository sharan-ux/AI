import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';

export type Git = (args: string[], cwd: string) => Promise<string>;
export const TICKET = /^[A-Z][A-Z0-9]+-\d+$/;

export const runGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout).trim());
    });
  });

export async function isGitRepo(dir: string, git: Git = runGit): Promise<boolean> {
  try { return (await git(['rev-parse', '--is-inside-work-tree'], dir)) === 'true'; } catch { return false; }
}

export async function defaultBranch(repo: string, git: Git = runGit): Promise<string> {
  try {
    return (await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)).replace(/^origin\//, '');
  } catch {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], repo);
  }
}

export function worktreePath(root: string, repo: string, ticket: string): string {
  return join(root, basename(repo), ticket);
}

const same = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

export async function ensureWorktree(
  { repo, ticket, root, git = runGit }: { repo: string; ticket: string; root: string; git?: Git },
): Promise<{ path: string; branch: string; base: string; created: boolean }> {
  if (!TICKET.test(ticket)) throw new Error(`not a ticket key: ${ticket}`);
  const branch = `izza/${ticket}`;
  const path = worktreePath(root, repo, ticket);
  const base = await defaultBranch(repo, git);
  const list = await git(['worktree', 'list', '--porcelain'], repo);
  if (list.split(/\r?\n/).some((l) => l.startsWith('worktree ') && same(l.slice(9), path))) return { path, branch, base, created: false };
  mkdirSync(dirname(path), { recursive: true });
  let exists = true;
  try { await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo); } catch { exists = false; }
  await git(exists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, base], repo);
  return { path, branch, base, created: true };
}
