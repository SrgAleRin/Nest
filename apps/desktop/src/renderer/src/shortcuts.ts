/**
 * Global keyboard shortcuts (product §7: `Ctrl+Shift+P`, `Ctrl+N`, `Ctrl+`,
 * `Ctrl+W`, `Ctrl+Tab`).
 *
 * The terminal keeps the keys a shell needs: while focus is inside a terminal,
 * `Ctrl+N` (history-next), `Ctrl+W` (kill-word) and `Ctrl+B` (readline `backward-char`,
 * tmux prefix) are sent to the PTY instead of being stolen. `Ctrl+Tab`, `Ctrl+``
 * and `Ctrl+Shift+B` are not shell bindings, so they work everywhere, like
 * `Ctrl+Shift+P`.
 */

export type Shortcut =
  | 'palette'
  | 'new-task'
  | 'close-tab'
  | 'next-tab'
  | 'previous-tab'
  | 'focus-terminal'
  | 'toggle-left-panel';

export interface ShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutContext {
  /** Focus is inside a terminal, so shell bindings win. */
  terminalFocused: boolean;
}

/** The shortcut this key event triggers, or null when it belongs elsewhere. */
export function resolveShortcut(event: ShortcutEvent, context: ShortcutContext): Shortcut | null {
  if (event.altKey) return null;
  if (!(event.ctrlKey || event.metaKey)) return null;

  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    if (key === 'p') return 'palette';
    if (key === 'tab') return 'previous-tab';
    // `Ctrl+Shift+B` belongs to no shell, so the sidebar toggles even in a terminal.
    if (key === 'b') return 'toggle-left-panel';
    return null;
  }

  switch (key) {
    case 'tab':
      return 'next-tab';
    case '`':
      return 'focus-terminal';
    case 'n':
      return context.terminalFocused ? null : 'new-task';
    case 'w':
      return context.terminalFocused ? null : 'close-tab';
    case 'b':
      return context.terminalFocused ? null : 'toggle-left-panel';
    default:
      return null;
  }
}
