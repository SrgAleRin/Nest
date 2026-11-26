import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AppSettings, HarnessId, HarnessProfile } from '@nest/shared';
import { NestError } from '../errors.js';
import { splitArgs } from './args.js';
import type { PasteInputMode } from './paste.js';

export interface HarnessRegistryOptions {
  fakeHarnessScript: string;
  /** Dev fallback used when the persisted custom command is empty. */
  customCommand?: string;
  /** Read at call time so a settings change applies without a restart. */
  getSettings?: () => Pick<
    AppSettings,
    'disabledHarnesses' | 'customCommand' | 'harnessArgs' | 'shellCommand'
  >;
}

/** Profiles without confirmed bracketed-paste handling, also for stored sessions. */
const PLAIN_LINE_IDS: ReadonlySet<string> = new Set(['shell', 'dsh', 'custom']);

interface Definition {
  id: HarnessId;
  label: string;
  description: string;
  command: string;
  args: string[];
  resumeArgs: string[];
  source: 'builtin' | 'custom';
  /**
   * How multi-line text (a review note, a pasted block) goes into this CLI.
   *
   * `bracketed-paste` is the default for agent TUIs: they enable `CSI 200~`
   * mode, so the whole note arrives as one input and a single Enter submits
   * it. Profiles without confirmed bracketed-paste handling get `line`, which
   * writes no escape sequences and submits each line with `\r`.
   */
  inputMode: PasteInputMode;
}

export class HarnessRegistry {
  private readonly cache = new Map<string, boolean>();
  private readonly builtins: Definition[];
  private readonly fallbackCustomCommand: string;

  constructor(private readonly options: HarnessRegistryOptions) {
    const fakeCommand = process.env.NEST_NODE ?? 'node';
    this.fallbackCustomCommand = (
      options.customCommand ??
      process.env.NEST_CUSTOM_COMMAND ??
      ''
    ).trim();

    this.builtins = [
      {
        id: 'claude',
        label: 'Claude Code',
        description: 'Anthropic Claude Code CLI',
        command: 'claude',
        args: [],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'codex',
        label: 'Codex',
        description: 'OpenAI Codex CLI',
        command: 'codex',
        args: [],
        resumeArgs: ['resume', '--last'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'dsh',
        label: 'DeepSeek Harness',
        description: 'DeepSeek harness CLI',
        command: 'dsh',
        args: [],
        resumeArgs: [],
        inputMode: 'line',
        source: 'builtin',
      },
      {
        id: 'opencode',
        label: 'OpenCode',
        description: 'OpenCode CLI',
        command: 'opencode',
        args: [],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'pi',
        label: 'pi',
        description: 'pi coding agent CLI',
        command: 'pi',
        args: [],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'copilot',
        label: 'GitHub Copilot CLI',
        description: 'GitHub Copilot CLI',
        command: 'copilot',
        args: [],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'zcode',
        label: 'ZCode',
        description: 'Z.ai ZCode CLI',
        command: 'zcode',
        args: [],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'qwen',
        label: 'Qwen Code',
        description: 'Qwen Code CLI',
        command: 'qwen',
        args: [],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
      {
        id: 'shell',
        label: 'Terminal',
        description: 'Plain shell in the task workspace',
        command: resolveShellCommand(),
        args: [],
        resumeArgs: [],
        inputMode: 'line',
        source: 'builtin',
      },
      {
        id: 'fake',
        label: 'Fake harness',
        description: 'Built-in deterministic harness for development and e2e',
        command: fakeCommand,
        args: [options.fakeHarnessScript],
        resumeArgs: ['--continue'],
        inputMode: 'bracketed-paste',
        source: 'builtin',
      },
    ];
  }

  /**
   * Profiles offered by the start pickers. Disabled profiles are hidden, and
   * the custom profile only exists while a command is configured.
   */
  list(options: { includeDisabled?: boolean } = {}): HarnessProfile[] {
    const disabled = this.disabledIds();
    return this.definitions()
      .filter((definition) => definition.id !== 'fake' || this.fakeEnabled())
      .filter((definition) => options.includeDisabled || !disabled.has(definition.id))
      .map((definition) => this.toProfile(definition));
  }

  get(id: string, options: { allowDisabled?: boolean } = {}): HarnessProfile {
    const definition = this.definitions().find((candidate) => candidate.id === id);
    if (!definition) throw new NestError('harness_not_found', `Unknown harness ${id}`);

    if (!options.allowDisabled && this.disabledIds().has(definition.id)) {
      throw new NestError(
        'harness_disabled',
        `${definition.label} is disabled in Settings. Enable it there to start a session.`,
      );
    }

    if (!this.isAvailable(definition)) {
      throw new NestError(
        'harness_unavailable',
        `${definition.label} is not installed or its command was not found on PATH`,
      );
    }
    return this.toProfile(definition);
  }

  /** Drops cached PATH lookups, e.g. after the custom command changed. */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * Paste mode of a registered profile. Capability only: it stays answerable
   * for disabled profiles and for stored sessions whose command is gone, since
   * the write path must not fail just because the picker was cleaned up.
   */
  inputMode(harnessId: string): PasteInputMode {
    const definition = this.definitions().find((candidate) => candidate.id === harnessId);
    if (definition) return definition.inputMode;
    // A stored session whose profile is gone: keep the plain-line fallback for
    // the generic ids, the common case (an agent TUI) otherwise.
    return PLAIN_LINE_IDS.has(harnessId) ? 'line' : 'bracketed-paste';
  }

  /**
   * Args that continue one specific conversation, when the CLI supports it.
   * Returns null when only the "latest conversation" fallback is available.
   */
  exactResumeArgs(harnessId: string, sessionId: string): string[] | null {
    switch (harnessId) {
      case 'claude':
        return ['--resume', sessionId];
      case 'codex':
        return ['resume', sessionId];
      case 'opencode':
        return ['--session', sessionId];
      case 'pi':
        return ['--session-id', sessionId];
      case 'copilot':
        return ['--resume', sessionId];
      case 'zcode':
        return ['--resume', sessionId];
      case 'qwen':
        return ['--resume', sessionId];
      case 'fake':
        return ['--session-id', sessionId];
      default:
        return null;
    }
  }

  supportsDiscovery(harnessId: string): boolean {
    switch (harnessId) {
      case 'claude':
      case 'codex':
      case 'opencode':
      case 'pi':
      case 'copilot':
      case 'qwen':
      case 'fake':
        return true;
      default:
        return false;
    }
  }

  private definitions(): Definition[] {
    const settings = this.currentSettings();
    const custom = (settings.customCommand || this.fallbackCustomCommand).trim();
    const builtins = settings.shellCommand.trim()
      ? this.builtins.map((definition) =>
          definition.id === 'shell'
            ? { ...definition, command: settings.shellCommand.trim() }
            : definition,
        )
      : this.builtins;
    const withArgs = (definition: Definition): Definition => {
      const extra = splitArgs(settings.harnessArgs?.[definition.id] ?? '');
      return extra.length > 0 ? { ...definition, args: [...definition.args, ...extra] } : definition;
    };

    if (!custom) return builtins.map(withArgs);
    return [
      ...builtins.map(withArgs),
      withArgs({
        id: 'custom',
        label: 'Custom command',
        description: custom,
        command: custom,
        args: [],
        resumeArgs: [],
        source: 'custom',
        // Unknown CLI: no escape sequences, plain submitted lines.
        inputMode: 'line',
      }),
    ];
  }

  private currentSettings(): Pick<
    AppSettings,
    'disabledHarnesses' | 'customCommand' | 'harnessArgs' | 'shellCommand'
  > {
    return (
      this.options.getSettings?.() ?? {
        disabledHarnesses: [],
        customCommand: '',
        harnessArgs: {},
        shellCommand: '',
      }
    );
  }

  private disabledIds(): Set<string> {
    return new Set(this.currentSettings().disabledHarnesses);
  }

  private fakeEnabled(): boolean {
    return (
      Boolean(process.env.NEST_FAKE_SESSION_DIR) || process.env.NEST_ENABLE_FAKE_HARNESS === '1'
    );
  }

  private toProfile(definition: Definition): HarnessProfile {
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      command: definition.command,
      args: definition.args,
      resumeArgs: definition.resumeArgs,
      available: this.isAvailable(definition),
      source: definition.source,
    };
  }

  private isAvailable(definition: Definition): boolean {
    if (!definition.command) return false;
    if (definition.id === 'fake') {
      return existsSync(this.options.fakeHarnessScript) && commandExists(definition.command);
    }
    const cached = this.cache.get(definition.command);
    if (cached !== undefined) return cached;
    const available = commandExists(definition.command);
    this.cache.set(definition.command, available);
    return available;
  }
}

function resolveShellCommand(): string {
  const override = process.env.NEST_SHELL?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    if (commandExists('pwsh')) return 'pwsh';
    if (commandExists('powershell.exe')) return 'powershell.exe';
    return process.env.ComSpec || 'cmd.exe';
  }

  return process.env.SHELL || 'bash';
}

function commandExists(command: string): boolean {
  if (/[\\/]/.test(command)) return existsSync(command);
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [command], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}
