import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type TaskStatus = 'queued' | 'running' | 'needs-user' | 'verifying' | 'done' | 'pr-open' | 'paused' | 'failed';
export interface TaskRecord {
  id: string; title: string; project: string; repo: string; worktree: string; branch: string; session: string;
  status: TaskStatus; decisions: string[]; rounds: number; lastKind: string; updated: string;
}
export interface Board { tasks: TaskRecord[] }
type Warn = (message: string) => void;

// A function, not a shared object literal, so every task gets its own `decisions` array
// (a shared literal would let one task's array mutate every other task's).
function emptyTask(id: string): TaskRecord {
  return { id, title: '', project: '', repo: '', worktree: '', branch: '', session: '', status: 'queued', decisions: [], rounds: 0, lastKind: '', updated: '' };
}

export function loadBoard(path: string, warn: Warn = console.warn): Board {
  if (!existsSync(path)) return { tasks: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
    if (!Array.isArray(raw?.tasks)) throw new Error('bad shape');
    return {
      tasks: raw.tasks
        .filter((t: any) => t && typeof t.id === 'string')
        .map((t: any) => ({ ...emptyTask(t.id), ...t, decisions: Array.isArray(t.decisions) ? [...t.decisions] : [] })),
    };
  } catch {
    const backup = `${path}.corrupt-${Date.now()}`;
    renameSync(path, backup);
    warn(`the task board was unreadable — saved it as ${backup} and started a fresh one`);
    return { tasks: [] };
  }
}

export function saveBoard(path: string, board: Board): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8');
  renameSync(tmp, path);
}

export function getTask(board: Board, id: string): TaskRecord | undefined {
  return board.tasks.find((t) => t.id === id);
}

export function upsertTask(board: Board, patch: Partial<TaskRecord> & { id: string }): TaskRecord {
  const existing = getTask(board, patch.id);
  const next: TaskRecord = {
    ...emptyTask(patch.id),
    ...existing,
    ...patch,
    decisions: [...(patch.decisions ?? existing?.decisions ?? [])],
    updated: new Date().toISOString(),
  };
  if (existing) board.tasks[board.tasks.indexOf(existing)] = next; else board.tasks.push(next);
  return next;
}
