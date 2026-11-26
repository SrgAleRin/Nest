import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PATH_OUTSIDE_WORKSPACE } from '../src/paths.js';
import { copyEnvFiles, prepareWorkspace } from '../src/services/setup.js';

const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-setup-')));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** A project and a worktree, both empty. */
function makePair(): { project: string; workspace: string } {
  const project = path.join(tempRoot, `project-${Math.random().toString(36).slice(2)}`);
  const workspace = path.join(tempRoot, `workspace-${Math.random().toString(36).slice(2)}`);
  mkdirSync(project, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { project, workspace };
}

/**
 * A file symlink needs administrator rights or Developer Mode on Windows, so
 * the escape case is skipped where the platform refuses to create one. The
 * same boundary is covered with a directory link (a junction) in
 * `paths.test.ts`, which any platform can create.
 */
function linkFile(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, 'file');
    return true;
  } catch {
    return false;
  }
}

/** A directory link: a symlink on POSIX, a junction on Windows (no privileges needed). */
function linkDirectory(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('copyEnvFiles', () => {
  it('copies .env into the worktree', async () => {
    const { project, workspace } = makePair();
    writeFileSync(path.join(project, '.env'), 'TOKEN=dev\n', 'utf8');

    expect(await copyEnvFiles(project, workspace)).toEqual(['.env']);
    expect(readFileSync(path.join(workspace, '.env'), 'utf8')).toBe('TOKEN=dev\n');
  });

  it('keeps an existing worktree .env', async () => {
    const { project, workspace } = makePair();
    writeFileSync(path.join(project, '.env'), 'FROM_PROJECT=1\n', 'utf8');
    writeFileSync(path.join(workspace, '.env'), 'FROM_WORKTREE=1\n', 'utf8');

    expect(await copyEnvFiles(project, workspace)).toEqual([]);
    expect(readFileSync(path.join(workspace, '.env'), 'utf8')).toBe('FROM_WORKTREE=1\n');
  });

  it('copies a .env link that points inside the project', async (context) => {
    const { project, workspace } = makePair();
    writeFileSync(path.join(project, 'secrets.env'), 'TOKEN=linked\n', 'utf8');
    if (!linkFile(path.join(project, 'secrets.env'), path.join(project, '.env'))) {
      context.skip();
      return;
    }

    expect(await copyEnvFiles(project, workspace)).toEqual(['.env']);
    expect(readFileSync(path.join(workspace, '.env'), 'utf8')).toBe('TOKEN=linked\n');
  });

  it('refuses a .env link that leaves the project', async (context) => {
    const { project, workspace } = makePair();
    const outside = path.join(tempRoot, 'outside.env');
    writeFileSync(outside, 'TOKEN=leaked\n', 'utf8');
    if (!linkFile(outside, path.join(project, '.env'))) {
      context.skip();
      return;
    }

    await expect(copyEnvFiles(project, workspace)).rejects.toMatchObject({
      code: PATH_OUTSIDE_WORKSPACE,
    });
    expect(existsSync(path.join(workspace, '.env'))).toBe(false);
  });

  it('refuses a .env link to a directory outside the project', async (context) => {
    const { project, workspace } = makePair();
    const outside = path.join(tempRoot, 'outside-dir');
    mkdirSync(outside, { recursive: true });
    if (!linkDirectory(outside, path.join(project, '.env'))) {
      context.skip();
      return;
    }

    await expect(copyEnvFiles(project, workspace)).rejects.toMatchObject({
      code: PATH_OUTSIDE_WORKSPACE,
    });
    expect(existsSync(path.join(workspace, '.env'))).toBe(false);
  });

  it('reports the refusal through prepareWorkspace', async (context) => {
    const { project, workspace } = makePair();
    const outside = path.join(tempRoot, 'outside-dir-local');
    mkdirSync(outside, { recursive: true });
    if (!linkDirectory(outside, path.join(project, '.env.local'))) {
      context.skip();
      return;
    }

    const error = await prepareWorkspace({
      projectPath: project,
      workspacePath: workspace,
      setupScript: null,
      copyEnvFiles: true,
    });
    expect(error).toContain('could not copy env files');
    expect(error).toContain('outside the workspace');
    expect(existsSync(path.join(workspace, '.env.local'))).toBe(false);
  });

  it('copies nothing when the setting is off, even for a link that escapes', async (context) => {
    const { project, workspace } = makePair();
    writeFileSync(path.join(project, '.env'), 'TOKEN=dev\n', 'utf8');
    const outside = path.join(tempRoot, 'outside-dir-off');
    mkdirSync(outside, { recursive: true });
    if (!linkDirectory(outside, path.join(project, '.env.local'))) {
      context.skip();
      return;
    }

    const error = await prepareWorkspace({
      projectPath: project,
      workspacePath: workspace,
      setupScript: null,
      copyEnvFiles: false,
    });

    expect(error).toBeNull();
    expect(existsSync(path.join(workspace, '.env'))).toBe(false);
    expect(existsSync(path.join(workspace, '.env.local'))).toBe(false);
  });
});
