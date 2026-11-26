import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DiffMode } from '@nest/shared';
import { git } from './exec.js';
import { assertRef } from './refs.js';

/**
 * One side of a diff: the working tree, the index, or a committed ref.
 *
 * Comment anchors read their text from here. The unstaged old side is the
 * index (not `HEAD`), so a partially staged file anchors to the content the
 * diff view actually showed.
 */
export type SideSource =
  | { kind: 'worktree' }
  | { kind: 'index' }
  | { kind: 'ref'; ref: string };

export interface AnchorSides {
  old: SideSource;
  new: SideSource;
}

/** Descriptor a note is anchored against, mirroring `GitService.diff`. */
export interface AnchorDescriptor {
  mode: DiffMode;
  /** Base ref of the comparison, when the mode needs one. */
  baseRef: string | null;
  /** The row came from the staged side of a `both` view. */
  staged: boolean;
}

/**
 * Sides of one diff mode, matching what the Diff panel rendered:
 *
 * - `unstaged`: index → worktree
 * - `staged`: `HEAD` → index
 * - `base`: base ref → worktree (index included)
 * - `both`: per file, so `staged` decides which of the two pairs applies
 */
export function sidesFor(descriptor: AnchorDescriptor): AnchorSides {
  switch (descriptor.mode) {
    case 'unstaged':
      return { old: { kind: 'index' }, new: { kind: 'worktree' } };
    case 'staged':
      return { old: { kind: 'ref', ref: 'HEAD' }, new: { kind: 'index' } };
    case 'base':
      return {
        old: { kind: 'ref', ref: assertRef(descriptor.baseRef ?? 'HEAD', 'base ref') },
        new: { kind: 'worktree' },
      };
    case 'both':
      return descriptor.staged
        ? { old: { kind: 'ref', ref: 'HEAD' }, new: { kind: 'index' } }
        : { old: { kind: 'index' }, new: { kind: 'worktree' } };
  }
}

/** Lines of one side, or null when the side cannot be read (deleted, absent). */
export async function readSideLines(
  workspacePath: string,
  filePath: string,
  source: SideSource,
): Promise<string[] | null> {
  const relative = workspaceRelative(filePath);
  if (!relative) return null;
  try {
    if (source.kind === 'worktree') {
      const root = path.resolve(workspacePath);
      const target = path.resolve(root, relative);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
      return splitLines(await readFile(target, 'utf8'));
    }
    if (source.kind === 'index') {
      // `:0:<path>` is the stage-0 blob; a conflicted path has none, which
      // reads as "no content" and leaves the note without an anchor.
      const { stdout } = await git(workspacePath, ['show', `:0:${relative}`]);
      return splitLines(stdout);
    }
    const ref = assertRef(source.ref, 'anchor ref');
    const { stdout } = await git(workspacePath, ['show', `${ref}:${relative}`]);
    return splitLines(stdout);
  } catch {
    // A deleted file (new side) or a file absent from the ref (old side).
    return null;
  }
}

/** Workspace-relative POSIX path, or null when it would leave the workspace. */
export function workspaceRelative(filePath: string): string | null {
  if (!filePath || path.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath)) return null;
  const parts = filePath.split(/[\\/]/).filter((part) => part.length > 0 && part !== '.');
  if (parts.length === 0 || parts.includes('..')) return null;
  return parts.join('/');
}

export function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return body.split('\n');
}
