import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { NestError } from '../src/errors.js';
import { currentBranch, resolveDefaultBase } from '../src/git/base.js';
import { createCore, type Core } from '../src/index.js';
import { ProjectService } from '../src/services/projects.js';
import { openDatabase, migrate } from '../src/index.js';
import './gitEnv.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-base-ref-')));

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function commit(cwd: string, message: string): void {
  git(['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', message], cwd);
}

/** Repository with a reachable `origin`, so `origin/HEAD` can be resolved. */
function remoteRepo(name: string): { repo: string; origin: string } {
  const root = path.join(tempRoot, name);
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  mkdirSync(origin, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(['init', '--bare', '-b', 'main', origin], root);
  git(['init', '-b', 'main'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# base\n', 'utf8');
  git(['add', '.'], repo);
  commit(repo, 'init');
  git(['branch', 'feature'], repo);
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  git(['remote', 'set-head', 'origin', '-a'], repo);
  return { repo, origin };
}

function localRepo(name: string): string {
  const repo = path.join(tempRoot, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  writeFileSync(path.join(repo, 'README.md'), '# local\n', 'utf8');
  git(['add', '.'], repo);
  commit(repo, 'init');
  return repo;
}

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('default base resolution', () => {
  it('prefers origin/HEAD when the remote-tracking ref exists', async () => {
    const { repo } = remoteRepo('remote');
    expect(git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)).toBe('origin/main');
    expect(await resolveDefaultBase(repo)).toBe('origin/main');
  });

  it('falls back to the current branch in a repository without a remote', async () => {
    const repo = localRepo('local');
    expect(gitOrNull(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo)).toBeNull();
    expect(await resolveDefaultBase(repo)).toBe('main');

    git(['checkout', '-b', 'feature'], repo);
    expect(await currentBranch(repo)).toBe('feature');
    expect(await resolveDefaultBase(repo)).toBe('feature');
  });

  it('ignores an unborn origin/HEAD that points at a ref nobody fetched', async () => {
    const { repo } = remoteRepo('unborn');
    // A remote with no default branch yet, or an offline clone that never got
    // refs/remotes/origin/main: the symbolic ref exists, the ref does not.
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], repo);
    expect(gitOrNull(['rev-parse', '--verify', 'refs/remotes/origin/HEAD'], repo)).toBeNull();
    expect(await resolveDefaultBase(repo)).toBe('main');
  });
});

describe('project default base', () => {
  it('stores origin/HEAD when the project is registered', async () => {
    const { repo } = remoteRepo('project-remote');
    const db = openDatabase(path.join(tempRoot, 'project-remote.db'));
    migrate(db);
    const projects = new ProjectService(db);
    const { project } = await projects.add(repo);
    expect(project.defaultBaseRef).toBe('origin/main');
    // Registered once: switching branches afterwards does not move the default.
    git(['checkout', 'feature'], repo);
    expect(projects.get(project.id).defaultBaseRef).toBe('origin/main');
    db.close();
  });

  it('stores the current branch for a repository without a remote', async () => {
    const repo = localRepo('project-local');
    const db = openDatabase(path.join(tempRoot, 'project-local.db'));
    migrate(db);
    const projects = new ProjectService(db);
    const { project } = await projects.add(repo);
    expect(project.defaultBaseRef).toBe('main');
    db.close();
  });

  it('resolves the default lazily for rows registered before migration 12', async () => {
    const { repo } = remoteRepo('project-old');
    const db = openDatabase(path.join(tempRoot, 'project-old.db'));
    migrate(db);
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
      'old',
      'old',
      repo,
      '2026-01-01T00:00:00.000Z',
    );
    const projects = new ProjectService(db);
    expect(projects.get('old').defaultBaseRef).toBeNull();
    expect(await projects.ensureDefaultBase('old')).toBe('origin/main');
    // Stored, so the second call does not need Git.
    expect(projects.get('old').defaultBaseRef).toBe('origin/main');
    db.close();
  });
});

describe('tasks.create base ref', () => {
  let core: Core | null = null;
  let projectId = '';
  let repoPath = '';
  let worktreesRoot = '';

  async function setup(name: string): Promise<void> {
    const root = path.join(tempRoot, name);
    const { repo } = remoteRepo(name);
    repoPath = repo;
    worktreesRoot = path.join(root, 'worktrees');
    core = createCore({
      dbPath: path.join(root, 'nest.db'),
      worktreesRoot,
      fakeHarnessScript,
    });
    const { project } = await core.projects.add(repoPath);
    projectId = project.id;
    // The checkout is on another branch: the project default must still win.
    git(['checkout', 'feature'], repoPath);
  }

  it('uses the project default instead of the checked-out branch', async () => {
    await setup('create-default');
    if (!core) throw new Error('core was not created');
    const task = await core.tasks.create({ projectId, title: 'Default base' });
    expect(task.baseRef).toBe('origin/main');
    // origin/main was the tip when the project was registered.
    expect(git(['rev-parse', 'HEAD'], task.workspacePath)).toBe(
      git(['rev-parse', 'origin/main'], repoPath),
    );
    // Task metadata keeps the base even though the workspace is on nest/...
    expect(core.tasks.get(task.id).baseRef).toBe('origin/main');
    expect(core.projects.get(projectId).defaultBaseRef).toBe('origin/main');
    core.close();
    core = null;
  });

  it('honours an explicit base ref from the dialog', async () => {
    await setup('create-explicit');
    if (!core) throw new Error('core was not created');
    const featureTip = git(['rev-parse', 'feature'], repoPath);
    const task = await core.tasks.create({
      projectId,
      title: 'Explicit base',
      baseRef: 'feature',
    });
    expect(task.baseRef).toBe('feature');
    expect(git(['rev-parse', 'HEAD'], task.workspacePath)).toBe(featureTip);
    core.close();
    core = null;
  });

  it('reports a missing base ref and creates nothing', async () => {
    await setup('create-missing');
    if (!core) throw new Error('core was not created');
    const before = core.tasks.list(projectId).length;
    await expect(
      core.tasks.create({ projectId, title: 'Bad base', baseRef: 'nope' }),
    ).rejects.toMatchObject({ code: 'base_branch_missing' });
    expect(core.tasks.list(projectId).length).toBe(before);
    core.close();
    core = null;
  });

  it('previews the branch, path and effective base before creating anything', async () => {
    await setup('create-preview');
    if (!core) throw new Error('core was not created');
    const empty = await core.tasks.preview({ projectId });
    expect(empty).toMatchObject({
      branch: null,
      workspacePath: null,
      baseRef: 'origin/main',
      baseSource: 'project',
      baseAvailable: true,
    });

    const preview = await core.tasks.preview({ projectId, title: 'Preview me' });
    expect(preview.branch).toBe('nest/preview-me');
    expect(preview.workspacePath?.startsWith(worktreesRoot)).toBe(true);
    expect(preview.workspacePath?.endsWith('preview-me')).toBe(true);
    expect(core.tasks.list(projectId).length).toBe(1); // only the main checkout

    const explicit = await core.tasks.preview({ projectId, title: 'Preview me', baseRef: 'nope' });
    expect(explicit.baseSource).toBe('explicit');
    expect(explicit.baseAvailable).toBe(false);
    await expect(
      core.tasks.preview({ projectId, title: 'Preview me', baseRef: 'feature' }),
    ).resolves.toMatchObject({ baseRef: 'feature', baseSource: 'explicit', baseAvailable: true });
    core.close();
    core = null;
  });
});

describe('cancelling a creation', () => {
  it('aborts during creation: no task, no worktree, no session, other tasks untouched', async () => {
    const { repo } = remoteRepo('abort');
    const worktreesRoot = path.join(tempRoot, 'abort', 'worktrees');
    const core = createCore({
      dbPath: path.join(tempRoot, 'abort', 'nest.db'),
      worktreesRoot,
      fakeHarnessScript,
    });
    try {
      const { project } = await core.projects.add(repo);
      const kept = await core.tasks.create({ projectId: project.id, title: 'Keep me' });

      const operationId = 'op-abort-early';
      const preview = await core.tasks.preview({ projectId: project.id, title: 'Cancel me' });
      expect(preview.workspacePath).not.toBeNull();
      const created = core.tasks.create({
        projectId: project.id,
        title: 'Cancel me',
        operationId,
      });
      // The fetch/checkpoint is async, so the abort lands inside the operation.
      const aborted = await core.tasks.abort(operationId);
      expect(aborted.aborted).toBe(true);
      await expect(created).rejects.toBeInstanceOf(NestError);
      await expect(created).rejects.toMatchObject({ code: 'task_aborted' });

      const titles = core.tasks.list(project.id).map((task) => task.title);
      expect(titles).toContain('Keep me');
      expect(titles).not.toContain('Cancel me');
      expect(existsSync(preview.workspacePath as string)).toBe(false);
      expect(gitOrNull(['rev-parse', '--verify', 'refs/heads/nest/cancel-me'], repo)).toBeNull();
      // Aborting means no session is started, for this operation or any other.
      expect(core.sessions.list()).toEqual([]);
      // The other task's worktree and branch are still there.
      expect(existsSync(kept.workspacePath)).toBe(true);
      expect(
        gitOrNull(['rev-parse', '--verify', `refs/heads/${kept.branch}`], repo),
      ).not.toBeNull();
    } finally {
      core.close();
    }
  });

  it('aborts a finished creation that nobody started a session in', async () => {
    const { repo } = remoteRepo('abort-late');
    const core = createCore({
      dbPath: path.join(tempRoot, 'abort-late', 'nest.db'),
      worktreesRoot: path.join(tempRoot, 'abort-late', 'worktrees'),
      fakeHarnessScript,
    });
    try {
      const { project } = await core.projects.add(repo);
      const operationId = 'op-abort-late';
      const task = await core.tasks.create({
        projectId: project.id,
        title: 'Late cancel',
        operationId,
      });
      expect(existsSync(task.workspacePath)).toBe(true);

      const aborted = await core.tasks.abort(operationId);
      expect(aborted.aborted).toBe(true);
      expect(core.tasks.list(project.id).map((item) => item.id)).not.toContain(task.id);
      expect(existsSync(task.workspacePath)).toBe(false);
      expect(gitOrNull(['rev-parse', '--verify', `refs/heads/${task.branch}`], repo)).toBeNull();
      expect(core.sessions.list()).toEqual([]);
    } finally {
      core.close();
    }
  });

  it('keeps the task once a session was started in it', async () => {
    const { repo } = remoteRepo('abort-started');
    const core = createCore({
      dbPath: path.join(tempRoot, 'abort-started', 'nest.db'),
      worktreesRoot: path.join(tempRoot, 'abort-started', 'worktrees'),
      fakeHarnessScript,
    });
    try {
      const { project } = await core.projects.add(repo);
      const operationId = 'op-abort-started';
      const task = await core.tasks.create({
        projectId: project.id,
        title: 'Started',
        operationId,
      });
      // A session row is enough to prove the task is in use; no PTY needed.
      core.db
        .prepare(
          `INSERT INTO sessions (id, task_id, harness_id, title, status, cwd, scrollback, created_at, updated_at)
           VALUES ('s-started', ?, 'fake', 'FakeHarness', 'running', ?, '', ?, ?)`,
        )
        .run(task.id, task.workspacePath, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      expect(await core.tasks.abort(operationId)).toEqual({ aborted: false });
      expect(core.tasks.list(project.id).map((item) => item.id)).toContain(task.id);
    } finally {
      core.close();
    }
  });
});
