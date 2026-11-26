import type { GitStatus, Task } from '@nest/shared';

/** A `git.status` answer, tagged with the task it was read for. */
export interface BranchSnapshot {
  taskId: string;
  branch: string;
}

export function branchSnapshot(taskId: string, status: GitStatus): BranchSnapshot {
  return { taskId, branch: status.branch };
}

/**
 * Git is the single source of truth for the branch a workspace is on: the
 * header and the status bar show the same `git.status.branch` the Git panel
 * shows. `task.branch` is only the persisted mirror core keeps in step for the
 * sidebar, the palette and restart, so it is used while the first read is in
 * flight and a snapshot of another task is never applied.
 */
export function branchLabel(task: Task | null, snapshot: BranchSnapshot | null): string | null {
  if (!task) return null;
  if (snapshot && snapshot.taskId === task.id) return snapshot.branch;
  return task.branch;
}
