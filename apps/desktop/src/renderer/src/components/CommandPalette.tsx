import { useEffect, useMemo, useRef, useState } from 'react';
import { filterCommands, type CommandItem } from '../commands';

interface CommandPaletteProps {
  items: CommandItem[];
  onClose: () => void;
}

const KIND_LABEL: Record<CommandItem['kind'], string> = {
  task: 'task',
  session: 'session',
  harness: 'harness',
  action: 'action',
};

export function CommandPalette({ items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => filterCommands(items, query), [items, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (item: CommandItem | undefined): void => {
    if (!item) return;
    // Close before running: actions may open another modal or replace focus.
    onClose();
    item.run();
  };

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={onClose}>
      <div
        className="modal command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-search">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (filtered.length > 0) setActive((current) => (current + 1) % filtered.length);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                if (filtered.length > 0) {
                  setActive((current) => (current - 1 + filtered.length) % filtered.length);
                }
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(filtered[active]);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder="Type a task, session or action…"
            aria-label="Command"
            spellCheck={false}
          />
          <kbd>Ctrl+Shift+P</kbd>
        </div>

        <div className="palette-list" ref={listRef} role="listbox" aria-label="Commands">
          {filtered.length === 0 ? (
            <div className="palette-empty">No commands match “{query.trim()}”.</div>
          ) : (
            filtered.map((item, index) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`palette-item ${index === active ? 'active' : ''}`}
                onMouseMove={() => setActive(index)}
                onClick={() => run(item)}
              >
                <span className="palette-item-title">{item.title}</span>
                {item.detail ? <span className="palette-item-detail">{item.detail}</span> : null}
                <span className="palette-kind">{KIND_LABEL[item.kind]}</span>
              </button>
            ))
          )}
        </div>

        <div className="palette-foot">
          <span>↑↓ navigate</span>
          <span>Enter run</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
