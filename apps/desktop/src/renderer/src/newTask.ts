import type {
  HarnessProfile,
  NewSessionDefault,
  TaskPreview,
  TaskProgressStep,
} from '@nest/shared';

/** Shown in the dialog footer and in the pending row of the tree. */
export const STEP_LABELS: Record<TaskProgressStep, string> = {
  fetch: 'Fetching remotes…',
  worktree: 'Creating worktree…',
  setup: 'Copying env and running setup…',
};

/**
 * Profile the dialog preselects. `ask` shows the first *available* profile
 * instead of an empty list, and a specific default that is hidden or missing on
 * this machine falls back the same way.
 */
export function defaultHarnessId(
  harnesses: HarnessProfile[],
  preference: NewSessionDefault,
): string | null {
  const available = harnesses.filter((harness) => harness.available);
  if (preference !== 'ask') {
    const chosen = available.find((harness) => harness.id === preference);
    if (chosen) return chosen.id;
  }
  return (available[0] ?? harnesses[0])?.id ?? null;
}

const BASE_SOURCE_LABELS: Record<TaskPreview['baseSource'], string> = {
  explicit: 'from this dialog',
  project: 'project default',
  current: 'current branch (no project default)',
};

/** `origin/main · project default`, or a dash while nothing is known yet. */
export function baseRefLabel(preview: TaskPreview | null): string {
  if (!preview?.baseRef) return '—';
  return `${preview.baseRef} · ${BASE_SOURCE_LABELS[preview.baseSource]}`;
}

/**
 * Why the worktree cannot be created yet, or null when it can. The dialog
 * disables both submit buttons while this returns a message.
 */
export function blockedReason(
  preview: TaskPreview | null,
  previewError: string | null,
  title: string,
): string | null {
  if (title.trim().length === 0) return 'Give the task a title first';
  if (previewError) return previewError;
  if (!preview) return null;
  if (!preview.baseRef) return 'No base branch: check out a branch in the project first';
  if (!preview.baseAvailable) return `Base branch ${preview.baseRef} does not exist`;
  return null;
}

/**
 * Focus rule of the dialog: the new task is selected only when the user has not
 * changed the selected task since submitting. Otherwise their current task
 * stays where it is.
 */
export function taskToSelect(
  selectedNow: string | null,
  selectedAtSubmit: string | null,
  newTaskId: string,
): string {
  return selectedNow === selectedAtSubmit ? newTaskId : (selectedNow ?? newTaskId);
}

/**
 * A task whose worktree was created but whose harness did not start. The retry
 * reuses the task: creating a second worktree for the same attempt is exactly
 * what this state exists to prevent.
 */
export interface StartFailure {
  harnessId: string;
  message: string;
}

/** `Claude Code did not start: …`, addressed to the user. */
export function startFailureMessage(harnessId: string, reason: string): string {
  return `${harnessId} did not start: ${reason}`;
}
