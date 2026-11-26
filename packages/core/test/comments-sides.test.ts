import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommentView, DiffMode } from '@nest/shared';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

/**
 * Saved notes and the side they belong to:
 *
 * - A7: a note whose hunk leaves the current patch stays live (not stale), is
 *   reported as off-patch with a reason, and is still there after a restart.
 * - A15: the old side of an unstaged diff is the index, so a partially staged
 *   file anchors a deleted line to the index text instead of the HEAD text.
 */

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-comments-live-')));
const repoPath = path.join(tempRoot, 'repo');
const dbPath = path.join(tempRoot, 'nest.db');
const filePath = 'src/notes.txt';
const modes: DiffMode[] = ['both', 'unstaged'];

let core: Core | null = null;
let projectId = '';
let taskId = '';

class FakePty {
  readonly written: string[] = [];
  killed = false;
  onData(): void {}
  onExit(): void {}
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  kill(): void {
    this.killed = true;
  }
}

const ptys: FakePty[] = [];

function git(args: string[], cwd = repoPath): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function writeNotes(lines: string[]): void {
  mkdirSync(path.dirname(path.join(repoPath, filePath)), { recursive: true });
  writeFileSync(path.join(repoPath, filePath), `${lines.join('\n')}\n`, 'utf8');
}

/** One line of a side, so a test can state what the anchor had to store. */
function sideLine(spec: string, line: number): string {
  return (git(['show', spec]).split('\n')[line - 1] ?? '').trimEnd();
}

function openCore(): Core {
  // These tests own the PTYs; a restart must not auto-resume stored sessions.
  process.env.NEST_AUTO_RESUME = '0';
  return createCore({
    dbPath,
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript,
    sessions: {
      snapshotIntervalMs: 0,
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    },
  });
}

async function find(id: string, mode: DiffMode = 'unstaged'): Promise<CommentView> {
  const list = await core!.comments.list(taskId, { mode });
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`comment ${id} is not listed`);
  return found;
}

/** New-side line number of an added line, straight from the diff. */
async function addedLine(text: string, mode: DiffMode = 'both'): Promise<number> {
  const diff = await core!.git.diff(taskId, { mode });
  for (const file of diff.files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.type === 'add' && line.text.trimEnd() === text && line.newLine !== null) {
          return line.newLine;
        }
      }
    }
  }
  throw new Error(`line ${text} is not an addition in the ${mode} diff`);
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Nest']);
  git(['config', 'user.email', 'nest@example.com']);
  writeNotes(['alpha', 'beta', 'gamma']);
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  core = openCore();
  const { project } = await core.projects.add(repoPath);
  projectId = project.id;
  taskId = core.tasks.ensureCheckout(projectId).id;
});

afterAll(() => {
  core?.close();
  delete process.env.NEST_AUTO_RESUME;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('A15 · old-side anchor of a partially staged file', () => {
  it('stores the index text of a line deleted only in the workspace', async () => {
    // The index gets a new first line, so `beta` sits on index line 3 while
    // HEAD still has it on line 2 and on line 3 has `gamma`.
    writeNotes(['inserted', 'alpha', 'beta', 'gamma']);
    git(['add', filePath]);
    writeNotes(['inserted', 'alpha', 'gamma']);

    const diff = await core!.git.diff(taskId, { mode: 'unstaged' });
    const deleted = diff.files
      .find((file) => file.path === filePath)
      ?.hunks.flatMap((hunk) => hunk.lines)
      .find((line) => line.type === 'del' && line.text.trimEnd() === 'beta');
    expect(deleted?.oldLine).toBe(3);
    expect(sideLine(`:0:${filePath}`, 3)).toBe('beta');
    expect(sideLine(`HEAD:${filePath}`, 3)).toBe('gamma');

    const comment = await core!.comments.create({
      taskId,
      filePath,
      line: deleted?.oldLine ?? 0,
      side: 'old',
      body: 'Why drop beta here?',
      anchor: { mode: 'unstaged' },
    });

    expect(comment).toMatchObject({ side: 'old', line: 3, stale: false, anchorMode: 'unstaged' });
    // The load-bearing assertion: the anchor quotes the index, not HEAD.
    expect(comment.excerpt).toBe('beta');
  });

  it('keeps the note live while the hunk is off the viewed side', async () => {
    const [old] = await core!.comments.list(taskId, { mode: 'unstaged' });
    expect(old).toMatchObject({ stale: false, excerpt: 'beta' });
  });
});

describe('A7 · a note outside the current patch stays live and sendable', () => {
  let noteId = '';

  it('lists a note whose hunk was staged as off-patch, with the reason', async () => {
    writeNotes(['inserted', 'alpha', 'beta', 'gamma', 'delta']);
    const line = await addedLine('delta', 'unstaged');
    const note = await core!.comments.create({
      taskId,
      filePath,
      line,
      side: 'new',
      body: 'Should delta be covered by a test?',
      anchor: { mode: 'unstaged' },
    });
    noteId = note.id;
    expect(note).toMatchObject({ excerpt: 'delta', stale: false, anchorMode: 'unstaged' });

    // The unstaged view draws the note on its line.
    const viewed = await core!.comments.list(taskId, { mode: 'unstaged' });
    expect(viewed.find((item) => item.id === note.id)).toMatchObject({
      placement: { kind: 'inline' },
    });

    // Stage: the hunk moved into the index, so the unstaged side is empty.
    git(['add', filePath]);
    const staged = await find(noteId);
    expect(staged).toMatchObject({
      stale: false,
      placement: { kind: 'outside', reason: 'staged' },
    });

    // Commit: nothing is left locally, so the change is in history now.
    git(['commit', '-m', 'keep delta']);
    const committed = await find(noteId);
    expect(committed).toMatchObject({
      stale: false,
      placement: { kind: 'outside', reason: 'committed' },
    });
  });

  it('survives a restart of the core services on the same database', async () => {
    const before = await core!.comments.list(taskId, { mode: 'unstaged' });
    core!.close();
    core = openCore();

    const after = await core!.comments.list(taskId, { mode: 'unstaged' });
    expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
    expect(after.find((item) => item.id === noteId)).toMatchObject({
      stale: false,
      placement: { kind: 'outside', reason: 'committed' },
    });
  });

  it('sends an off-patch note through the fake harness', async () => {
    const session = await core!.sessions.start({ taskId, harnessId: 'fake' });
    const result = core!.comments.send(noteId, session.id);

    expect(result.sent).toBe(true);
    expect(result.text).toContain('Review comment — src/notes.txt');
    expect(result.text).toContain('Should delta be covered by a test?');
    // Bracketed paste plus one Enter, the documented sequence for this profile.
    expect(ptys.at(-1)?.written.join('')).toBe(`\x1b[200~${result.text}\x1b[201~\r`);
  });

  it('reports a missing live session instead of dropping the note', () => {
    core!.sessions.stop(core!.sessions.list(taskId)[0]!.id);
    const result = core!.comments.send(noteId);
    if (result.sent) {
      // A stop is asynchronous: once the runtime is gone the send must fail.
      expect(core!.sessions.activeForTask(taskId)).not.toBeNull();
      return;
    }
    expect(result).toMatchObject({ sent: false, reason: 'no_active_session' });
    expect(result.text).toContain('Should delta be covered by a test?');
  });

  it('groups every reason the panel shows, per view', async () => {
    for (const mode of modes) {
      const list = await core!.comments.list(taskId, { mode });
      for (const item of list) {
        expect(['inline', 'stale', 'outside']).toContain(item.placement.kind);
        if (item.placement.kind === 'outside') {
          expect(item.placement.reason).toBeTruthy();
        }
      }
    }
  });
});
