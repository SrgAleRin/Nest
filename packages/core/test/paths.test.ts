import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NestError } from '../src/errors.js';
import {
  PATH_OUTSIDE_WORKSPACE,
  assertInsidePhysics,
  isInside,
  isSafeRelativePath,
  physicalPath,
  resolveInsideWorkspace,
} from '../src/paths.js';

// realpath expands Windows 8.3 names (RUNNER~1) so the expected physical
// paths match what the module resolves.
const tempRoot = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-paths-')));

/** The registered workspace. */
const workspace = path.join(tempRoot, 'repo');
/** A sibling whose name only shares the workspace prefix: `repo` vs `repo-evil`. */
const sibling = path.join(tempRoot, 'repo-evil');

mkdirSync(path.join(workspace, 'src'), { recursive: true });
mkdirSync(sibling, { recursive: true });
writeFileSync(path.join(workspace, 'src', 'notes.txt'), 'alpha\nbeta\n', 'utf8');
writeFileSync(path.join(sibling, 'secret.txt'), 'outside the workspace\n', 'utf8');

/**
 * Creates a directory link inside the workspace. POSIX uses a symlink; Windows
 * uses a junction because a file symlink needs administrator rights or
 * Developer Mode there, while a junction needs none and is the same escape
 * vector. Returns false when the platform cannot create the link at all.
 */
function linkDirectory(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

const escapingLink = path.join(workspace, 'escape');
const insideLink = path.join(workspace, 'inside');
const hasEscapingLink = linkDirectory(sibling, escapingLink);
const hasInsideLink = linkDirectory(path.join(workspace, 'src'), insideLink);

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('isSafeRelativePath', () => {
  it('accepts nested relative paths', () => {
    expect(isSafeRelativePath('src/notes.txt')).toBe(true);
    expect(isSafeRelativePath('..notes.txt')).toBe(true);
  });

  it('rejects absolute paths and parent segments', () => {
    expect(isSafeRelativePath('')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath(path.join(tempRoot, 'secret.txt'))).toBe(false);
    expect(isSafeRelativePath('../secret.txt')).toBe(false);
    expect(isSafeRelativePath('src/../../secret.txt')).toBe(false);
    expect(isSafeRelativePath('src\\..\\..\\secret.txt')).toBe(false);
  });
});

describe('isInside', () => {
  it('accepts the root itself and its descendants', () => {
    expect(isInside(workspace, workspace)).toBe(true);
    expect(isInside(workspace, path.join(workspace, 'src', 'notes.txt'))).toBe(true);
  });

  it('rejects a sibling directory that only shares the name prefix', () => {
    expect(isInside(workspace, path.join(sibling, 'secret.txt'))).toBe(false);
    expect(isInside(workspace, tempRoot)).toBe(false);
  });
});

describe('physicalPath', () => {
  it('resolves a name that does not exist yet through its real parent', async () => {
    expect(await physicalPath(path.join(workspace, 'src', 'new.txt'))).toBe(
      path.join(workspace, 'src', 'new.txt'),
    );
  });

  it('follows a directory link', async () => {
    if (!hasEscapingLink) {
      // Nothing to assert where the platform refuses to create the link.
      return;
    }
    expect(await physicalPath(escapingLink)).toBe(sibling);
  });
});

describe('resolveInsideWorkspace', () => {
  it('returns the physical path of a workspace file', async () => {
    expect(await resolveInsideWorkspace(workspace, 'src/notes.txt')).toBe(
      path.join(workspace, 'src', 'notes.txt'),
    );
  });

  it('refuses a lexical escape with invalid_path', async () => {
    await expect(
      resolveInsideWorkspace(workspace, '../repo-evil/secret.txt'),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('refuses a link that resolves outside the workspace', async (context) => {
    if (!hasEscapingLink) {
      context.skip();
      return;
    }
    // Both a symlink escape and a sibling-prefix collision: the physical path
    // is `<temp>/repo-evil/secret.txt`, which only differs from the workspace
    // by the suffix of its name.
    await expect(resolveInsideWorkspace(workspace, 'escape/secret.txt')).rejects.toMatchObject({
      code: PATH_OUTSIDE_WORKSPACE,
    });
    await expect(resolveInsideWorkspace(workspace, 'escape/secret.txt')).rejects.toBeInstanceOf(
      NestError,
    );
  });

  it('refuses a file that does not exist under a link that points outside', async (context) => {
    if (!hasEscapingLink) {
      context.skip();
      return;
    }
    await expect(
      resolveInsideWorkspace(workspace, 'escape/not-created-yet.txt'),
    ).rejects.toMatchObject({ code: PATH_OUTSIDE_WORKSPACE });
  });

  it('allows a link that points back inside the workspace', async (context) => {
    if (!hasInsideLink) {
      context.skip();
      return;
    }
    const resolved = await resolveInsideWorkspace(workspace, 'inside/notes.txt');
    expect(resolved).toBe(path.join(workspace, 'src', 'notes.txt'));
  });
});

describe('assertInsidePhysics', () => {
  it('returns the physical path for a file that does not exist yet', async () => {
    const target = path.join(workspace, 'src', 'later.env');
    expect(await assertInsidePhysics(workspace, target, '.env')).toBe(target);
  });

  it('names the refused file in the error', async (context) => {
    if (!hasEscapingLink) {
      context.skip();
      return;
    }
    await expect(
      assertInsidePhysics(workspace, path.join(escapingLink, 'secret.txt'), '.env'),
    ).rejects.toThrow(/Refusing \.env/);
  });
});
