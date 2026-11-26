import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronIcon } from './Icons';

export interface PanelMenuItem {
  id: string;
  label: string;
  /** Second line in the menu, e.g. why an item is unavailable. */
  detail?: string;
  onSelect: () => void;
  disabled?: boolean;
  /** A remembered toggle such as `Amend`, shown with a check mark. */
  checked?: boolean;
  destructive?: boolean;
}

interface PanelMenuProps {
  /** Accessible name of the trigger; the visible glyph is `⋯`. */
  label: string;
  title?: string;
  items: PanelMenuItem[];
  /** Extra class for the trigger button. */
  className?: string;
  /** Side the menu opens to; `right` keeps it inside a narrow panel. */
  align?: 'left' | 'right';
  /** A menu at the bottom of the panel opens upwards. */
  placement?: 'down' | 'up';
}

/**
 * The `⋯` menu of a panel head or of the commit block. Opens on click, closes
 * on Escape, on a selection and on a click outside; Escape returns focus to the
 * trigger so the keyboard is never lost.
 */
export function PanelMenu({
  label,
  title,
  items,
  className = '',
  align = 'right',
  placement = 'down',
}: PanelMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  // The first enabled item takes the focus, so Enter works right after opening.
  useEffect(() => {
    if (!open) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    )
      return;
    const options = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    if (options.length === 0) return;
    event.preventDefault();
    const index = options.findIndex((option) => option === document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % options.length
            : (index - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <div className={`panel-menu ${className}`} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="mini-btn panel-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={title ?? label}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
        <ChevronIcon size={9} />
      </button>

      {open ? (
        <div
          className={`panel-menu-popup ${align === 'left' ? 'left' : ''} ${placement === 'up' ? 'up' : ''}`}
          id={menuId}
          role="menu"
          aria-label={label}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`panel-menu-item ${item.destructive ? 'destructive' : ''}`}
              disabled={item.disabled}
              aria-checked={item.checked === undefined ? undefined : item.checked}
              title={item.detail ?? item.label}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              <span className="panel-menu-check" aria-hidden="true">
                {item.checked ? '✓' : ''}
              </span>
              <span className="panel-menu-label">
                {item.label}
                {item.detail ? <em>{item.detail}</em> : null}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
