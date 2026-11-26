import path from 'node:path';
import { open, type FileHandle } from 'node:fs/promises';
import type { FileContent, WorkspaceFile, WorkspaceFiles } from '@nest/shared';
import { NestError } from '../errors.js';
import { git } from '../git/exec.js';
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
  async list(taskId: string): Promise<WorkspaceFiles> {
    const task = this.tasks.get(taskId);
    const { stdout } = await git(
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
  async read(taskId: string, filePath: string): Promise<FileContent> {
    const task = this.tasks.get(taskId);
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
