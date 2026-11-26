import { describe, expect, it } from 'vitest';
import { resolveShortcut, type ShortcutEvent } from './shortcuts';

function key(overrides: Partial<ShortcutEvent>): ShortcutEvent {
  return { key: '', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, ...overrides };
}

const away = { terminalFocused: false };
const inTerminal = { terminalFocused: true };

describe('shortcuts', () => {
  it('opens the palette on Ctrl+Shift+P from anywhere, including a terminal', () => {
    expect(resolveShortcut(key({ key: 'P', shiftKey: true }), inTerminal)).toBe('palette');
    expect(resolveShortcut(key({ key: 'p', shiftKey: true }), away)).toBe('palette');
  });

  it('creates tasks and closes tabs only when the shell does not own the key', () => {
    expect(resolveShortcut(key({ key: 'n' }), away)).toBe('new-task');
    expect(resolveShortcut(key({ key: 'w' }), away)).toBe('close-tab');
    // Bash uses both: history-next and kill-word must reach the PTY.
    expect(resolveShortcut(key({ key: 'n' }), inTerminal)).toBeNull();
    expect(resolveShortcut(key({ key: 'w' }), inTerminal)).toBeNull();
  });

  it('cycles tabs in both directions, from anywhere', () => {
    expect(resolveShortcut(key({ key: 'Tab' }), inTerminal)).toBe('next-tab');
    expect(resolveShortcut(key({ key: 'Tab', shiftKey: true }), inTerminal)).toBe('previous-tab');
  });

  it('focuses the terminal on Ctrl+` and ignores other modifiers', () => {
    expect(resolveShortcut(key({ key: '`' }), away)).toBe('focus-terminal');
    expect(resolveShortcut(key({ key: '`', altKey: true }), away)).toBeNull();
    expect(resolveShortcut(key({ key: '`', ctrlKey: false }), away)).toBeNull();
    expect(resolveShortcut(key({ key: 'x' }), away)).toBeNull();
  });
});
