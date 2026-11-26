import { describe, expect, it } from 'vitest';
import { parseBranches, parseTrack } from '../src/git/branches.js';
import { parseNameStatus, toCompareFiles } from '../src/git/compare.js';
import { parseLog } from '../src/git/log.js';
import { assertRef, parseRefDecorations } from '../src/git/refs.js';
import { parseStatus } from '../src/git/status.js';

const RS = '\u001e';

function logRecord(fields: string[]): string {
  return `${fields.join('\u0000')}${RS}\n`;
}

describe('parseLog', () => {
  it('reads every field, parents and refs of a commit', () => {
    const raw = logRecord([
      'a'.repeat(40),
      `${'b'.repeat(40)} ${'c'.repeat(40)}`,
      'Nest Author',
      'nest@example.com',
      '2026-01-02T03:04:05+03:00',
      '2026-01-02T03:04:06+03:00',
      'HEAD -> main, origin/main, tag: v1.0',
      'feat: add history',
      'Body line one\nBody line two\n',
    ]);

    const commits = parseLog(raw);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      hash: 'a'.repeat(40),
      parents: ['b'.repeat(40), 'c'.repeat(40)],
      authorName: 'Nest Author',
      authorEmail: 'nest@example.com',
      authoredAt: '2026-01-02T03:04:05+03:00',
      committedAt: '2026-01-02T03:04:06+03:00',
      subject: 'feat: add history',
      body: 'Body line one\nBody line two',
      refs: ['main', 'origin/main', 'tag: v1.0'],
    });
  });

  it('keeps multiple commits apart and tolerates the trailing separator', () => {
    const raw =
      logRecord([
        '1'.repeat(40),
        '',
        'A',
        'a@x',
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z',
        '',
        'first',
        '',
      ]) +
      logRecord([
        '2'.repeat(40),
        '1'.repeat(40),
        'B',
        'b@x',
        '2026-01-02T00:00:00Z',
        '2026-01-02T00:00:00Z',
        'main',
        'second',
        '',
      ]) +
      '\n';

    const commits = parseLog(raw);
    expect(commits.map((commit) => commit.subject)).toEqual(['first', 'second']);
    expect(commits[0]?.parents).toEqual([]);
    expect(commits[1]?.refs).toEqual(['main']);
  });
});

describe('parseRefDecorations', () => {
  it('drops the HEAD arrow and keeps tags and remote refs', () => {
    expect(parseRefDecorations('HEAD -> main, origin/main, tag: v2')).toEqual([
      'main',
      'origin/main',
      'tag: v2',
    ]);
    expect(parseRefDecorations('')).toEqual([]);
  });
});

describe('assertRef', () => {
  it('accepts branch names, remote refs and hashes', () => {
    for (const value of ['main', 'origin/main', 'nest/task-1', 'v1.2.3', 'a'.repeat(40)]) {
      expect(assertRef(value)).toBe(value);
    }
  });

  it('rejects ranges, option lookalikes and traversal', () => {
    for (const value of ['', '-x', 'main..dev', 'main@{1}', 'a//b', 'branch/', 'x.lock', '..']) {
      expect(() => assertRef(value), value).toThrowError(/Invalid/);
    }
  });
});

describe('branches', () => {
  it('parses ahead/behind and gone upstreams', () => {
    expect(parseTrack('[ahead 2, behind 1]')).toEqual({ ahead: 2, behind: 1, gone: false });
    expect(parseTrack('[ahead 3]')).toEqual({ ahead: 3, behind: 0, gone: false });
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false });
  });

  it('separates local and remote branches and skips symbolic refs', () => {
    const raw = [
      [
        'refs/heads/main',
        'hash-main',
        'origin/main',
        '[ahead 1]',
        '2026-01-01T00:00:00+00:00',
        'init',
        '*',
        '',
      ].join('\u0000'),
      [
        'refs/remotes/origin/main',
        'hash-main',
        '',
        '',
        '2026-01-01T00:00:00+00:00',
        'init',
        ' ',
        '',
      ].join('\u0000'),
      [
        'refs/remotes/origin/HEAD',
        'hash-main',
        '',
        '',
        '',
        '',
        ' ',
        'refs/remotes/origin/main',
      ].join('\u0000'),
    ].join('\n');

    const branches = parseBranches(raw);
    expect(branches).toHaveLength(2);
    expect(branches[0]).toMatchObject({
      name: 'main',
      remote: false,
      current: true,
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      tip: 'hash-main',
    });
    expect(branches[1]).toMatchObject({ name: 'origin/main', remote: true, current: false });
  });
});

describe('compare files', () => {
  it('parses name-status records and joins them with numstat', () => {
    const raw = [
      'M',
      'src/a.ts',
      'A',
      'src/b.ts',
      'R100',
      'old.ts',
      'new.ts',
      'D',
      'gone.ts',
      '',
    ].join('\u0000');
    const entries = parseNameStatus(raw);
    expect(entries).toEqual([
      { path: 'src/a.ts', oldPath: null, status: 'modified' },
      { path: 'src/b.ts', oldPath: null, status: 'added' },
      { path: 'new.ts', oldPath: 'old.ts', status: 'renamed' },
      { path: 'gone.ts', oldPath: null, status: 'deleted' },
    ]);

    const files = toCompareFiles(entries, new Map([['src/a.ts', { additions: 3, deletions: 1 }]]));
    expect(files[0]).toMatchObject({ path: 'src/a.ts', additions: 3, deletions: 1 });
    expect(files[1]).toMatchObject({ path: 'src/b.ts', additions: null, deletions: null });
  });
});

describe('parseStatus', () => {
  it('keeps the source path of renames and copies apart', () => {
    const raw = [
      '## main...origin/main [ahead 1, behind 2]',
      'R  renamed.txt',
      'original.txt',
      'C  copy.txt',
      'source.txt',
      ' M edited.txt',
      '',
    ].join('\u0000');

    const parsed = parseStatus(raw);
    expect(parsed).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 1,
      behind: 2,
    });
    const byPath = new Map(parsed.files.map((file) => [file.path, file]));
    expect(byPath.get('renamed.txt')).toMatchObject({
      oldPath: 'original.txt',
      copied: false,
      indexStatus: 'R',
      staged: true,
    });
    expect(byPath.get('copy.txt')).toMatchObject({
      oldPath: 'source.txt',
      copied: true,
      indexStatus: 'C',
      staged: true,
    });
    expect(byPath.get('edited.txt')).toMatchObject({
      oldPath: null,
      copied: false,
      untracked: false,
    });
    expect(parsed.files).toHaveLength(3);
  });

  it('reads a worktree-side rename and plain changes', () => {
    const raw = [
      '## HEAD (no branch)',
      ' R moved.txt',
      'was.txt',
      '?? untracked.md',
      ' D gone.txt',
      ' M modified.txt',
      '',
    ].join('\u0000');

    const parsed = parseStatus(raw);
    expect(parsed).toMatchObject({ branch: 'HEAD', upstream: null, ahead: 0, behind: 0 });
    const byPath = new Map(parsed.files.map((file) => [file.path, file]));
    expect(byPath.get('moved.txt')).toMatchObject({
      oldPath: 'was.txt',
      copied: false,
      worktreeStatus: 'R',
    });
    expect(byPath.get('untracked.md')).toMatchObject({ untracked: true, staged: false });
    expect(byPath.get('gone.txt')).toMatchObject({ worktreeStatus: 'D', untracked: false });
    expect(parsed.files).toHaveLength(4);
  });

  it('reads the branch of an unborn repository', () => {
    const parsed = parseStatus(['## No commits yet on main', 'A  first.txt', ''].join('\u0000'));
    expect(parsed).toMatchObject({ branch: 'main', upstream: null });
    expect(parsed.files[0]).toMatchObject({
      path: 'first.txt',
      indexStatus: 'A',
      staged: true,
      unstaged: false,
      conflict: false,
    });
  });

  it('treats every unmerged pair as a conflict that is neither staged nor unstaged', () => {
    const pairs = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
    const raw = ['## main', ...pairs.map((pair) => `${pair} ${pair.toLowerCase()}.txt`), ''].join(
      '\u0000',
    );

    const parsed = parseStatus(raw);

    expect(parsed.files.map((file) => file.path)).toEqual(
      pairs.map((pair) => `${pair.toLowerCase()}.txt`),
    );
    for (const file of parsed.files) {
      expect(file).toMatchObject({
        conflict: true,
        staged: false,
        unstaged: false,
        untracked: false,
      });
    }
  });
});
