import path from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import type { FileContent, WorkspaceFile, WorkspaceFiles } from '@nest/shared';
import { NestError } from '../errors.js';
import { git, gitOrNull } from '../git/exec.js';
import { assertRef } from '../git/refs.js';
import type { TaskService } from './tasks.js';

/** A huge workspace (generated code, vendored deps) should not freeze the panel. */
const MAX_FILES = 5000;
const LIST_TIMEOUT_MS = 20_000;
/** The preview is read-only, so a cap keeps a stray huge file from stalling the UI. */
const MAX_PREVIEW_BYTES = 512 * 1024;
const BINARY_CHECK_BYTES = 8000;

export class FilesService {
  constructor(private readonly tasks: TaskService) {}

  /**
   * Files of the task workspace: tracked files plus untracked files that are
   * not ignored. `git ls-files` already applies `.gitignore`, so a build
   * output directory never reaches the panel.
   */
  async list(taskId: string, ref?: string): Promise<WorkspaceFiles> {
    const task = this.tasks.get(taskId);
    // With a revision the tree comes from the object database, so a branch that
    // is checked out elsewhere (or not at all) can be browsed without a checkout.
    const revision = ref ? await assertRevision(task.workspacePath, ref) : null;
    const { stdout } = revision
      ? await git(task.workspacePath, ['ls-tree', '-r', '-z', '--name-only', revision, '--'], {
          timeout: LIST_TIMEOUT_MS,
        })
      : await git(
          task.workspacePath,
          ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
          { timeout: LIST_TIMEOUT_MS },
        );

    const files: WorkspaceFile[] = [];
    for (const raw of stdout.split('\0')) {
      if (!raw) continue;
      files.push({ path: raw.replace(/\\/g, '/') });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const truncated = files.length > MAX_FILES;
    return { files: truncated ? files.slice(0, MAX_FILES) : files, truncated };
  }

  /** UTF-8 preview of one workspace file; binary files return an empty text. */
  async read(taskId: string, filePath: string, ref?: string): Promise<FileContent> {
    const task = this.tasks.get(taskId);
    if (ref) return readRevisionFile(task.workspacePath, filePath, ref);

    const root = path.resolve(task.workspacePath);
    const target = path.resolve(root, filePath);
    if (
      path.isAbsolute(filePath) ||
      (target !== root && !target.startsWith(`${root}${path.sep}`))
    ) {
      throw new NestError('invalid_path', `Path is outside the workspace: ${filePath}`);
    }

    const handle = await openFile(target, filePath);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new NestError('not_a_file', `${filePath} is not a file`);
      }

      const length = Math.min(stat.size, MAX_PREVIEW_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      const binary = bytes.subarray(0, BINARY_CHECK_BYTES).includes(0);

      return {
        path: filePath,
        size: stat.size,
        text: binary ? '' : bytes.toString('utf8'),
        binary,
        truncated: stat.size > bytesRead,
      };
    } finally {
      await handle.close();
    }
  }
}

/**
 * Path inside a revision: relative, no empty segment and no `..`, so the
 * `<rev>:<path>` expression can never name an object outside the tree.
 */
function assertRevisionPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const invalid =
    normalized.length === 0 ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
  if (invalid) throw new NestError('invalid_path', `Invalid file path: ${filePath}`);
  return normalized;
}

async function assertRevision(cwd: string, ref: string): Promise<string> {
  const revision = assertRef(ref, 'revision');
  if (!(await gitOrNull(cwd, ['rev-parse', '--verify', '-q', revision]))) {
    throw new NestError('ref_missing', `Unknown revision: ${revision}`);
  }
  return revision;
}

/**
 * A file of a revision, read from Git objects only: the worktree is never
 * touched and the file does not have to exist on disk at all.
 */
async function readRevisionFile(cwd: string, filePath: string, ref: string): Promise<FileContent> {
  const revision = await assertRevision(cwd, ref);
  const target = `${revision}:${assertRevisionPath(filePath)}`;

  // `cat-file -t` tells a missing path, a directory and a blob apart in one trip.
  const type = await gitOrNull(cwd, ['cat-file', '-t', target]);
  if (!type) throw new NestError('file_missing', `${filePath} was not found`);
  if (type !== 'blob') throw new NestError('not_a_file', `${filePath} is not a file`);

  const [{ stdout: sizeRaw }, { stdout }] = await Promise.all([
    git(cwd, ['cat-file', '-s', target], { timeout: LIST_TIMEOUT_MS }),
    git(cwd, ['show', target], { timeout: LIST_TIMEOUT_MS }),
  ]);
  const objectSize = Number(sizeRaw.trim());
  const bytes = Buffer.from(stdout, 'utf8');
  const preview = bytes.length > MAX_PREVIEW_BYTES ? bytes.subarray(0, MAX_PREVIEW_BYTES) : bytes;
  const binary = preview.subarray(0, BINARY_CHECK_BYTES).includes(0);
  const size = Number.isFinite(objectSize) ? objectSize : bytes.length;

  return {
    path: filePath,
    size,
    text: binary ? '' : preview.toString('utf8'),
    binary,
    truncated: size > preview.length,
  };
}

async function openFile(target: string, filePath: string): Promise<FileHandle> {
  try {
    return await open(target, 'r');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new NestError('file_missing', `${filePath} was not found`);
    }
    throw new NestError('file_unreadable', `Cannot read ${filePath}`);
  }
}
