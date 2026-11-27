import path from 'node:path';
import type { AppSettings, AppSettingsPatch } from '@nest/shared';
import {
  AppSettingsSchema,
  DEFAULT_TERMINAL_PREFERENCES,
  normalizeTerminalFontFamily,
} from '@nest/shared';
import type { Db } from '../db/database.js';

const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS: AppSettings = {
  disabledHarnesses: [],
  customCommand: '',
  harnessArgs: {},
  shellCommand: '',
  terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
  worktreeRoot: '',
  copyEnvFiles: false,
  updateFeedUrl: '',
  updatesEnabled: true,
  newSessionDefault: 'ask',
};

/**
 * Where new worktrees go: the saved path when one is set, otherwise the root
 * the app was started with. A saved path is made absolute once so the stored
 * task paths and `git worktree` always agree; existing worktrees are never
 * moved. An unusable path is not silently replaced here: creating a task
 * reports it.
 */
export function resolveWorktreesRoot(defaultRoot: string, settingValue: string): string {
  const trimmed = settingValue.trim();
  return trimmed ? path.resolve(trimmed) : defaultRoot;
}

/**
 * Small key/value application settings store. One row holds the whole object as
 * JSON so adding a field never needs a migration: the schema fills defaults for
 * rows written by an older build.
 */
export class SettingsService {
  constructor(private readonly db: Db) {}

  get(): AppSettings {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as
      { value: string } | undefined;
    if (!row) return cloneDefaults();

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return cloneDefaults();
    }

    // Rows written by older builds can keep a line height the strict schema now
    // rejects (xterm throws below 1) or an empty font family. Repair just those
    // fields so the rest of the row survives instead of falling back to defaults.
    const result = AppSettingsSchema.safeParse(upgradeLegacyTerminal(parsed));
    return result.success ? normalize(result.data) : cloneDefaults();
  }

  update(patch: AppSettingsPatch): AppSettings {
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    const next = normalize(AppSettingsSchema.parse({ ...this.get(), ...defined }));
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }
}

function cloneDefaults(): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    disabledHarnesses: [],
    harnessArgs: {},
    terminal: { ...DEFAULT_SETTINGS.terminal },
  };
}

/**
 * Pre-clamps terminal values a legacy row may hold, keeping
 * `TerminalPreferencesSchema` strict for RPC input while old rows still load.
 */
function upgradeLegacyTerminal(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const row = parsed as Record<string, unknown>;
  const terminal = row.terminal;
  if (!terminal || typeof terminal !== 'object') return parsed;

  const next: Record<string, unknown> = { ...(terminal as Record<string, unknown>) };
  const lineHeight = next.lineHeight;
  if (typeof lineHeight === 'number' && Number.isFinite(lineHeight) && lineHeight < 1) {
    next.lineHeight = 1;
  }
  if (typeof next.fontFamily === 'string' && next.fontFamily.trim() === '') {
    next.fontFamily = DEFAULT_TERMINAL_PREFERENCES.fontFamily;
  }

  return { ...row, terminal: next };
}

function normalize(settings: AppSettings): AppSettings {
  return {
    customCommand: settings.customCommand.trim(),
    disabledHarnesses: [...new Set(settings.disabledHarnesses)],
    harnessArgs: Object.fromEntries(
      Object.entries(settings.harnessArgs)
        .map(([id, args]) => [id, args.trim()] as const)
        .filter(([, args]) => args.length > 0),
    ),
    shellCommand: settings.shellCommand.trim(),
    terminal: {
      ...settings.terminal,
      fontFamily: normalizeTerminalFontFamily(settings.terminal.fontFamily),
      lineHeight: Math.min(2, Math.max(1, settings.terminal.lineHeight)),
    },
    worktreeRoot: settings.worktreeRoot.trim(),
    copyEnvFiles: settings.copyEnvFiles,
    updateFeedUrl: settings.updateFeedUrl.trim(),
    updatesEnabled: settings.updatesEnabled,
    newSessionDefault: settings.newSessionDefault,
  };
}
