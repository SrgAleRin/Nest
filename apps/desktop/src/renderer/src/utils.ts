import type { GitFile } from '@nest/shared';

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unexpected error';
}

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const index = list.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...list, item];
  const next = list.slice();
  next[index] = item;
  return next;
}

export function basename(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
}

export function shortPath(value: string, max = 42): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max + 1)}`;
}

export function statusLetter(file: GitFile): string {
  if (file.untracked) return 'U';
  const index = file.indexStatus === ' ' ? '' : file.indexStatus;
  const worktree = file.worktreeStatus === ' ' ? '' : file.worktreeStatus;
  return `${index}${worktree}` || '·';
}

export function statusTone(file: GitFile): string {
  if (file.untracked) return 'tone-untracked';
  if (file.indexStatus === 'A' || file.worktreeStatus === 'A') return 'tone-added';
  if (file.indexStatus === 'D' || file.worktreeStatus === 'D') return 'tone-deleted';
  if (file.indexStatus === 'R' || file.worktreeStatus === 'R') return 'tone-renamed';
  return 'tone-modified';
}

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
