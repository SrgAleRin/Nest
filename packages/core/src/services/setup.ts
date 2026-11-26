import { spawn } from 'node:child_process';
import { copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertInsidePhysics } from '../paths.js';

/** Files copied from the project root into every new worktree. */
export const ENV_FILES = ['.env', '.env.local'] as const;

const OUTPUT_LIMIT = 4_000;
const SETUP_TIMEOUT_MS = 10 * 60_000;

export function normalizeSetupScript(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Prepares a freshly created worktree: copies local env files and runs the
 * project setup script. Returns a human readable error, or null on success.
 * The worktree is never removed here: a failed setup leaves it on disk so the
 * user can inspect it.
 */
export async function prepareWorkspace(input: {
  projectPath: string;
  workspacePath: string;
  setupScript: string | null;
}): Promise<string | null> {
  try {
    await copyEnvFiles(input.projectPath, input.workspacePath);
  } catch (error) {
    return `could not copy env files: ${errorMessage(error)}`;
  }
  if (!input.setupScript) return null;
  return runSetupScript(input.workspacePath, input.setupScript);
}

export async function copyEnvFiles(projectPath: string, workspacePath: string): Promise<string[]> {
  const copied: string[] = [];
  for (const file of ENV_FILES) {
    const source = path.join(projectPath, file);
    const target = path.join(workspacePath, file);
    if (!(await exists(source)) || (await exists(target))) continue;
    // `.env` is often a link (a shared secret file, a per-machine override).
    // Both ends are checked by their physical path, so a link that points
    // outside the project or the worktree is refused instead of followed.
    const physicalSource = await assertInsidePhysics(projectPath, source, file);
    await assertInsidePhysics(workspacePath, target, file);
    await copyFile(physicalSource, target);
    copied.push(file);
  }
  return copied;
}

export function runSetupScript(workspacePath: string, script: string): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const timeout: { id: NodeJS.Timeout | null } = { id: null };

    const finish = (error: string | null): void => {
      if (settled) return;
      settled = true;
      if (timeout.id) clearTimeout(timeout.id);
      resolve(error);
    };

    const child = spawn(script, {
      cwd: workspacePath,
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    timeout.id = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SETUP_TIMEOUT_MS);

    child.on('error', (error) => finish(`setup script failed: ${error.message}`));
    child.on('close', (code) => {
      if (timedOut) {
        finish(`setup script timed out after ${SETUP_TIMEOUT_MS / 60_000} minutes`);
        return;
      }
      if (code === 0) {
        finish(null);
        return;
      }
      const details = output.trim();
      finish(`setup script exited with code ${String(code)}${details ? `: ${details}` : ''}`);
    });
  });
}

async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => null));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
