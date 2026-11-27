import { describe, expect, it } from 'vitest';
import { buildWindowsConptyLaunch } from '../src/services/sessions.js';

describe('windows conpty launch', () => {
  it('switches the console to UTF-8 before starting the harness', () => {
    const launch = buildWindowsConptyLaunch('pwsh.exe', []);
    expect(launch.cmdArgs).toEqual(['/d', '/s', '/c', 'chcp 65001 >nul & %NEST_LAUNCH%']);
    expect(launch.commandLine).toBe('pwsh.exe');
  });

  it('keeps arguments separate and unquoted when they need no quoting', () => {
    const launch = buildWindowsConptyLaunch('claude.cmd', ['--model', 'opus']);
    expect(launch.commandLine).toBe('claude.cmd --model opus');
  });

  it('quotes paths and arguments with spaces', () => {
    const launch = buildWindowsConptyLaunch(String.raw`C:\Program Files\Nest\agent.exe`, [
      '--cwd',
      String.raw`C:\user name\project`,
    ]);
    expect(launch.commandLine).toBe(
      String.raw`"C:\Program Files\Nest\agent.exe" --cwd "C:\user name\project"`,
    );
  });

  it('escapes embedded double quotes by doubling them', () => {
    const launch = buildWindowsConptyLaunch('agent.exe', ['--prompt', 'say "hi"']);
    expect(launch.commandLine).toBe('agent.exe --prompt "say ""hi"""');
  });

  it('handles Cyrillic paths without mangling them', () => {
    const launch = buildWindowsConptyLaunch(String.raw`C:\Проекты\агент.exe`, [
      '--dir',
      String.raw`C:\Проекты\новый проект`,
    ]);
    expect(launch.commandLine).toBe(
      String.raw`C:\Проекты\агент.exe --dir "C:\Проекты\новый проект"`,
    );
  });
});
