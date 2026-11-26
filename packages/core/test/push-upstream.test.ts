import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, NestError, type Core } from '../src/index.js';
import './gitEnv.js';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

// realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-push-')));
const repoPath = path.join(tempRoot, 'repo');
const originPath = path.join(tempRoot, 'origin.git');
let core: Core | null = null;
let projectId = '';
let mainSha = '';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })
    .replace(/\r\n/g, '\n')
    .trim();
}

function gitOrNull(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function makeRepo(name: string): string {
  const repo = path.join(tempRoot, name);
  mkdirSync(repo, { recursive: true });
  git(['init', '-b', 'main'], repo);
  git(['config', 'user.name', 'Nest'], repo);
  git(['config', 'user.email', 'nest@example.com'], repo);
  writeFileSync(path.join(repo, 'README.md'), `# ${name}\n`, 'utf8');
  git(['add', '.'], repo);
  git(['commit', '-m', 'init'], repo);
  return repo;
}

async function commitIn(workspacePath: string, name: string, content: string): Promise<string> {
  writeFileSync(path.join(workspacePath, name), content, 'utf8');
  git(['add', '--', name], workspacePath);
  git(['commit', '-m', `add ${name}`], workspacePath);
  return git(['rev-parse', 'HEAD'], workspacePath);
}

beforeAll(async () => {
  mkdirSync(repoPath, { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  git(['config', 'user.name', 'Nest'], repoPath);
  git(['config', 'user.email', 'nest@example.com'], repoPath);
  // The settings the audit names: a branch created from a remote-tracking start
  // point would inherit it as upstream, and a plain push would then either
  // refuse (push.default=simple) or update the base branch.
  git(['config', 'branch.autoSetupMerge', 'true'], repoPath);
  git(['config', 'push.default', 'simple'], repoPath);

  writeFileSync(path.join(repoPath, 'README.md'), '# push\n', 'utf8');
  git(['add', '.'], repoPath);
  git(['commit', '-m', 'init'], repoPath);

  git(['init', '--bare', '--initial-branch=main', originPath], tempRoot);
  git(['remote', 'add', 'origin', originPath], repoPath);
  git(['push', '-u', 'origin', 'main'], repoPath);
  mainSha = git(['rev-parse', 'refs/heads/main'], originPath);

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript,
  });
  const { project } = await core.projects.add(repoPath);
  projectId = project.id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('task branch publication', () => {
  it('starts from origin/main without tracking it and publishes on the first push', async () => {
    if (!core) throw new Error('core was not created');

    const task = await core.tasks.create({
      projectId,
      title: 'First push',
      baseBranch: 'origin/main',
      setupScript: null,
    });
    expect(task.branch).toBe('nest/first-push');
    expect(task.baseRef).toBe('origin/main');
    // Base and upstream are separate concepts: starting at origin/main must not
    // make origin/main this branch's upstream.
    expect(
      gitOrNull(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], task.workspacePath),
    ).toBeNull();

    const head = await commitIn(task.workspacePath, 'work.txt', 'task work\n');
    await core.git.push(task.id);

    expect(git(['rev-parse', 'refs/heads/nest/first-push'], originPath)).toBe(head);
    // The base branch on the remote was never touched.
    expect(git(['rev-parse', 'refs/heads/main'], originPath)).toBe(mainSha);

    const status = await core.git.status(task.id);
    expect(status.upstream).toBe('origin/nest/first-push');
    expect(status.ahead).toBe(0);

    // A second push goes through the branch's own upstream.
    const again = await core.git.push(task.id);
    expect(again.output).not.toBe('');
    expect(git(['rev-parse', 'refs/heads/main'], originPath)).toBe(mainSha);
  });

  it('reports a foreign upstream and publishes only when asked to', async () => {
    if (!core) throw new Error('core was not created');

    const task = await core.tasks.create({
      projectId,
      title: 'Legacy upstream',
      setupScript: null,
    });
    // Simulates a task created before --no-track: the branch tracks its base.
    git(['branch', '--set-upstream-to=origin/main', task.branch], task.workspacePath);
    const head = await commitIn(task.workspacePath, 'legacy.txt', 'legacy\n');

    const failure = await core.git.push(task.id).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(NestError);
    const mismatch = failure as NestError;
    expect(mismatch).toMatchObject({ code: 'upstream_mismatch' });
    expect(mismatch.message).toContain(task.branch);
    expect(mismatch.message).toContain('origin/main');
    expect(mismatch.details).toContain(`push -u origin ${task.branch}`);
    // Nothing was published and the base is still where it was.
    expect(
      gitOrNull(['rev-parse', '--verify', `refs/heads/${task.branch}`], originPath),
    ).toBeNull();
    expect(git(['rev-parse', 'refs/heads/main'], originPath)).toBe(mainSha);

    const published = await core.git.push(task.id, { publish: true });
    expect(published.output.length).toBeGreaterThan(0);
    expect(git(['rev-parse', `refs/heads/${task.branch}`], originPath)).toBe(head);
    expect(git(['rev-parse', 'refs/heads/main'], originPath)).toBe(mainSha);
    expect((await core.git.status(task.id)).upstream).toBe(`origin/${task.branch}`);
  });

  it('reports a repository without remotes instead of failing in git', async () => {
    if (!core) throw new Error('core was not created');

    const { project } = await core.projects.add(makeRepo('solo'));
    const task = await core.tasks.create({
      projectId: project.id,
      title: 'No remote',
      setupScript: null,
    });
    await expect(core.git.push(task.id)).rejects.toMatchObject({ code: 'no_remotes' });
  });
});
