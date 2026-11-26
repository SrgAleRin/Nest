import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NestEvent, Task } from '@nest/shared';
import { migrate, openDatabase, type Db } from '../src/db/database.js';
import { HarnessDiscovery, type DiscoveryResult } from '../src/harness/discovery.js';
import { HarnessRegistry } from '../src/harness/registry.js';
import { ProjectService } from '../src/services/projects.js';
import { SessionService } from '../src/services/sessions.js';
import { TaskService } from '../src/services/tasks.js';
import './gitEnv.js';
import { spawnPipedPty } from './pipedPty.js';

/**
 * Stub harnesses for conversation-identity tests. The scenario lives in the
 * generated script, so each test owns its adapter behaviour:
 *
 * - `print`   — writes its conversation file and prints its id (like a CLI
 *               that announces the session it created);
 * - `silent`  — creates nothing and prints no id;
 * - `delayed` — writes its conversation file 1.2 s after the launch and never
 *               prints the id;
 * - `shared`  — like `print`, but every process reports the same id from
 *               `NEST_TEST_SHARED_ID`, which must never reach two tabs.
 */
type StubMode = 'print' | 'silent' | 'delayed' | 'shared';

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
  delete process.env.NEST_FAKE_SESSION_DIR;
  delete process.env.NEST_TEST_SHARED_ID;
});

interface Fixture {
  root: string;
  repo: string;
  sessionsDir: string;
  db: Db;
  projects: ProjectService;
  tasks: TaskService;
  sessions: SessionService;
  checkout: Task;
  events: NestEvent[];
  stub: string;
}

function stubSource(mode: StubMode): string {
  return `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MODE = ${JSON.stringify(mode)};
const dir = process.env.NEST_FAKE_SESSION_DIR;
const cwd = process.cwd();
const argv = process.argv.slice(2);
const flag = argv.indexOf('--session-id');
let id = flag >= 0 ? argv[flag + 1] : undefined;
const resumed = id ? 'exact' : argv.includes('--continue') ? 'continue' : 'fresh';
const shared = process.env.NEST_TEST_SHARED_ID;
if (!id) id = MODE === 'shared' && shared ? shared : randomUUID();
const reports = MODE === 'print' || MODE === 'shared';

const write = (text) => process.stdout.write(text);

function record() {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, cwd }), 'utf8');
}

write('stub ready (' + resumed + ')' + (reports ? ' session ' + id : '') + '\\r\\n');
if (reports) record();
if (MODE === 'delayed') setTimeout(() => { record(); write('conversation created\\r\\n'); }, 1200);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const line of chunk.split(/\\r?\\n/)) {
    if (line.trim() === 'exit') process.exit(0);
    if (line.trim() !== '') write('echo ' + line.trim() + '\\r\\n');
  }
});
`;
}

async function setup(mode: StubMode): Promise<Fixture> {
  // realpath expands Windows 8.3 names (RUNNER~1) so paths match git output.
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-identity-')));
  const repo = path.join(root, 'repo');
  const sessionsDir = path.join(root, 'fake-sessions');
  const stub = path.join(root, `stub-${mode}.mjs`);
  mkdirSync(repo, { recursive: true });
  writeFileSync(stub, stubSource(mode), 'utf8');
  writeFileSync(path.join(repo, 'README.md'), '# stub repo\n', 'utf8');
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore', windowsHide: true });
  execFileSync('git', ['commit', '-m', 'init'], {
    cwd: repo,
    stdio: 'ignore',
    windowsHide: true,
  });

  process.env.NEST_FAKE_SESSION_DIR = sessionsDir;

  const db = openDatabase(path.join(root, 'nest.db'));
  migrate(db);
  const projects = new ProjectService(db);
  const tasks = new TaskService(db, projects, path.join(root, 'worktrees'), () => {});
  const { checkout } = await projects.add(repo);

  const events: NestEvent[] = [];
  const fixture: Fixture = {
    root,
    repo,
    sessionsDir,
    db,
    projects,
    tasks,
    sessions: createSessions(db, tasks, stub, sessionsDir, events),
    checkout,
    events,
    stub,
  };

  cleanup.push(() => {
    try {
      fixture.sessions.shutdownAll();
    } catch {
      // the database may already be closed
    }
    try {
      db.close();
    } catch {
      // already closed
    }
    rmSync(root, { recursive: true, force: true });
  });
  return fixture;
}

function createSessions(
  db: Db,
  tasks: TaskService,
  stub: string,
  sessionsDir: string,
  events: NestEvent[],
  discovery?: HarnessDiscovery,
): SessionService {
  const harnesses = new HarnessRegistry({ fakeHarnessScript: stub });
  const resolved =
    discovery ??
    new HarnessDiscovery({
      homeDir: path.dirname(sessionsDir),
      env: { NEST_FAKE_SESSION_DIR: sessionsDir },
    });
  const sessions = new SessionService(
    db,
    tasks,
    harnesses,
    resolved,
    (event) => events.push(event),
    { spawnPty: spawnPipedPty },
  );
  cleanup.push(() => {
    try {
      sessions.shutdownAll();
    } catch {
      // the database may already be closed
    }
  });
  return sessions;
}

/**
 * A tab whose harness printed a conversation id that another tab already owns.
 * The real stub races the first tab's claim, so the collision is fixed here to
 * test the guard itself rather than the order two processes happened to run in.
 */
function reportingDiscovery(id: string): HarnessDiscovery {
  const result: DiscoveryResult = {
    id,
    confidence: 'exact',
    reason: 'process_reported',
    candidates: 1,
    createdAtMs: Date.now(),
  };
  return { find: async () => result } as unknown as HarnessDiscovery;
}

/** Simulates a full quit and the next app start on the same database. */
function restart(fixture: Fixture): SessionService {
  fixture.sessions.shutdownAll();
  const sessions = createSessions(
    fixture.db,
    fixture.tasks,
    fixture.stub,
    fixture.sessionsDir,
    fixture.events,
  );
  sessions.recoverStale();
  sessions.resumePending();
  fixture.sessions = sessions;
  return sessions;
}

function conversationFileIds(sessionsDir: string): string[] {
  try {
    return readdirSync(sessionsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

function claimed(sessions: SessionService): string[] {
  return sessions
    .list()
    .map((session) => session.harnessSessionId)
    .filter((id): id is string => id !== null);
}

function resumeTail(scrollback: string): string {
  const marker = scrollback.indexOf('── resume');
  return marker < 0 ? '' : scrollback.slice(marker);
}

async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('session conversation identity', () => {
  it('gives each parallel tab its own conversation', async () => {
    const fixture = await setup('print');
    const first = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    const second = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });

    await waitFor(
      () =>
        fixture.sessions.get(first.id).resumeMode === 'exact' &&
        fixture.sessions.get(second.id).resumeMode === 'exact',
    );

    const one = fixture.sessions.get(first.id);
    const two = fixture.sessions.get(second.id);
    expect(one.harnessSessionId).not.toBeNull();
    expect(one.harnessSessionId).not.toBe(two.harnessSessionId);

    // Each tab kept the id its own process printed, not the other tab's.
    expect(conversationFileIds(fixture.sessionsDir)).toEqual(
      expect.arrayContaining([one.harnessSessionId, two.harnessSessionId]),
    );
    expect(fixture.sessions.scrollback(first.id)).toContain(`session ${one.harnessSessionId}`);
    expect(fixture.sessions.scrollback(second.id)).toContain(`session ${two.harnessSessionId}`);

    // No conversation id is assigned to two sessions.
    const ids = claimed(fixture.sessions);
    expect(ids).toHaveLength(new Set(ids).size);

    fixture.sessions.stop(first.id);
    fixture.sessions.stop(second.id);
  });

  it('does not capture a conversation that already existed', async () => {
    const fixture = await setup('silent');
    mkdirSync(fixture.sessionsDir, { recursive: true });
    const existing = path.join(fixture.sessionsDir, 'other-tab.json');
    writeFileSync(existing, JSON.stringify({ id: 'other-tab', cwd: fixture.repo }), 'utf8');
    // Another tab created it a second before this one started.
    const stamp = new Date(Date.now() - 1000);
    utimesSync(existing, stamp, stamp);

    const session = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });

    await waitFor(() => fixture.sessions.scrollback(session.id).includes('stub ready'));
    await sleep(3500);

    const stored = fixture.sessions.get(session.id);
    expect(stored.harnessSessionId).toBeNull();
    expect(stored.resumeMode).toBe('latest');
    fixture.sessions.stop(session.id);
  });

  it('binds a conversation that appears after the tab started', async () => {
    const fixture = await setup('delayed');
    const session = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });

    await waitFor(() => fixture.sessions.get(session.id).harnessSessionId !== null);

    const stored = fixture.sessions.get(session.id);
    expect(stored.resumeMode).toBe('exact');
    expect(conversationFileIds(fixture.sessionsDir)).toEqual([stored.harnessSessionId]);
    fixture.sessions.stop(session.id);
  });

  it('never lets two tabs hold the same conversation id', async () => {
    const fixture = await setup('shared');
    process.env.NEST_TEST_SHARED_ID = 'shared-conversation';
    const first = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(() => fixture.sessions.get(first.id).harnessSessionId === 'shared-conversation');

    // The second tab's harness reports the same conversation after the first
    // one already owns it: the claim must lose and the tab must keep the
    // "Resume latest" fallback with a warning.
    const second = createSessions(
      fixture.db,
      fixture.tasks,
      fixture.stub,
      fixture.sessionsDir,
      fixture.events,
      reportingDiscovery('shared-conversation'),
    );
    await second.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });

    await waitFor(() =>
      fixture.events.some(
        (event) => event.type === 'notification' && event.message.includes('another tab'),
      ),
    );

    const owners = fixture.sessions
      .list()
      .filter((session) => session.harnessSessionId === 'shared-conversation');
    expect(owners).toHaveLength(1);
    expect(claimed(fixture.sessions)).toEqual(['shared-conversation']);

    for (const session of fixture.sessions.list()) fixture.sessions.stop(session.id);
  });

  it('never auto-applies a heuristic id on restart', async () => {
    const fixture = await setup('print');
    const session = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(() => fixture.sessions.get(session.id).resumeMode === 'exact');

    // What a discovery guess or an older Nest release stored for this row.
    fixture.db
      .prepare("UPDATE sessions SET resume_mode = 'heuristic' WHERE id = ?")
      .run(session.id);

    const restarted = restart(fixture);
    await waitFor(() => resumeTail(restarted.scrollback(session.id)).includes('stub ready'));

    const tail = resumeTail(restarted.scrollback(session.id));
    expect(tail).toContain('(continue)');
    expect(tail).not.toContain('(exact)');
    restarted.stop(session.id);
  });

  it('does not resume into another tab conversation on restart', async () => {
    const fixture = await setup('print');
    const first = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(() => fixture.sessions.get(first.id).resumeMode === 'exact');
    const firstId = fixture.sessions.get(first.id).harnessSessionId;

    const second = await fixture.sessions.start({
      taskId: fixture.checkout.id,
      harnessId: 'fake',
      cols: 80,
      rows: 24,
    });
    await waitFor(() => fixture.sessions.get(second.id).harnessSessionId !== null);
    // An unverified tab: the newest conversation may be the other tab's.
    fixture.db
      .prepare("UPDATE sessions SET harness_session_id = NULL, resume_mode = 'latest' WHERE id = ?")
      .run(second.id);

    const restarted = restart(fixture);
    await waitFor(() => restarted.get(first.id).status === 'running');
    await sleep(1500);

    expect(resumeTail(restarted.scrollback(first.id))).toContain(`(exact) session ${firstId}`);
    expect(restarted.get(second.id).status).toBe('exited');
    expect(resumeTail(restarted.scrollback(second.id))).toBe('');
    expect(
      fixture.events.some(
        (event) => event.type === 'notification' && event.message.includes('another tab'),
      ),
    ).toBe(true);

    restarted.stop(first.id);
  });
});
