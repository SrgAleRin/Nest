import { describe, expect, it } from 'vitest';
import { filterCommands, scoreMatch, type CommandItem } from './commands';

function item(overrides: Partial<CommandItem> & { title: string }): CommandItem {
  return { id: overrides.title, kind: 'action', run: () => {}, ...overrides };
}

describe('command matching', () => {
  it('ranks prefixes above substrings and subsequences', () => {
    const prefix = scoreMatch('set', 'Settings');
    const substring = scoreMatch('set', 'Reset workspace');
    const subsequence = scoreMatch('set', 'Show extension tasks');
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
    expect(subsequence).toBeGreaterThan(0);
  });

  it('is case insensitive and returns zero without a match', () => {
    expect(scoreMatch('DIFF', 'Show Diff panel')).toBeGreaterThan(0);
    expect(scoreMatch('zzz', 'Show Diff panel')).toBe(0);
  });

  it('keeps the original order for an empty query', () => {
    const items = [item({ title: 'One' }), item({ title: 'Two' })];
    expect(filterCommands(items, '   ')).toEqual(items);
  });

  it('matches detail and hidden keywords', () => {
    const items = [
      item({ title: 'Start Fake harness', detail: 'main checkout', kind: 'harness' }),
      item({ title: 'Settings', keywords: 'preferences config' }),
    ];
    expect(filterCommands(items, 'main')[0]?.title).toBe('Start Fake harness');
    expect(filterCommands(items, 'preferences')[0]?.title).toBe('Settings');
  });

  it('drops commands that do not match', () => {
    const items = [item({ title: 'Settings' }), item({ title: 'Show Diff panel' })];
    expect(filterCommands(items, 'zzz')).toEqual([]);
  });
});
