import type { DiffDescriptor, DiffFile, DiffMode, GitFile } from '@nest/shared';

/**
 * The Diff panel compares one explicit pair of sides. These helpers keep the
 * labels, the empty states and the stage actions tied to the mode the diff was
 * actually requested with, so a patch is never labelled with another side.
 */

/** Order of the mode switch: the default view first. */
export const DIFF_MODES: readonly DiffMode[] = ['both', 'unstaged', 'staged', 'base'];

export interface DiffModeOption {
  mode: DiffMode;
  /** Button label. */
  label: string;
  /** One line that states what is compared. */
  hint: string;
}

export const DIFF_MODE_OPTIONS: readonly DiffModeOption[] = [
  {
    mode: 'both',
    label: 'Both',
    hint: 'Staged and unstaged changes; each file shows which side it came from.',
  },
  {
    mode: 'unstaged',
    label: 'Unstaged',
    hint: 'Index → working tree; new-side line numbers point at the file on disk.',
  },
  {
    mode: 'staged',
    label: 'Staged',
    hint: 'HEAD → index; new-side line numbers point at the staged content.',
  },
  {
    mode: 'base',
    label: 'vs base',
    hint: 'Task base ref → working tree including the index.',
  },
];

/** Files with staged changes, and files with worktree changes (incl. untracked). */
export interface SideCounts {
  staged: number;
  unstaged: number;
}

export function countSides(files: readonly GitFile[]): SideCounts {
  let staged = 0;
  let unstaged = 0;
  for (const file of files) {
    if (file.staged) staged += 1;
    if (file.untracked || file.worktreeStatus !== ' ') unstaged += 1;
  }
  return { staged, unstaged };
}

/** What the server answered, in the panel's words. */
export function describeDiff(descriptor: DiffDescriptor | null): string {
  if (!descriptor) return 'Choose what to compare';
  switch (descriptor.mode) {
    case 'both':
      return 'Staged + unstaged';
    case 'unstaged':
      return 'Unstaged · index → working tree';
    case 'staged':
      return 'Staged · HEAD → index';
    case 'base':
      return `vs ${descriptor.baseRef ?? 'base'} · working tree incl. index`;
  }
}

/**
 * A response that is no longer about the selected mode must be dropped: the
 * user may switch modes while an earlier request is still running.
 */
export function isStaleDiff(descriptor: DiffDescriptor | null, mode: DiffMode): boolean {
  return descriptor !== null && descriptor.mode !== mode;
}

/** Side badge a file row needs when one view mixes both sides. */
export function fileSideBadge(file: DiffFile, mode: DiffMode): 'staged' | 'unstaged' | null {
  if (mode !== 'both') return null;
  return file.staged ? 'staged' : 'unstaged';
}

/**
 * Stage action for a file row. `base` mode has no single side to move (the
 * comparison already includes the index), so it offers none.
 */
export function fileStageAction(file: DiffFile, mode: DiffMode): 'stage' | 'unstage' | null {
  if (mode === 'base') return null;
  if (mode === 'staged') return 'unstage';
  return file.staged ? 'unstage' : 'stage';
}

/** Empty state that names the side and mentions work hidden in the other side. */
export function emptyDiffMessage(
  mode: DiffMode,
  counts: SideCounts,
  baseRef: string | null = null,
): string {
  switch (mode) {
    case 'unstaged':
      return counts.staged > 0
        ? `No unstaged changes · ${plural(counts.staged, 'file')} staged — switch to Staged or Both`
        : 'No unstaged changes';
    case 'staged':
      return counts.unstaged > 0
        ? `No staged changes · ${plural(counts.unstaged, 'file')} with unstaged changes`
        : 'No staged changes';
    case 'base':
      return baseRef ? `No changes against ${baseRef}` : 'No changes against the task base';
    case 'both':
      return 'No changes to review';
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
