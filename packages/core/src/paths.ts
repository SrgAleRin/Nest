import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { NestError } from './errors.js';

/**
 * Physical boundary policy for workspace file access.
 *
 * "Inside the project" means the physical path, not the textual one: a lexical
 * `startsWith` check lets a symlink or a Windows junction inside a workspace
 * point anywhere on disk. Everything that reads a workspace file by a
 * renderer-supplied path resolves links first and then checks the boundary.
 */

/** A link inside the workspace resolved to a path outside it. */
export const PATH_OUTSIDE_WORKSPACE = 'path_outside_workspace';

/** Lexical guard: relative, no absolute root, no `..` segment. */
export function isSafeRelativePath(filePath: string): boolean {
  if (!filePath || path.isAbsolute(filePath)) return false;
  return !filePath.split(/[\\/]/).includes('..');
}

/** True when `target` is `root` itself or below it. Both are absolute paths. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Physical path of `target` with symlinks and junctions resolved.
 *
 * A path that does not exist yet is resolved one segment at a time: the
 * deepest existing ancestor is canonicalised and the remaining tail is
 * appended, so a not-yet-created file is still checked against its real parent.
 */
export async function physicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  let current = absolute;
  for (;;) {
    const resolved = await realpath(current).catch(() => null);
    if (resolved) {
      const tail = path.relative(current, absolute);
      return tail ? path.join(resolved, tail) : resolved;
    }
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    current = parent;
  }
}

/**
 * Resolves `target` and refuses it when the physical result leaves `root`.
 * Returns the physical path so callers use the checked path, not the text one.
 */
export async function assertInsidePhysics(
  root: string,
  target: string,
  label = target,
): Promise<string> {
  const [realRoot, realTarget] = await Promise.all([physicalPath(root), physicalPath(target)]);
  if (!isInside(realRoot, realTarget)) {
    throw new NestError(
      PATH_OUTSIDE_WORKSPACE,
      `Refusing ${label}: it resolves outside the workspace (${realTarget})`,
    );
  }
  return realTarget;
}

/** Same check for a path the renderer named relative to the workspace root. */
export async function resolveInsideWorkspace(
  workspacePath: string,
  filePath: string,
): Promise<string> {
  if (!isSafeRelativePath(filePath)) {
    throw new NestError('invalid_path', `Path is outside the workspace: ${filePath}`);
  }
  return assertInsidePhysics(workspacePath, path.resolve(workspacePath, filePath), filePath);
}
