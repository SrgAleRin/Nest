import type { AppSettings, AppSettingsPatch } from '@nest/shared';
import { AppSettingsSchema } from '@nest/shared';
import type { Db } from '../db/database.js';

const SETTINGS_KEY = 'app';

export const DEFAULT_SETTINGS: AppSettings = {
  disabledHarnesses: [],
  customCommand: '',
};

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

    const result = AppSettingsSchema.safeParse(parsed);
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
  return { ...DEFAULT_SETTINGS, disabledHarnesses: [] };
}

function normalize(settings: AppSettings): AppSettings {
  return {
    customCommand: settings.customCommand.trim(),
    disabledHarnesses: [...new Set(settings.disabledHarnesses)],
  };
}
