import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppSettings } from '@nest/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/database.js';
import { HarnessRegistry } from '../src/harness/registry.js';
import { DEFAULT_SETTINGS, SettingsService } from '../src/services/settings.js';

// The fake harness is hidden from lists unless explicitly enabled for tests.
process.env.NEST_ENABLE_FAKE_HARNESS = '1';

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);

const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'nest-settings-'));

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function openSettings(file = 'settings.db') {
  const db = openDatabase(path.join(tempRoot, file));
  migrate(db);
  return { db, settings: new SettingsService(db) };
}

describe('settings service', () => {
  it('returns defaults for an empty database', () => {
    const { db, settings } = openSettings('empty.db');
    expect(settings.get()).toEqual(DEFAULT_SETTINGS);
    db.close();
  });

  it('merges patches, trims the command and dedupes disabled ids', () => {
    const { db, settings } = openSettings('merge.db');

    expect(settings.update({ customCommand: '  my-agent  ' }).customCommand).toBe('my-agent');
    expect(settings.update({ customCommand: '' }).customCommand).toBe('');

    const updated = settings.update({ disabledHarnesses: ['claude', 'codex', 'claude'] });
    expect(updated.disabledHarnesses).toEqual(['claude', 'codex']);
    expect(updated.customCommand).toBe('');
    // A patch that omits a field keeps the stored value.
    expect(settings.update({ customCommand: 'agent' }).disabledHarnesses).toEqual([
      'claude',
      'codex',
    ]);
    expect(
      settings.update({ updateFeedUrl: '  https://updates.example.com/nest/  ' }).updateFeedUrl,
    ).toBe('https://updates.example.com/nest/');
    expect(settings.update({ customCommand: 'agent-2' }).updateFeedUrl).toBe(
      'https://updates.example.com/nest/',
    );
    expect(settings.update({ newSessionDefault: 'shell' }).newSessionDefault).toBe('shell');
    db.close();
  });

  it('persists across reopen and tolerates a corrupt row', () => {
    const first = openSettings('persist.db');
    first.settings.update({ disabledHarnesses: ['fake'], customCommand: 'agent' });
    first.db.close();

    const second = openSettings('persist.db');
    expect(second.settings.get()).toEqual({
      disabledHarnesses: ['fake'],
      customCommand: 'agent',
      updateFeedUrl: '',
      newSessionDefault: 'ask',
    });

    second.db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('{not json', 'app');
    expect(second.settings.get()).toEqual(DEFAULT_SETTINGS);
    second.db.close();
  });

  it('fills the update feed default for rows written by older builds', () => {
    const { db, settings } = openSettings('legacy.db');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
      'app',
      JSON.stringify({ disabledHarnesses: ['fake'], customCommand: 'agent' }),
    );
    expect(settings.get()).toEqual({
      disabledHarnesses: ['fake'],
      customCommand: 'agent',
      updateFeedUrl: '',
      newSessionDefault: 'ask',
    });
    db.close();
  });

  it('rejects unknown harness ids', () => {
    const { db, settings } = openSettings('invalid.db');
    expect(() => settings.update({ disabledHarnesses: ['nope' as 'claude'] })).toThrow();
    db.close();
  });
});

describe('settings-aware harness registry', () => {
  const state: Pick<AppSettings, 'disabledHarnesses' | 'customCommand'> = {
    disabledHarnesses: [],
    customCommand: '',
  };
  const registry = new HarnessRegistry({
    fakeHarnessScript,
    getSettings: () => state,
  });

  it('hides the fake harness unless it is enabled for tests', () => {
    const enabled = process.env.NEST_ENABLE_FAKE_HARNESS;
    const sessionDir = process.env.NEST_FAKE_SESSION_DIR;
    delete process.env.NEST_ENABLE_FAKE_HARNESS;
    delete process.env.NEST_FAKE_SESSION_DIR;

    try {
      expect(registry.list({ includeDisabled: true }).some((profile) => profile.id === 'fake')).toBe(
        false,
      );
      expect(registry.get('fake', { allowDisabled: true }).id).toBe('fake');
    } finally {
      if (enabled === undefined) delete process.env.NEST_ENABLE_FAKE_HARNESS;
      else process.env.NEST_ENABLE_FAKE_HARNESS = enabled;
      if (sessionDir === undefined) delete process.env.NEST_FAKE_SESSION_DIR;
      else process.env.NEST_FAKE_SESSION_DIR = sessionDir;
    }
  });

  it('hides disabled profiles but keeps them for settings and resume', () => {
    state.disabledHarnesses = ['fake'];
    expect(registry.list().some((profile) => profile.id === 'fake')).toBe(false);
    expect(registry.list({ includeDisabled: true }).some((profile) => profile.id === 'fake')).toBe(
      true,
    );

    expect(() => registry.get('fake')).toThrow(/disabled in Settings/);
    expect(registry.get('fake', { allowDisabled: true }).id).toBe('fake');
    state.disabledHarnesses = [];
  });

  it('updates the custom profile from settings without recreating the registry', () => {
    expect(registry.list().some((profile) => profile.id === 'custom')).toBe(false);

    state.customCommand = process.execPath;
    const profile = registry.list().find((candidate) => candidate.id === 'custom');
    expect(profile?.command).toBe(process.execPath);
    expect(profile?.available).toBe(true);
    expect(profile?.source).toBe('custom');

    state.customCommand = '';
    expect(registry.list().some((candidate) => candidate.id === 'custom')).toBe(false);
  });

  it('caches PATH lookups until invalidated', () => {
    const ghost = path.join(tempRoot, 'ghost-agent.exe');
    state.customCommand = ghost;

    const before = () => registry.list().find((candidate) => candidate.id === 'custom');
    expect(before()?.available).toBe(false);

    writeFileSync(ghost, '', 'utf8');
    expect(before()?.available).toBe(false);

    registry.invalidate();
    expect(before()?.available).toBe(true);
    state.customCommand = '';
  });
});
