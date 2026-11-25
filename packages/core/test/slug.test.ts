import { describe, expect, it } from 'vitest';
import { slugify } from '@nest/shared';

describe('slugify', () => {
  it('keeps latin text', () => {
    expect(slugify('Fix terminal reconnect')).toBe('fix-terminal-reconnect');
  });

  it('transliterates cyrillic', () => {
    expect(slugify('Починить переподключение терминала')).toBe(
      'pochinit-perepodklyuchenie-terminala',
    );
  });

  it('trims separators and falls back', () => {
    expect(slugify('   ***   ')).toBe('task');
    expect(slugify('a'.repeat(100))).toHaveLength(48);
  });
});
