import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { subscribe, type AsyncSubscription } from '@parcel/watcher';
import type { NestEvent, Task } from '@nest/shared';

const execFileAsync = promisify(execFile);

/** File events arrive in bursts; one refresh per burst is enough. */
const DEBOUNCE_MS = 350;

/**
 * The workspace watch only reports working-tree files: git bookkeeping lives in
 * the repository's git dir, which is watched separately (some of it shared by
 * every worktree of the project).
 */
const WORKSPACE_IGNORE = ['**/node_modules/**', '**/.git/**'];

/** Object and log churn does not change what the UI shows. */
const GIT_DIR_IGNORE = ['**/objects/**', '**/logs/**', '**/lfs/**', '**/*.lock'];

interface Target {
  dir: string;
  taskIds: string[];
  subscription: AsyncSubscription | null;
}

interface DesiredTarget {
  dir: string;
  taskIds: string[];
}

/**
 * Watches task workspaces and their repositories, emitting `git:changed` when
 * something on disk moves. git itself stays the source of truth: an event only
 * tells the renderer to re-read status and diff.
 */
export class WorkspaceWatcher {
  private readonly targets = new Map<string, Target>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly gitDirs = new Map<string, Promise<string | null>>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly emit: (event: NestEvent) => void) {}

  /** Reconciles the watched set with the current tasks; safe to call often. */
  sync(tasks: Task[]): Promise<void> {
    this.pending = this.pending.then(() => this.reconcile(tasks)).catch(() => {});
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const targets = [...this.targets.values()];
    this.targets.clear();
    await Promise.all(targets.map((target) => target.subscription?.unsubscribe().catch(() => {})));
  }

  private async reconcile(tasks: Task[]): Promise<void> {
    if (this.closed) return;

    const desired = new Map<string, DesiredTarget>();
    for (const task of tasks) {
      desired.set(`workspace:${task.id}`, {
        dir: task.workspacePath,
        taskIds: [task.id],
      });
    }

    // One watch on the shared git dir covers the checkout and every linked
    // worktree: refs, HEAD and each worktree's index all live below it.
    const byProject = new Map<string, Task[]>();
    for (const task of tasks) {
      const list = byProject.get(task.projectId) ?? [];
      list.push(task);
      byProject.set(task.projectId, list);
    }
    await Promise.all(
      [...byProject].map(async ([projectId, projectTasks]) => {
        const repoPath = projectTasks.find((task) => task.kind === 'checkout')?.workspacePath;
        if (!repoPath) return;
        const gitDir = await this.gitDirFor(repoPath);
        if (!gitDir) return;
        desired.set(`git:${projectId}`, {
          dir: gitDir,
          taskIds: projectTasks.map((task) => task.id),
        });
      }),
    );

    for (const [key, target] of [...this.targets]) {
      const next = desired.get(key);
      if (next && next.dir === target.dir) {
        target.taskIds = next.taskIds;
        desired.delete(key);
        continue;
      }
      this.targets.delete(key);
      await target.subscription?.unsubscribe().catch(() => {});
    }

    for (const [key, target] of desired) {
      if (this.closed) return;
      const isGitDir = key.startsWith('git:');
      const entry: Target = { dir: target.dir, taskIds: target.taskIds, subscription: null };
      let subscription: AsyncSubscription;
      try {
        subscription = await subscribe(
          target.dir,
          (error, events) => {
            if (error || this.closed || events.length === 0) return;
            for (const taskId of entry.taskIds) this.schedule(taskId);
          },
          { ignore: isGitDir ? GIT_DIR_IGNORE : WORKSPACE_IGNORE },
        );
      } catch {
        // A worktree can be removed between listing and watching; the next
        // sync drops it (or retries once its directory exists again).
        continue;
      }
      if (this.closed) {
        await subscription.unsubscribe().catch(() => {});
        return;
      }
      entry.subscription = subscription;
      this.targets.set(key, entry);
    }
  }

  private schedule(taskId: string): void {
    const existing = this.timers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(taskId);
      this.emit({ type: 'git:changed', taskId });
    }, DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(taskId, timer);
  }

  private gitDirFor(repoPath: string): Promise<string | null> {
    const cached = this.gitDirs.get(repoPath);
    if (cached) return cached;
    const resolved = execFileAsync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    })
      .then((result) => result.stdout.trim() || null)
      .catch(() => null);
    this.gitDirs.set(repoPath, resolved);
    return resolved;
  }
}
