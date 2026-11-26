import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { HarnessRegistry, resolveDshProfile } from '../src/harness/registry.js';

/**
 * DeepSeek Harness. `dsh` is only a launcher: it boots `profiles/<name>` and
 * exits with "--profile <name> is required" when it is started bare.
 */

const fakeHarnessScript = fileURLToPath(
  new URL('../../../scripts/fake-harness.mjs', import.meta.url),
);
const root = mkdtempSync(path.join(os.tmpdir(), 'nest-dsh-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function dshHome(name: string, profiles: Record<string, string | null>): string {
  const home = path.join(root, name);
  for (const [profile, manifest] of Object.entries(profiles)) {
    const dir = path.join(home, 'profiles', profile);
    mkdirSync(dir, { recursive: true });
    if (manifest !== null) writeFileSync(path.join(dir, 'package.json'), manifest, 'utf8');
  }
  return home;
}

function registry(dshHome?: string): HarnessRegistry {
  return new HarnessRegistry({ fakeHarnessScript, dshHome });
}

/** Reads a profile without the PATH lookup, which depends on the machine. */
function argsOf(registryInstance: HarnessRegistry, id: string): string[] {
  return registryInstance.list({ includeDisabled: true }).find((profile) => profile.id === id)
    ?.args ?? [];
}

function resumeArgsOf(registryInstance: HarnessRegistry, id: string): string[] {
  return (
    registryInstance.list({ includeDisabled: true }).find((profile) => profile.id === id)
      ?.resumeArgs ?? []
  );
}

describe('deepseek harness profile', () => {
  it('prefers the profile name the launcher documents', () => {
    const home = dshHome('preferred', { 'dsh-tui': null, tui: null });
    expect(resolveDshProfile(home)).toBe('tui');
  });

  it('falls back to the tui profile shipped under another name', () => {
    const home = dshHome('shipped', {
      web: JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
      'dsh-tui': JSON.stringify({
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-harness-tui/dsh-tui'] } },
      }),
    });
    expect(resolveDshProfile(home)).toBe('dsh-tui');
  });

  it('stays out of the way when no profiles are installed', () => {
    expect(resolveDshProfile(path.join(root, 'missing-home'))).toBeNull();
    expect(argsOf(registry(path.join(root, 'missing-home')), 'dsh')).toEqual([]);
    expect(resumeArgsOf(registry(path.join(root, 'missing-home')), 'dsh')).toEqual([]);
  });

  it('launches the profile instead of the bare launcher', () => {
    const home = dshHome('launch', { 'dsh-tui': null });
    const harnesses = registry(home);
    expect(argsOf(harnesses, 'dsh')).toEqual(['--profile', 'dsh-tui']);
    expect(resumeArgsOf(harnesses, 'dsh')).toEqual(['--profile', 'dsh-tui', '--continue']);
    expect(harnesses.exactResumeArgs('dsh', 'sess-1')).toEqual([
      '--profile',
      'dsh-tui',
      '--resume',
      'sess-1',
    ]);
  });

  it('keeps launcher flags ahead of the user arguments', () => {
    const home = dshHome('extra-args', { tui: null });
    const harnesses = new HarnessRegistry({
      fakeHarnessScript,
      dshHome: home,
      getSettings: () => ({
        disabledHarnesses: [],
        customCommand: '',
        shellCommand: '',
        harnessArgs: { dsh: '--patch ./extra.yml' },
      }),
    });
    // Profile first, then the overlay the user configured in Settings.
    const profile = harnesses.list().find((candidate) => candidate.id === 'dsh');
    expect(profile?.args).toEqual(['--profile', 'tui', '--patch', './extra.yml']);
  });
});
