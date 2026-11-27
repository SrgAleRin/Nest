import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, ChevronIcon } from '../Icons';

/** Space between the menu and the window edge, so a shadow is never clipped. */
const VIEWPORT_MARGIN = 8;
/** Assumed width of a submenu; it opens to the left when it would clip. */
const SUBMENU_WIDTH = 210;

export interface ContextMenuAction {
  /** Present only on separators; an action is the default kind. */
  kind?: 'item';
  label: string;
  icon?: ReactNode;
  /** Key hint shown on the right, e.g. `F2` or `Ctrl+N`. */
  shortcut?: string;
  /** Second line, e.g. why an item is unavailable. */
  detail?: string;
  /** Destructive action: red label, never focused by default. */
  danger?: boolean;
  disabled?: boolean;
  /** A remembered toggle such as `Pin` or a workflow status. */
  checked?: boolean;
  onSelect?: () => void;
  submenu?: ContextMenuItem[];
}

export interface ContextMenuSeparator {
  kind: 'separator';
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

export interface ContextMenuAnchor {
  x: number;
  y: number;
}

/**
 * Keeps a menu of `size` fully inside the viewport, whatever the anchor. A menu
 * that is larger than the window is pinned to the top-left margin instead of
 * being pushed off the far edge.
 */
export function clampMenuPosition(
  anchor: ContextMenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - size.width - VIEWPORT_MARGIN);
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - size.height - VIEWPORT_MARGIN);
  return {
    left: Math.min(Math.max(VIEWPORT_MARGIN, anchor.x), maxLeft),
    top: Math.min(Math.max(VIEWPORT_MARGIN, anchor.y), maxTop),
  };
}

interface ContextMenuProps {
  /** Viewport coordinates of the click that opened the menu. */
  anchor: ContextMenuAnchor;
  items: ContextMenuItem[];
  onClose: () => void;
  /** Accessible name of the menu. */
  label?: string;
}

/**
 * A floating menu anchored at a pointer position. It is portalled to the body
 * so a scrolling sidebar or a clipped card never cuts it off, and it is clamped
 * to the viewport so the last item stays reachable. Escape and a click outside
 * close it, arrows move between items, and a submenu opens on hover, click or
 * ArrowRight.
 */
export function ContextMenu({ anchor, items, onClose, label = 'Actions' }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setPosition(
      clampMenuPosition(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor.x, anchor.y, items.length]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return;
      // Capture: the menu owns Escape while it is open, before panels see it.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <MenuLevel
      items={items}
      onClose={onClose}
      label={label}
      className="context-menu"
      style={{ left: position.left, top: position.top }}
      autoFocus
      menuRef={(node) => {
        rootRef.current = node;
      }}
    />,
    document.body,
  );
}

interface MenuLevelProps {
  items: ContextMenuItem[];
  onClose: () => void;
  label: string;
  className: string;
  style?: CSSProperties;
  menuRef?: (node: HTMLDivElement | null) => void;
  /** Move the focus to the first item when the level mounts (a submenu). */
  autoFocus?: boolean;
  /** A nested level closes itself, not the whole menu. */
  onBack?: () => void;
}

/**
 * One level of the menu. A level renders its own items and, for an item with a
 * submenu, a nested level inside that item's wrapper: leaving the wrapper (not
 * the item alone) is what closes the submenu.
 */
function MenuLevel({
  items,
  onClose,
  label,
  className,
  style,
  menuRef,
  autoFocus = false,
  onBack,
}: MenuLevelProps) {
  const levelRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [focusSubmenu, setFocusSubmenu] = useState(false);
  const [openLeft, setOpenLeft] = useState(false);

  const enabledIndices = items.flatMap((item, index) =>
    item.kind === 'separator' || item.disabled ? [] : [index],
  );

  useEffect(() => {
    if (!autoFocus) return;
    const first = enabledIndices[0];
    if (first === undefined) return;
    buttonRefs.current[first]?.focus();
    // Only the first render of a level matters: focus is never stolen later.
  }, [autoFocus]);

  function openSubmenu(index: number, moveFocus: boolean): void {
    const rect = levelRef.current?.getBoundingClientRect();
    const right = rect ? rect.right : 0;
    setOpenLeft(right + SUBMENU_WIDTH > window.innerWidth - VIEWPORT_MARGIN);
    setOpenIndex(index);
    setFocusSubmenu(moveFocus);
  }

  function closeSubmenu(restoreFocus: boolean, index: number): void {
    setOpenIndex(null);
    setFocusSubmenu(false);
    if (restoreFocus) buttonRefs.current[index]?.focus();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (enabledIndices.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const current = buttonRefs.current.findIndex((button) => button === document.activeElement);
      const position = enabledIndices.indexOf(current);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next =
        position === -1
          ? event.key === 'ArrowDown'
            ? 0
            : enabledIndices.length - 1
          : (position + step + enabledIndices.length) % enabledIndices.length;
      const target = enabledIndices[next];
      if (target !== undefined) buttonRefs.current[target]?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (enabledIndices.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const target = enabledIndices[event.key === 'Home' ? 0 : enabledIndices.length - 1];
      if (target !== undefined) buttonRefs.current[target]?.focus();
      return;
    }
    if (event.key === 'ArrowRight') {
      const index = buttonRefs.current.findIndex((button) => button === document.activeElement);
      const item = index === -1 ? undefined : items[index];
      if (!item || item.kind === 'separator' || item.disabled) return;
      if (!item.submenu || item.submenu.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      openSubmenu(index, true);
      return;
    }
    if (event.key === 'ArrowLeft' && onBack) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }
  }

  return (
    <div
      className={className}
      role="menu"
      aria-label={label}
      ref={(node) => {
        levelRef.current = node;
        menuRef?.(node);
      }}
      style={style}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => {
        if (item.kind === 'separator') {
          return (
            <div className="context-menu-separator" role="separator" key={`separator-${index}`} />
          );
        }
        const submenu = item.submenu ?? [];
        const hasSubmenu = submenu.length > 0;
        const open = openIndex === index;
        return (
          <div
            className="context-menu-item-wrap"
            key={`${item.label}-${index}`}
            onMouseEnter={() => {
              if (item.disabled) return;
              if (hasSubmenu) openSubmenu(index, false);
              else {
                setOpenIndex(null);
                setFocusSubmenu(false);
              }
            }}
          >
            <button
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              aria-haspopup={hasSubmenu ? 'menu' : undefined}
              aria-expanded={hasSubmenu ? open : undefined}
              className={[
                'context-menu-item',
                item.danger ? 'danger' : '',
                item.disabled ? 'disabled' : '',
                open ? 'open' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              disabled={item.disabled}
              title={item.detail ?? item.label}
              ref={(node) => {
                buttonRefs.current[index] = node;
              }}
              onClick={() => {
                if (item.disabled) return;
                if (hasSubmenu) {
                  if (open) closeSubmenu(false, index);
                  else openSubmenu(index, false);
                  return;
                }
                onClose();
                item.onSelect?.();
              }}
            >
              <span className="context-menu-icon" aria-hidden="true">
                {item.icon ?? (item.checked ? <CheckIcon size={12} /> : null)}
              </span>
              <span className="context-menu-text">
                <span className="context-menu-label">{item.label}</span>
                {item.detail ? <span className="context-menu-detail">{item.detail}</span> : null}
              </span>
              {item.shortcut ? (
                <span className="context-menu-shortcut">{item.shortcut}</span>
              ) : null}
              {hasSubmenu ? (
                <span className="context-menu-arrow" aria-hidden="true">
                  <ChevronIcon size={11} />
                </span>
              ) : null}
            </button>

            {hasSubmenu && open ? (
              <MenuLevel
                items={submenu}
                onClose={onClose}
                label={item.label}
                className="context-menu-submenu"
                style={openLeft ? { right: '100%' } : { left: '100%' }}
                autoFocus={focusSubmenu}
                onBack={() => closeSubmenu(true, index)}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
