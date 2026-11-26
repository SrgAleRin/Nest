import { describe, expect, it } from 'vitest';
import type { CommentOutsideReason, CommentPlacement, CommentView } from '@nest/shared';
import {
  batchSendSummary,
  groupOutsideComments,
  inlineComments,
  needsModeSwitch,
  openOutsideComments,
  openTargetMode,
  OUTSIDE_REASON_ORDER,
  outsideReasonHint,
  outsideReasonLabel,
  outsideSummary,
  sendFailureNotice,
  staleComments,
} from './commentPlacement';

function comment(patch: Partial<CommentView> & { placement?: CommentPlacement } = {}): CommentView {
  return {
    id: 'comment-1',
    taskId: 'task-1',
    filePath: 'src/a.ts',
    line: 12,
    endLine: 12,
    side: 'new',
    body: 'Body',
    status: 'open',
    stale: false,
    excerpt: 'const value = 1;',
    anchorMode: 'unstaged',
    createdAt: '2026-11-20T10:00:00.000Z',
    updatedAt: '2026-11-20T10:00:00.000Z',
    placement: { kind: 'outside', reason: 'staged' },
    ...patch,
  };
}

function outside(reason: CommentOutsideReason, patch: Partial<CommentView> = {}): CommentView {
  return comment({ placement: { kind: 'outside', reason }, ...patch });
}

describe('notes outside the patch', () => {
  it('groups by reason in a fixed order and keeps the counts', () => {
    const sections = groupOutsideComments([
      outside('committed', { id: 'c1', filePath: 'src/b.ts' }),
      outside('staged', { id: 'c2' }),
      outside('staged', { id: 'c3', filePath: 'src/a.ts', line: 4 }),
      comment({ id: 'inline', placement: { kind: 'inline' } }),
      comment({ id: 'stale', placement: { kind: 'stale' } }),
    ]);

    expect(sections.map((section) => section.reason)).toEqual(['staged', 'committed']);
    expect(sections.map((section) => section.count)).toEqual([2, 1]);
    // Inside a group, stable by file and line.
    expect(sections[0]?.comments.map((item) => item.id)).toEqual(['c3', 'c2']);
    // Notes that are not off-patch never leak into the area.
    expect(sections.flatMap((section) => section.comments.map((item) => item.id))).not.toContain(
      'inline',
    );
  });

  it('reports every reason the core can answer, with a label and a hint', () => {
    const sections = groupOutsideComments(
      OUTSIDE_REASON_ORDER.map((reason, index) => outside(reason, { id: `c${index}` })),
    );
    expect(sections).toHaveLength(OUTSIDE_REASON_ORDER.length);
    for (const reason of OUTSIDE_REASON_ORDER) {
      expect(outsideReasonLabel(reason)).not.toBe('');
      expect(outsideReasonHint(reason)).not.toBe('');
    }
  });

  it('keeps stale notes out of the off-patch area', () => {
    const comments = [
      comment({ id: 'stale', placement: { kind: 'stale' }, stale: true }),
      comment({ id: 'inline', placement: { kind: 'inline' } }),
      outside('file_not_in_diff', { id: 'outside' }),
    ];
    expect(staleComments(comments).map((item) => item.id)).toEqual(['stale']);
    expect(inlineComments(comments).map((item) => item.id)).toEqual(['inline']);
    expect(groupOutsideComments(comments).flatMap((s) => s.comments.map((c) => c.id))).toEqual([
      'outside',
    ]);
  });

  it('summarises the area with counts while it is collapsed', () => {
    expect(outsideSummary([])).toBe('No notes outside this patch');
    const summary = outsideSummary([
      outside('staged', { id: 'a' }),
      outside('committed', { id: 'b', status: 'resolved' }),
      comment({ id: 's', placement: { kind: 'stale' } }),
    ]);
    expect(summary).toContain('2 notes outside this patch');
    expect(summary).toContain('1 open');
    expect(summary).toContain('1 stale');
  });

  it('offers the open notes, not the resolved ones, for a batch send', () => {
    const comments = [
      outside('staged', { id: 'open' }),
      outside('committed', { id: 'resolved', status: 'resolved' }),
      comment({ id: 'inline', placement: { kind: 'inline' } }),
    ];
    expect(openOutsideComments(comments).map((item) => item.id)).toEqual(['open']);
  });
});

describe('note actions', () => {
  it('opens the comparison where the note actually lives', () => {
    // The hunk moved into the index: open the staged view.
    expect(openTargetMode(outside('staged', { anchorMode: 'unstaged' }), 'unstaged')).toBe(
      'staged',
    );
    expect(needsModeSwitch(outside('staged', { anchorMode: 'unstaged' }), 'unstaged')).toBe(true);
    // Written against another comparison: switch back to it.
    expect(openTargetMode(outside('other_mode', { anchorMode: 'base' }), 'staged')).toBe('base');
    // Already the right comparison: stay where the user is.
    expect(needsModeSwitch(outside('not_in_patch', { anchorMode: 'unstaged' }), 'unstaged')).toBe(
      false,
    );
    // A note from before the comparison was stored stays in the current view.
    expect(openTargetMode(outside('committed', { anchorMode: null }), 'both')).toBe('both');
  });

  it('turns a failed send into a message and a clipboard fallback', () => {
    const missing = sendFailureNotice('no_active_session', null);
    expect(missing).toMatchObject({ level: 'warn', copy: true });
    expect(missing.message).toContain('No running session');
    expect(missing.message).toContain('clipboard');

    expect(sendFailureNotice('session_not_running', 'Claude Code')).toMatchObject({
      copy: true,
    });
    expect(sendFailureNotice('session_belongs_to_another_task', null).copy).toBe(true);

    // A successful send never copies.
    expect(sendFailureNotice(undefined, 'Claude Code')).toEqual({
      level: 'info',
      message: 'Sent to Claude Code',
      copy: false,
    });
  });

  it('summarises a batch send', () => {
    expect(batchSendSummary(2, 0, 'Claude Code')).toBe('Sent 2 notes to Claude Code');
    expect(batchSendSummary(1, 0, null)).toBe('Sent 1 note to the session');
    expect(batchSendSummary(0, 2, null)).toContain('No notes sent');
    expect(batchSendSummary(1, 2, 'Claude Code')).toBe(
      'Sent 1 of 3 notes to Claude Code; 2 copied to the clipboard.',
    );
  });
});
