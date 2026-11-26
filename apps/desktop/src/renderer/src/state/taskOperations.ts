import type { TaskProgressStep } from '@nest/shared';

/**
 * Creations the renderer is waiting for, addressed by the operation id it sent
 * to `tasks.create`. Keeping them in app state, not in the dialog, is what makes
 * progress visible in the tree while the modal is closed and what lets a cancel
 * reach core for an operation whose promise is still pending.
 */
export interface TaskOperation {
  operationId: string;
  projectId: string;
  /** Title the row in the tree shows while the task does not exist yet. */
  title: string;
  /** Last reported step; null right after submitting. */
  step: TaskProgressStep | null;
}

export type TaskOperations = TaskOperation[];

export function startOperation(
  operations: TaskOperations,
  operation: TaskOperation,
): TaskOperations {
  return [...operations.filter((item) => item.operationId !== operation.operationId), operation];
}

export function applyOperationProgress(
  operations: TaskOperations,
  progress: { operationId: string; step: TaskProgressStep },
): TaskOperations {
  let changed = false;
  const next = operations.map((operation) => {
    if (operation.operationId !== progress.operationId || operation.step === progress.step) {
      return operation;
    }
    changed = true;
    return { ...operation, step: progress.step };
  });
  return changed ? next : operations;
}

/** The operation settled (done, failed or aborted): its pending row goes away. */
export function settleOperation(operations: TaskOperations, operationId: string): TaskOperations {
  const next = operations.filter((operation) => operation.operationId !== operationId);
  return next.length === operations.length ? operations : next;
}

export function operationsForProject(
  operations: TaskOperations,
  projectId: string,
): TaskOperations {
  return operations.filter((operation) => operation.projectId === projectId);
}
