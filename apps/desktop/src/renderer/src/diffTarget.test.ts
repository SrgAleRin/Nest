import { describe, expect, it } from 'vitest';
import type { CommentView, DiffDescriptor, DiffFile, DiffMode, GitFile } from '@nest/shared';
import {
  diffRequestKey,
  diffSideCounts,
  initialMode,
  isCurrentDiffAnswer,
  isTypingTarget,
  missingTargetMessage,
  otherSideAction,
  pickTargetFile,
  restrictComments,
  targetLabel,
  type DiffRequest,
} from './diffTarget';
import type { GitSelection } from './state/gitSnapshot';

function diffFile(patch: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/a.ts',
    oldPath: 'src/a.ts',
    status: 'modified',
    staged: false,
    hunks: [],
    additions: 1,
    deletions: 0,
    raw: '',
    ...patch,
  };
}

function descriptor(patch: Partial<DiffDescriptor> = {}): DiffDescriptor {
  return {
    mode: 'staged',
    baseRef: null,
    workspaceIncludesIndex: false,
    anchorSide: 'index',
    ...patch,
  };
}

function request(patch: Partial<DiffRequest> = {}): DiffRequest {
  return { taskId: 'task-1', mode: 'staged', path: 'src/a.ts', ...patch };
}

function selection(patch: Partial<GitSelection> = {}): GitSelection {
  return { path: 'src/a.ts', mode: 'staged', ...patch };
}

function comment(patch: Partial<CommentView> = {}): CommentView {
  return {
    id: 'c1',
    taskId: 'task-1',
    filePath: 'src/a.ts',
    line: 3,
    endLine: 3,
    side: 'new',
    body: 'note',
    status: 'open',
    stale: false,
    excerpt: 'const a = 1;',
    anchorMode: 'staged',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    placement: { kind: 'inline' },
    ...patch,
  };
}

describe('pickTargetFile', () => {
  it('returns the diff file the selection points at', () => {
    const wanted = diffFile({ path: 'src/b.ts' });
    const files = [diffFile({ path: 'src/a.ts' }), wanted];
    expect(pickTargetFile(files, 'src/b.ts')).toBe(wanted);
  });

  it('returns null when the file is not in the answer', () => {
    expect(pickTargetFile([diffFile({ path: 'src/a.ts' })], 'src/b.ts')).toBeNull();
  });

  it('returns null without a selection: the whole patch has no single file', () => {
    expect(pickTargetFile([diffFile()], null)).toBeNull();
  });

  it('does not guess from another path of the same patch', () => {
    expect(pickTargetFile([diffFile({ path: 'src/a.ts' })], 'src/aa.ts')).toBeNull();
  });
});

describe('targetLabel', () => {
  it('states the file and the side it was opened on', () => {
    expect(targetLabel(selection())).toBe('src/a.ts · staged side');
    expect(targetLabel(selection({ path: 'src/b.ts', mode: 'unstaged' }))).toBe(
      'src/b.ts · unstaged side',
    );
  });
});

describe('missingTargetMessage', () => {
  it('says the file is not in the comparison and never claims another patch', () => {
    expect(missingTargetMessage(selection(), 'staged')).toBe(
      'Not in this comparison: src/a.ts has no staged change.',
    );
  });

  it('names the comparison the panel is showing', () => {
    expect(missingTargetMessage(selection({ mode: 'unstaged' }), 'unstaged')).toContain('unstaged');
    expect(missingTargetMessage(selection(), 'both')).toContain('staged or unstaged');
    expect(missingTargetMessage(selection(), 'base')).toContain('base');
  });
});

describe('diffRequestKey', () => {
  it('is stable for the same task, comparison and file', () => {
    expect(diffRequestKey(request())).toBe(diffRequestKey(request()));
  });

  it('separates another file, another comparison and another task', () => {
    const base = diffRequestKey(request());
    expect(diffRequestKey(request({ path: 'src/b.ts' }))).not.toBe(base);
    expect(diffRequestKey(request({ mode: 'unstaged' }))).not.toBe(base);
    expect(diffRequestKey(request({ taskId: 'task-2' }))).not.toBe(base);
  });

  it('separates a single file from the whole patch', () => {
    expect(diffRequestKey(request({ path: null }))).not.toBe(diffRequestKey(request()));
  });
});

describe('isCurrentDiffAnswer', () => {
  const wanted = request();

  it('accepts the answer of the request that is still wanted', () => {
    expect(isCurrentDiffAnswer(wanted, wanted, descriptor())).toBe(true);
  });

  it('drops an answer for the file that was open before', () => {
    const made = request({ path: 'src/old.ts' });
    expect(isCurrentDiffAnswer(made, wanted, descriptor())).toBe(false);
  });

  it('drops an answer for the previous comparison', () => {
    const made = request({ mode: 'both' });
    expect(isCurrentDiffAnswer(made, wanted, descriptor())).toBe(false);
  });

  it('drops an answer the server labelled with another comparison', () => {
    expect(isCurrentDiffAnswer(wanted, wanted, descriptor({ mode: 'unstaged' }))).toBe(false);
  });

  it('accepts a server answer without a descriptor rather than blanking the view', () => {
    expect(isCurrentDiffAnswer(wanted, wanted, null)).toBe(true);
  });

  it('drops everything when nothing is wanted any more', () => {
    expect(isCurrentDiffAnswer(wanted, null, descriptor())).toBe(false);
  });
});

describe('restrictComments', () => {
  it('keeps every note when the whole patch is shown', () => {
    const comments = [comment(), comment({ id: 'c2', filePath: 'src/b.ts' })];
    expect(restrictComments(comments, null)).toEqual(comments);
  });

  it('moves notes of other files into the outside area with their reason', () => {
    const own = comment();
    const other = comment({ id: 'c2', filePath: 'src/b.ts' });
    const [first, second] = restrictComments([own, other], 'src/a.ts');
    expect(first?.placement).toEqual({ kind: 'inline' });
    expect(second?.placement).toEqual({ kind: 'outside', reason: 'file_not_in_diff' });
    // The note keeps its text and anchor: it stays openable, sendable, editable.
    expect(second?.body).toBe('note');
    expect(second?.filePath).toBe('src/b.ts');
  });

  it('leaves a note that core already placed outside untouched', () => {
    const outside = comment({ placement: { kind: 'outside', reason: 'staged' } });
    expect(restrictComments([outside], 'src/a.ts')[0]?.placement).toEqual({
      kind: 'outside',
      reason: 'staged',
    });
  });
});

describe('diffSideCounts', () => {
  it('counts both sides of a mixed patch', () => {
    const counts = diffSideCounts({
      files: [diffFile({ staged: true }), diffFile({ path: 'src/b.ts', staged: false })],
    });
    expect(counts).toEqual({ staged: 1, unstaged: 1 });
  });

  it('counts nothing before the first answer', () => {
    expect(diffSideCounts(null)).toEqual({ staged: 0, unstaged: 0 });
  });
});

describe('initialMode', () => {
  it('opens on the selected side', () => {
    expect(initialMode(selection({ mode: 'unstaged' }), 'both')).toBe('unstaged');
  });

  it('keeps the default when nothing is selected', () => {
    const fallback: DiffMode = 'both';
    expect(initialMode(null, fallback)).toBe('both');
  });
});

describe('isTypingTarget', () => {
  it('leaves Escape to a field', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it('treats a button, a div and no target as the panel own keys', () => {
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

function gitFile(patch: Partial<GitFile> = {}): GitFile {
  return {
    path: 'src/a.ts',
    oldPath: null,
    copied: false,
    indexStatus: ' ',
    worktreeStatus: ' ',
    conflict: false,
    staged: false,
    unstaged: false,
    untracked: false,
    additions: 1,
    deletions: 0,
    stagedAdditions: 0,
    stagedDeletions: 0,
    unstagedAdditions: 1,
    unstagedDeletions: 0,
    ...patch,
  };
}

describe('otherSideAction', () => {
  it('offers the staged side of a file that only has staged changes', () => {
    expect(
      otherSideAction(selection({ mode: 'unstaged' }), [
        gitFile({ indexStatus: 'M', staged: true }),
      ]),
    ).toEqual({ mode: 'staged', label: 'Show staged side' });
  });

  it('offers the unstaged side of a file that only has worktree changes', () => {
    expect(
      otherSideAction(selection({ mode: 'staged' }), [
        gitFile({ worktreeStatus: 'M', unstaged: true }),
      ]),
    ).toEqual({ mode: 'unstaged', label: 'Show unstaged side' });
    // An untracked file lives on the unstaged side too.
    expect(
      otherSideAction(selection({ path: 'notes.md', mode: 'staged' }), [
        gitFile({ path: 'notes.md', untracked: true }),
      ])?.mode,
    ).toBe('unstaged');
  });

  it('offers nothing without a change on the other side, or before the status lands', () => {
    expect(
      otherSideAction(selection({ mode: 'unstaged' }), [gitFile({ unstaged: true })]),
    ).toBeNull();
    expect(otherSideAction(selection(), [gitFile()])).toBeNull();
    expect(otherSideAction(selection(), [])).toBeNull();
    expect(otherSideAction(selection(), null)).toBeNull();
  });

  it('names the missing side in the comparison message', () => {
    expect(missingTargetMessage(selection({ mode: 'staged' }), 'staged')).toBe(
      'Not in this comparison: src/a.ts has no staged change.',
    );
  });
});
