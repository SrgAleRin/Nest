import { STEP_LABELS } from '../../newTask';
import type { TaskOperation } from '../../state/taskOperations';
import { CloseIcon } from '../Icons';

export interface PendingTaskRowProps {
  operation: TaskOperation;
  onAbort: (operationId: string) => void;
}

/** A creation in flight, shown where the task will land once it exists. */
export function PendingTaskRow({ operation, onAbort }: PendingTaskRowProps) {
  return (
    <div className="task-row pending ws-pending-row" data-testid="pending-task">
      <span className="task-spinner" aria-hidden="true" />
      <span className="task-name">{operation.title}</span>
      <span className="task-step">
        {operation.step ? STEP_LABELS[operation.step] : 'Starting…'}
      </span>
      <button
        type="button"
        className="ws-pending-cancel"
        aria-label="Cancel creation"
        title="Cancel creation"
        onClick={() => onAbort(operation.operationId)}
      >
        <CloseIcon size={11} />
      </button>
    </div>
  );
}
