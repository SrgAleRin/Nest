import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HarnessDiscovery, samePath } from '../src/harness/discovery.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'nest-discovery-'));
const repo = path.join(root, 'repo');
const otherRepo = path.join(root, 'other');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(filePath: string, contents: string, ageMs = 0): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, 'utf8');
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs);
    utimesSync(filePath, stamp, stamp);
  }
}

function since(): Date {
  return new Date(Date.now() - 10_000);
}

function encodeQwen(cwd: string): string {
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

describe('harness session discovery', () => {
  it('treats equivalent cwd spellings as the same path', () => {
    expect(samePath(repo, repo + path.sep)).toBe(true);
    if (process.platform === 'win32') {
      expect(samePath(repo, repo.toUpperCase())).toBe(true);
    }
  });

  it('finds the newest Codex rollout for the workspace', async () => {
    const home = path.join(root, 'codex-home');
    const directory = path.join(home, '.codex', 'sessions', '2026', '01', '02');
    writeFile(
      path.join(directory, 'rollout-old.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-old', cwd: repo } })}\n`,
      60 * 60_000,
    );
    writeFile(
      path.join(directory, 'rollout-new.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-new', cwd: repo } })}\n`,
    );
    writeFile(
      path.join(directory, 'rollout-other.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-other', cwd: otherRepo } })}\n`,
    );

    const discovery = new HarnessDiscovery({ homeDir: home, env: {} });
    await expect(discovery.find('codex', repo, since())).resolves.toBe('codex-new');
  });

  it('finds a pi session by its recorded cwd', async () => {
    const home = path.join(root, 'pi-home');
    const directory = path.join(home, '.pi', 'agent', 'sessions', '--repo--');
    writeFile(
      path.join(directory, '2026-01-01T00-00-00-000Z_pi-1.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'pi-1', cwd: repo })}\n`,
    );
    writeFile(
      path.join(directory, '2026-01-01T00-00-01-000Z_pi-2.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'pi-2', cwd: otherRepo })}\n`,
    );

    const discovery = new HarnessDiscovery({ homeDir: home, env: {} });
    await expect(discovery.find('pi', repo, since())).resolves.toBe('pi-1');
  });

  it('finds a Copilot workspace by cwd', async () => {
    const home = path.join(root, 'copilot-home');
    const stateDir = path.join(home, '.copilot', 'session-state', 'copilot-uuid');
    writeFile(
      path.join(stateDir, 'workspace.yaml'),
      ['id: copilot-uuid', `cwd: ${repo}`, 'created_at: 2026-01-01T00:00:00.000Z'].join('\n'),
    );

    const discovery = new HarnessDiscovery({ homeDir: home, env: {} });
    await expect(discovery.find('copilot', repo, since())).resolves.toBe('copilot-uuid');
  });

  it('finds a Claude transcript by cwd or encoded project directory', async () => {
    const home = path.join(root, 'claude-home');
    const encoded = repo.replace(/[^a-z0-9]/gi, '-');
    const projectDir = path.join(home, '.claude', 'projects', encoded);
    writeFile(
      path.join(projectDir, 'claude-uuid.jsonl'),
      `${JSON.stringify({ sessionId: 'claude-uuid', cwd: repo })}\n`,
    );

    const discovery = new HarnessDiscovery({ homeDir: home, env: {} });
    await expect(discovery.find('claude', repo, since())).resolves.toBe('claude-uuid');
  });

  it('finds the newest Qwen chat under the encoded project directory', async () => {
    const qwenHome = path.join(root, 'qwen-home');
    const chatsDir = path.join(qwenHome, 'projects', encodeQwen(repo), 'chats');
    writeFile(path.join(chatsDir, 'qwen-old.jsonl'), '{}\n', 60 * 60_000);
    writeFile(path.join(chatsDir, 'qwen-new.jsonl'), '{}\n');
    writeFile(
      path.join(qwenHome, 'projects', encodeQwen(otherRepo), 'chats', 'qwen-other.jsonl'),
      '{}\n',
    );

    const discovery = new HarnessDiscovery({
      homeDir: path.join(root, 'qwen-default-home'),
      env: { QWEN_HOME: qwenHome },
    });
    await expect(discovery.find('qwen', repo, since())).resolves.toBe('qwen-new');

    const runtimeDiscovery = new HarnessDiscovery({
      homeDir: path.join(root, 'qwen-default-home'),
      env: { QWEN_RUNTIME_DIR: qwenHome },
    });
    await expect(runtimeDiscovery.find('qwen', repo, since())).resolves.toBe('qwen-new');

    // A missing encoded project directory returns null instead of scanning every project.
    await expect(
      discovery.find('qwen', path.join(root, 'missing-repo'), since()),
    ).resolves.toBeNull();
  });

  it('asks OpenCode for recent sessions and picks the newest for cwd', async () => {
    const now = Date.now();
    const discovery = new HarnessDiscovery({
      homeDir: path.join(root, 'opencode-home'),
      env: {},
      run: async (command, args) => {
        expect(command).toBe('opencode');
        expect(args).toContain('--format');
        return JSON.stringify([
          { id: 'ses-other', directory: otherRepo, created: now, updated: now },
          { id: 'ses-old', directory: repo, created: now - 60_000, updated: now - 60_000 },
          { id: 'ses-new', directory: repo, created: now - 1_000, updated: now - 1_000 },
          { id: 'ses-resumed', directory: repo, created: now - 3_600_000, updated: now },
        ]);
      },
    });

    await expect(discovery.find('opencode', repo, since())).resolves.toBe('ses-new');
  });

  it('can match a continued OpenCode conversation by last activity', async () => {
    const now = Date.now();
    const discovery = new HarnessDiscovery({
      homeDir: path.join(root, 'opencode-home'),
      env: {},
      run: async () =>
        JSON.stringify([
          { id: 'ses-created-now', directory: repo, created: now, updated: now - 2_000 },
          { id: 'ses-resumed', directory: repo, created: now - 3_600_000, updated: now },
        ]),
    });

    await expect(
      discovery.find('opencode', repo, since(), { includeUpdated: true }),
    ).resolves.toBe('ses-resumed');
  });

  it('reads fake harness sessions only when a directory is configured', async () => {
    const fakeDir = path.join(root, 'fake-sessions');
    writeFile(
      path.join(fakeDir, 'fake-old.json'),
      JSON.stringify({ id: 'fake-old', cwd: repo }),
      60 * 60_000,
    );
    writeFile(path.join(fakeDir, 'fake-new.json'), JSON.stringify({ id: 'fake-new', cwd: repo }));
    writeFile(
      path.join(fakeDir, 'fake-other.json'),
      JSON.stringify({ id: 'fake-other', cwd: otherRepo }),
    );

    const discovery = new HarnessDiscovery({
      homeDir: path.join(root, 'fake-home'),
      env: { NEST_FAKE_SESSION_DIR: fakeDir },
    });
    await expect(discovery.find('fake', repo, since())).resolves.toBe('fake-new');

    const withoutDir = new HarnessDiscovery({
      homeDir: path.join(root, 'fake-home'),
      env: {},
    });
    await expect(withoutDir.find('fake', repo, since())).resolves.toBeNull();
  });

  it('ignores conversations older than the Nest session', async () => {
    const home = path.join(root, 'stale-home');
    const directory = path.join(home, '.pi', 'agent', 'sessions', '--repo--');
    writeFile(
      path.join(directory, 'old.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'stale', cwd: repo })}\n`,
      60 * 60_000,
    );

    const discovery = new HarnessDiscovery({ homeDir: home, env: {} });
    await expect(discovery.find('pi', repo, since())).resolves.toBeNull();
  });
});
