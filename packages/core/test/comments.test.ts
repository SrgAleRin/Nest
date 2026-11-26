import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-comments-'));
const repoPath = path.join(tempRoot, 'repo');
const filePath = 'src/notes.txt';
let core: Core | null = null;
let projectId = '';
let taskId = '';
let commentId = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

function writeNotes(lines: string[]): void {
  writeFileSync(path.join(repoPath, 'src', 'notes.txt'), `${lines.join('\n')}\n`, 'utf8');
}

beforeAll(async () => {
  mkdirSync(path.join(repoPath, 'src'), { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeNotes(['alpha', 'beta', 'gamma']);
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );

  // An uncommitted change gives the new side a diff to comment on.
  writeNotes(['alpha', 'beta', 'gamma', 'delta']);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  projectId = project.id;
  taskId = core.tasks.ensureCheckout(projectId).id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('comment anchors', () => {
  it('stores a multi-line range and follows it when lines shift', async () => {
    const comment = await core!.comments.create({
      taskId,
      filePath,
      line: 2,
      endLine: 3,
      side: 'new',
      body: 'Lines beta and gamma need a look',
    });
    commentId = comment.id;
    expect(comment).toMatchObject({ line: 2, endLine: 3, stale: false });

    // A new first line moves the anchored block down by one.
    writeNotes(['inserted', 'alpha', 'beta', 'gamma', 'delta']);
    const [moved] = await core!.comments.list(taskId);
    expect(moved).toMatchObject({ id: commentId, line: 3, endLine: 4, stale: false });

    // The moved numbers are persisted, not only returned.
    const stored = core!.db
      .prepare('SELECT line, end_line FROM review_comments WHERE id = ?')
      .get(commentId) as { line: number; end_line: number };
    expect(stored).toEqual({ line: 3, end_line: 4 });
  });

  it('marks the comment stale when the anchored text disappears', async () => {
    writeNotes(['inserted', 'alpha', 'BETA', 'gamma', 'delta']);
    const [stale] = await core!.comments.list(taskId);
    expect(stale).toMatchObject({ id: commentId, stale: true });
  });

  it('returns to the line when the text comes back', async () => {
    writeNotes(['inserted', 'alpha', 'beta', 'gamma', 'delta']);
    const [restored] = await core!.comments.list(taskId);
    expect(restored).toMatchObject({ line: 3, endLine: 4, stale: false });
  });

  it('refuses an anchor file that a link resolves outside the workspace', async (context) => {
    const outside = path.join(tempRoot, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'outside the workspace\n', 'utf8');
    try {
      // A directory link is a symlink on POSIX and a junction on Windows, where
      // a file symlink needs administrator rights or Developer Mode.
      symlinkSync(
        outside,
        path.join(repoPath, 'escape'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      // The platform cannot create the link; paths.test.ts states the policy.
      context.skip();
      return;
    }

    await expect(
      core!.comments.create({
        taskId,
        filePath: 'escape/secret.txt',
        line: 1,
        side: 'new',
        body: 'read the secret',
      }),
    ).rejects.toMatchObject({ code: 'path_outside_workspace' });
  });
});
