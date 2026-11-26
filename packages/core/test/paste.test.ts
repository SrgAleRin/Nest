import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, nowIso } from '@nest/shared';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { HarnessDiscovery } from '../src/harness/discovery.js';
import { buildPaste } from '../src/harness/paste.js';
import { HarnessRegistry } from '../src/harness/registry.js';
import { ProjectService } from '../src/services/projects.js';
import { SessionService, type PtyProcess } from '../src/services/sessions.js';
import { TaskService } from '../src/services/tasks.js';

/**
 * Multi-line input. Bracketed paste keeps a review note as one input; profiles
 * that do not understand `CSI 200~` get plain submitted lines instead.
 */

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);
const NOTE = 'Review comment — src/a.ts:3 (new)\n\nShould this be guarded?\n';

class FakePty implements PtyProcess {
  readonly written: string[] = [];
  onData(): void {}
  onExit(): void {}
  write(data: string): void {
    this.written.push(data);
  }
  resize(): void {}
  kill(): void {}
}

interface Fixture {
  db: Db;
  sessions: SessionService;
  taskId: string;
  ptys: FakePty[];
  close(): void;
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function createFixture(): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nest-paste-'));
  const db = openDatabase(path.join(root, 'nest.db'));
  migrate(db);

  const workspace = path.join(root, 'repo');
  mkdirSync(workspace, { recursive: true });

  const projectId = newId();
  const taskId = newId();
  const timestamp = nowIso();
  db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
    projectId,
    'repo',
    workspace,
    timestamp,
  );
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, kind, slug, title, branch, workspace_path, status, created_at, updated_at)
     VALUES (?, ?, 'checkout', '@main', 'repo', 'main', ?, 'active', ?, ?)`,
  ).run(taskId, projectId, workspace, timestamp, timestamp);

  const projects = new ProjectService(db);
  const tasks = new TaskService(db, projects, path.join(root, 'worktrees'));
  const harnesses = new HarnessRegistry({
    fakeHarnessScript,
    // The custom profile is the "unknown CLI" case: no bracketed paste.
    customCommand: process.env.NEST_NODE ?? 'node',
  });
  const ptys: FakePty[] = [];
  const sessions = new SessionService(
    db,
    tasks,
    harnesses,
    new HarnessDiscovery({ homeDir: root, env: {}, run: async () => '' }),
    () => {},
    {
      snapshotIntervalMs: 0,
      spawnPty: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return pty;
      },
    },
  );

  const fixture: Fixture = {
    db,
    sessions,
    taskId,
    ptys,
    close: () => {
      fixture.sessions.shutdownAll();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
  cleanup.push(() => fixture.close());
  return fixture;
}

describe('multi-line paste', () => {
  it('wraps a block in bracketed paste and submits it once', () => {
    expect(buildPaste(NOTE, 'bracketed-paste')).toBe(`\x1b[200~${NOTE}\x1b[201~\r`);
    // CRLF and a stray paste terminator inside the note cannot split it.
    expect(buildPaste('a\r\nb\x1b[201~c', 'bracketed-paste')).toBe(
      '\x1b[200~a\nbc\x1b[201~\r',
    );
  });

  it('falls back to plain submitted lines without escape sequences', () => {
    expect(buildPaste('one\ntwo\n', 'line')).toBe('one\rtwo\r');
    // Blank lines would submit an empty input, so they are dropped.
    expect(buildPaste('one\n\ntwo\nthree', 'line')).toBe('one\rtwo\rthree\r');
  });

  it('picks the paste mode of the registered profile', () => {
    const harnesses = new HarnessRegistry({
      fakeHarnessScript,
      customCommand: process.env.NEST_NODE ?? 'node',
    });
    expect(harnesses.inputMode('fake')).toBe('bracketed-paste');
    expect(harnesses.inputMode('claude')).toBe('bracketed-paste');
    expect(harnesses.inputMode('codex')).toBe('bracketed-paste');
    // No confirmed bracketed-paste handling: plain lines.
    expect(harnesses.inputMode('shell')).toBe('line');
    expect(harnesses.inputMode('dsh')).toBe('line');
    expect(harnesses.inputMode('custom')).toBe('line');
    // A stored session whose profile is gone: generic ids keep plain lines,
    // anything else keeps the common case.
    expect(harnesses.inputMode('custom')).toBe('line');
    expect(harnesses.inputMode('gone')).toBe('bracketed-paste');
  });

  it('writes the documented bytes for a bracketed-paste harness', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'fake' });
    fixture.sessions.writeText(session.id, NOTE);

    expect(fixture.ptys[0]?.written).toEqual([`\x1b[200~${NOTE}\x1b[201~\r`]);
  });

  it('writes the fallback bytes for a harness without bracketed paste', async () => {
    const fixture = createFixture();
    const session = await fixture.sessions.start({ taskId: fixture.taskId, harnessId: 'custom' });
    fixture.sessions.writeText(session.id, NOTE);

    expect(fixture.ptys[0]?.written.join('')).toBe(
      'Review comment — src/a.ts:3 (new)\rShould this be guarded?\r',
    );
    expect(fixture.ptys[0]?.written.join('')).not.toContain('\x1b[200~');
  });
});
