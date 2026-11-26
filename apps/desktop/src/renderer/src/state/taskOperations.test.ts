import { describe, expect, it } from 'vitest';
import {
  applyOperationProgress,
  operationsForProject,
  settleOperation,
  startOperation,
  type TaskOperation,
} from './taskOperations';

const operation: TaskOperation = {
  operationId: 'op-1',
  projectId: 'p-1',
  title: 'Audit workflow',
  step: null,
};

describe('task operations', () => {
  it('starts a pending row before the first progress event', () => {
    expect(startOperation([], operation)).toEqual([operation]);
  });

  it('replaces a repeated id instead of listing it twice', () => {
    const started = startOperation([], operation);
    expect(startOperation(started, { ...operation, title: 'Newer' })).toEqual([
      { ...operation, title: 'Newer' },
    ]);
  });

  it('updates the step of the matching operation only', () => {
    const other = { ...operation, operationId: 'op-2' };
    const started = startOperation(startOperation([], operation), other);
    const next = applyOperationProgress(started, { operationId: 'op-2', step: 'worktree' });
    expect(next[0]?.step).toBeNull();
    expect(next[1]?.step).toBe('worktree');
  });

  it('ignores progress for an operation it does not know', () => {
    const started = startOperation([], operation);
    expect(applyOperationProgress(started, { operationId: 'op-x', step: 'fetch' })).toBe(started);
  });

  it('drops the pending row when the operation settles', () => {
    const started = startOperation([], operation);
    expect(settleOperation(started, 'op-1')).toEqual([]);
    // Nothing to remove: the same array comes back, so React does not re-render.
    expect(settleOperation(started, 'op-x')).toBe(started);
  });

  it('lists pending rows per project', () => {
    const started = startOperation(startOperation([], operation), {
      ...operation,
      operationId: 'op-2',
      projectId: 'p-2',
    });
    expect(operationsForProject(started, 'p-2')).toEqual([
      { ...operation, operationId: 'op-2', projectId: 'p-2' },
    ]);
  });
});
