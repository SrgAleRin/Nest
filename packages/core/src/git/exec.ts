import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { NestError } from '../errors.js';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Kill the child process after this many milliseconds (fetch, push). */
  timeout?: number;
}

export async function git(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<GitResult> {
  // execFile reports a missing working directory as ENOENT, exactly like a
  // missing executable, so check the workspace first for an accurate error.
  if (!existsSync(cwd)) {
    throw new NestError('workspace_missing', `Workspace not found: ${cwd}`);
  }
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      ...(options.timeout ? { timeout: options.timeout } : {}),
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (err.code === 'ENOENT') {
      throw new NestError('git_not_found', 'git is not installed or not on PATH');
    }
    const details = (err.stderr || err.stdout || err.message || '').trim();
    throw new NestError('git_failed', `git ${args.join(' ')} failed`, details);
  }
}

export async function gitOrNull(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string | null> {
  try {
    const result = await git(cwd, args, options);
    return result.stdout.trim();
  } catch {
    return null;
  }
}
