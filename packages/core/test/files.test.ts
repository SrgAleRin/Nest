import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCore, type Core } from '../src/index.js';
import './gitEnv.js';

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-files-'));
const repoPath = path.join(tempRoot, 'repo');
const largeContent = 'x'.repeat(600 * 1024);
let core: Core | null = null;
let taskId = '';

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

beforeAll(async () => {
  mkdirSync(path.join(repoPath, 'src'), { recursive: true });
  git(['init', '-b', 'main'], repoPath);
  writeFileSync(path.join(repoPath, '.gitignore'), 'ignored.txt\n', 'utf8');
  writeFileSync(path.join(repoPath, 'README.md'), '# files\n', 'utf8');
  writeFileSync(path.join(repoPath, 'src', 'app.ts'), 'export const answer = 42;\n', 'utf8');
  writeFileSync(path.join(repoPath, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));
  writeFileSync(path.join(repoPath, 'large.txt'), largeContent, 'utf8');
  git(['add', '.'], repoPath);
  git(
    ['-c', 'user.name=Nest', '-c', 'user.email=nest@example.com', 'commit', '-m', 'init'],
    repoPath,
  );

  // Untracked but not ignored: it belongs in the list. Ignored files do not.
  writeFileSync(path.join(repoPath, 'notes.md'), '# notes\n', 'utf8');
  writeFileSync(path.join(repoPath, 'ignored.txt'), 'nope\n', 'utf8');
  writeFileSync(path.join(tempRoot, 'outside.txt'), 'outside\n', 'utf8');

  core = createCore({
    dbPath: path.join(tempRoot, 'nest.db'),
    worktreesRoot: path.join(tempRoot, 'worktrees'),
    fakeHarnessScript: path.join(tempRoot, 'missing-harness.mjs'),
  });
  const { project } = await core.projects.add(repoPath);
  taskId = core.tasks.ensureCheckout(project.id).id;
});

afterAll(() => {
  core?.close();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('workspace files', () => {
  it('lists tracked and untracked files, skipping ignored ones', async () => {
    const result = await core!.files.list(taskId);
    const paths = result.files.map((file) => file.path);

    expect(paths).toEqual(
      expect.arrayContaining(['.gitignore', 'README.md', 'notes.md', 'src/app.ts']),
    );
    expect(paths).not.toContain('ignored.txt');
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(result.truncated).toBe(false);
  });

  it('reads a text file with its size', async () => {
    const content = await core!.files.read(taskId, 'src/app.ts');

    expect(content).toMatchObject({ path: 'src/app.ts', binary: false, truncated: false });
    expect(content.text).toBe('export const answer = 42;\n');
    expect(content.size).toBe(Buffer.byteLength(content.text));
  });

  it('marks binary files and does not return their bytes as text', async () => {
    const content = await core!.files.read(taskId, 'blob.bin');

    expect(content).toMatchObject({ binary: true, text: '', truncated: false });
    expect(content.size).toBe(5);
  });

  it('truncates a large preview but reports the full size', async () => {
    const content = await core!.files.read(taskId, 'large.txt');

    expect(content.truncated).toBe(true);
    expect(content.size).toBe(largeContent.length);
    expect(content.text.length).toBeLessThan(content.size);
  });

  it('rejects paths outside the workspace', async () => {
    await expect(core!.files.read(taskId, '../outside.txt')).rejects.toMatchObject({
      code: 'invalid_path',
    });
    await expect(
      core!.files.read(taskId, path.join(tempRoot, 'outside.txt')),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('reports missing files and directories', async () => {
    await expect(core!.files.read(taskId, 'missing.txt')).rejects.toMatchObject({
      code: 'file_missing',
    });
    await expect(core!.files.read(taskId, 'src')).rejects.toMatchObject({ code: 'not_a_file' });
  });
});
