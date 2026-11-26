import { describe, expect, it } from 'vitest';
import { splitArgs } from '../src/harness/args.js';

describe('splitArgs', () => {
  it('splits words and keeps quoted groups together', () => {
    expect(splitArgs('--model "gpt 4" --verbose')).toEqual(['--model', 'gpt 4', '--verbose']);
  });

  it('supports single quotes and empty arguments', () => {
    expect(splitArgs("--label 'hello world' --empty \"\"")).toEqual([
      '--label',
      'hello world',
      '--empty',
      '',
    ]);
  });

  it('keeps Windows backslashes intact', () => {
    expect(splitArgs('--config C:\\Tools\\agent.json')).toEqual([
      '--config',
      'C:\\Tools\\agent.json',
    ]);
    expect(splitArgs('"C:\\Program Files\\Agent\\agent.exe" --flag')).toEqual([
      'C:\\Program Files\\Agent\\agent.exe',
      '--flag',
    ]);
  });

  it('returns no arguments for blank input', () => {
    expect(splitArgs('   ')).toEqual([]);
  });
});
