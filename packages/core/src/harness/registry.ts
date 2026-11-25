import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { HarnessId, HarnessProfile } from '@nest/shared';
import { NestError } from '../errors.js';

export interface HarnessRegistryOptions {
  fakeHarnessScript: string;
  customCommand?: string;
}

interface Definition {
  id: HarnessId;
  label: string;
  description: string;
  command: string;
  args: string[];
  resumeArgs: string[];
  source: 'builtin' | 'custom';
}

export class HarnessRegistry {
  private readonly cache = new Map<string, boolean>();
  private readonly definitions: Definition[];

  constructor(private readonly options: HarnessRegistryOptions) {
    const fakeCommand = process.env.NEST_NODE ?? 'node';
    const customCommand = options.customCommand ?? process.env.NEST_CUSTOM_COMMAND ?? '';

    this.definitions = [
      {
        id: 'claude',
        label: 'Claude Code',
        description: 'Anthropic Claude Code CLI',
        command: 'claude',
        args: [],
        resumeArgs: ['--continue'],
        source: 'builtin',
      },
      {
        id: 'codex',
        label: 'Codex',
        description: 'OpenAI Codex CLI',
        command: 'codex',
        args: [],
        resumeArgs: ['resume', '--last'],
        source: 'builtin',
      },
      {
        id: 'dsh',
        label: 'DeepSeek Harness',
        description: 'DeepSeek harness CLI',
        command: 'dsh',
        args: [],
        resumeArgs: [],
        source: 'builtin',
      },
      {
        id: 'opencode',
        label: 'OpenCode',
        description: 'OpenCode CLI',
        command: 'opencode',
        args: [],
        resumeArgs: ['--continue'],
        source: 'builtin',
      },
      {
        id: 'pi',
        label: 'pi',
        description: 'pi coding agent CLI',
        command: 'pi',
        args: [],
        resumeArgs: ['--continue'],
        source: 'builtin',
      },
      {
        id: 'copilot',
        label: 'GitHub Copilot CLI',
        description: 'GitHub Copilot CLI',
        command: 'copilot',
        args: [],
        resumeArgs: ['--continue'],
        source: 'builtin',
      },
      {
        id: 'fake',
        label: 'Fake harness',
        description: 'Built-in deterministic harness for development and e2e',
        command: fakeCommand,
        args: [options.fakeHarnessScript],
        resumeArgs: ['--continue'],
        source: 'builtin',
      },
      {
        id: 'custom',
        label: 'Custom command',
        description: 'Command from NEST_CUSTOM_COMMAND',
        command: customCommand,
        args: [],
        resumeArgs: [],
        source: 'custom',
      },
    ];
  }

  list(): HarnessProfile[] {
    return this.definitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      command: definition.command,
      args: definition.args,
      resumeArgs: definition.resumeArgs,
      available: this.isAvailable(definition),
      source: definition.source,
    }));
  }

  get(id: string): HarnessProfile {
    const profile = this.list().find((candidate) => candidate.id === id);
    if (!profile) throw new NestError('harness_not_found', `Unknown harness ${id}`);
    if (!profile.available) {
      throw new NestError(
        'harness_unavailable',
        `${profile.label} is not installed or its command was not found on PATH`,
      );
    }
    return profile;
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
      case 'fake':
        return true;
      default:
        return false;
    }
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
