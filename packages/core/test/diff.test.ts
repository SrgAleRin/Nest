import { describe, expect, it } from 'vitest';
import { buildUntrackedDiff, decodeGitPath, parseUnifiedDiff } from '../src/git/diff.js';

const sample = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@ export function main() {
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };

diff --git a/docs/new.md b/docs/new.md
new file mode 100644
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+hello
+world

diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`;

describe('parseUnifiedDiff', () => {
  it('parses files, statuses and line numbers', () => {
    const files = parseUnifiedDiff(sample);
    expect(files).toHaveLength(3);

    const [modified, added, deleted] = files;
    expect(modified?.path).toBe('src/app.ts');
    expect(modified?.status).toBe('modified');
    expect(modified?.additions).toBe(2);
    expect(modified?.deletions).toBe(1);
    expect(modified?.hunks[0]?.section).toBe('export function main() {');
    expect(modified?.hunks[0]?.lines).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'const a = 1;' },
      { type: 'del', oldLine: 2, newLine: null, text: 'const b = 2;' },
      { type: 'add', oldLine: null, newLine: 2, text: 'const b = 3;' },
      { type: 'add', oldLine: null, newLine: 3, text: 'const c = 4;' },
      { type: 'context', oldLine: 3, newLine: 4, text: 'export { a };' },
    ]);

    expect(added?.status).toBe('added');
    expect(added?.path).toBe('docs/new.md');
    expect(added?.hunks[0]?.lines.map((line) => line.text)).toEqual(['hello', 'world']);

    expect(deleted?.status).toBe('deleted');
    expect(deleted?.path).toBe('old.txt');
    expect(deleted?.deletions).toBe(1);
  });

  it('builds a synthetic diff for untracked files', () => {
    const file = buildUntrackedDiff('notes/todo.md', 'one\ntwo\n');
    expect(file.status).toBe('added');
    expect(file.additions).toBe(2);
    expect(file.hunks[0]?.lines[1]).toEqual({
      type: 'add',
      oldLine: null,
      newLine: 2,
      text: 'two',
    });
  });
});

// Real `git diff --no-color -M --unified=3 --src-prefix=a/ --dst-prefix=b/` output.
const headerLikeContent = `diff --git a/headers.txt b/headers.txt
index 29f9b05..c1183af 100644
--- a/headers.txt
+++ b/headers.txt
@@ -1,4 +1,4 @@
 intro
---- before
-+++ after
+--- changed before
++++ changed after
 outro
`;

const cyrillicSpaced = String.raw`diff --git "a/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt" "b/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt"
index 587be6b..975fbec 100644
--- "a/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt"
+++ "b/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt"
@@ -1 +1 @@
-x
+y
`;

const unquotedSpaced = `diff --git a/my file.txt b/my file.txt
index 814f4a4..879de50 100644
--- a/my file.txt
+++ b/my file.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
`;

const binaryQuoted = String.raw`diff --git "a/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.bin" "b/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.bin"
index bdc955b..8835708 100644
Binary files "a/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.bin" and "b/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.bin" differ
`;

const binaryAdded = `diff --git a/new file.bin b/new file.bin
new file mode 100644
index 0000000..8835708
Binary files /dev/null and b/new file.bin differ
`;

const binaryDeleted = `diff --git a/new file.bin b/new file.bin
deleted file mode 100644
index 8835708..0000000
Binary files a/new file.bin and /dev/null differ
`;

const modeOnly = String.raw`diff --git "a/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt" "b/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt"
old mode 100644
new mode 100755
`;

const rename = String.raw`diff --git "a/\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt" "b/\320\275\320\276\320\262\321\213\320\271 \321\204\320\260\320\271\320\273.txt"
similarity index 100%
rename from "\321\204\320\260\320\271\320\273 \321\201 \320\277\321\200\320\276\320\261\320\265\320\273\320\260\320\274\320\270.txt"
rename to "\320\275\320\276\320\262\321\213\320\271 \321\204\320\260\320\271\320\273.txt"
`;

const partlyStagedIndex = `diff --git a/mixed.txt b/mixed.txt
index 29f9b05..c1183af 100644
--- a/mixed.txt
+++ b/mixed.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

const partlyStagedWorktree = `diff --git a/mixed.txt b/mixed.txt
index c1183af..6add8f1 100644
--- a/mixed.txt
+++ b/mixed.txt
@@ -1,3 +1,4 @@
 one
 TWO
 three
+four
`;

const noNewlineAtEof = `diff --git a/noeol.txt b/noeol.txt
index 9ed40b4..530cc72 100644
--- a/noeol.txt
+++ b/noeol.txt
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+TWO
\\ No newline at end of file
`;

describe('parseUnifiedDiff real diffs', () => {
  it('keeps content lines that look like headers inside a hunk', () => {
    const [file] = parseUnifiedDiff(headerLikeContent);
    expect(file?.path).toBe('headers.txt');
    expect(file?.oldPath).toBe('headers.txt');
    expect(file?.status).toBe('modified');
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(2);
    expect(file?.hunks).toHaveLength(1);
    expect(file?.hunks[0]?.lines).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'intro' },
      { type: 'del', oldLine: 2, newLine: null, text: '--- before' },
      { type: 'del', oldLine: 3, newLine: null, text: '+++ after' },
      { type: 'add', oldLine: null, newLine: 2, text: '--- changed before' },
      { type: 'add', oldLine: null, newLine: 3, text: '+++ changed after' },
      { type: 'context', oldLine: 4, newLine: 4, text: 'outro' },
    ]);
  });

  it('decodes Git-quoted Cyrillic and spaced paths', () => {
    const [file] = parseUnifiedDiff(cyrillicSpaced);
    expect(file?.path).toBe('файл с пробелами.txt');
    expect(file?.oldPath).toBe('файл с пробелами.txt');
    expect(file?.status).toBe('modified');
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.header).toBe('@@ -1 +1 @@');
    expect(file?.hunks[0]?.lines).toEqual([
      { type: 'del', oldLine: 1, newLine: null, text: 'x' },
      { type: 'add', oldLine: null, newLine: 1, text: 'y' },
    ]);
  });

  it('keeps unquoted paths with spaces', () => {
    const [file] = parseUnifiedDiff(unquotedSpaced);
    expect(file?.path).toBe('my file.txt');
    expect(file?.oldPath).toBe('my file.txt');
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.lines[0]).toEqual({
      type: 'context',
      oldLine: 1,
      newLine: 1,
      text: 'one',
    });
  });

  it('reports binary files with quoted paths instead of dropping them', () => {
    const files = parseUnifiedDiff(binaryQuoted);
    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file?.path).toBe('файл с пробелами.bin');
    expect(file?.binary).toBe(true);
    expect(file?.modeChanged).toBe(false);
    expect(file?.hunks).toEqual([]);
    expect(file?.additions).toBe(0);
    expect(file?.deletions).toBe(0);
  });

  it('reports added and deleted binary files', () => {
    const [added] = parseUnifiedDiff(binaryAdded);
    expect(added?.path).toBe('new file.bin');
    expect(added?.status).toBe('added');
    expect(added?.binary).toBe(true);
    expect(added?.oldPath).toBeNull();

    const [deleted] = parseUnifiedDiff(binaryDeleted);
    expect(deleted?.path).toBe('new file.bin');
    expect(deleted?.status).toBe('deleted');
    expect(deleted?.binary).toBe(true);
  });

  it('reports mode-only changes', () => {
    const [file] = parseUnifiedDiff(modeOnly);
    expect(file?.path).toBe('файл с пробелами.txt');
    expect(file?.status).toBe('modified');
    expect(file?.modeChanged).toBe(true);
    expect(file?.binary).toBe(false);
    expect(file?.hunks).toEqual([]);
    expect(file?.additions).toBe(0);
    expect(file?.deletions).toBe(0);
  });

  it('reports renames with both paths', () => {
    const [file] = parseUnifiedDiff(rename);
    expect(file?.status).toBe('renamed');
    expect(file?.path).toBe('новый файл.txt');
    expect(file?.oldPath).toBe('файл с пробелами.txt');
    expect(file?.hunks).toEqual([]);
  });

  it('parses a partly staged file on both sides', () => {
    const [stagedFile] = parseUnifiedDiff(partlyStagedIndex, { staged: true });
    expect(stagedFile?.path).toBe('mixed.txt');
    expect(stagedFile?.staged).toBe(true);
    expect(stagedFile?.additions).toBe(1);
    expect(stagedFile?.deletions).toBe(1);
    expect(stagedFile?.hunks[0]?.lines).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'one' },
      { type: 'del', oldLine: 2, newLine: null, text: 'two' },
      { type: 'add', oldLine: null, newLine: 2, text: 'TWO' },
      { type: 'context', oldLine: 3, newLine: 3, text: 'three' },
    ]);

    const [worktreeFile] = parseUnifiedDiff(partlyStagedWorktree);
    expect(worktreeFile?.path).toBe('mixed.txt');
    expect(worktreeFile?.staged).toBe(false);
    expect(worktreeFile?.additions).toBe(1);
    expect(worktreeFile?.deletions).toBe(0);
    expect(worktreeFile?.hunks[0]?.lines).toEqual([
      { type: 'context', oldLine: 1, newLine: 1, text: 'one' },
      { type: 'context', oldLine: 2, newLine: 2, text: 'TWO' },
      { type: 'context', oldLine: 3, newLine: 3, text: 'three' },
      { type: 'add', oldLine: null, newLine: 4, text: 'four' },
    ]);
  });

  it('keeps no-newline meta lines inside the hunk', () => {
    const [file] = parseUnifiedDiff(noNewlineAtEof);
    expect(file?.additions).toBe(1);
    expect(file?.deletions).toBe(1);
    expect(file?.hunks[0]?.lines.map((line) => line.type)).toEqual([
      'context',
      'del',
      'meta',
      'add',
      'meta',
    ]);
    expect(file?.hunks[0]?.lines[2]).toEqual({
      type: 'meta',
      oldLine: null,
      newLine: null,
      text: '\\ No newline at end of file',
    });
  });

  it('keeps every file from a multi-file diff', () => {
    const files = parseUnifiedDiff(
      [
        headerLikeContent,
        cyrillicSpaced,
        unquotedSpaced,
        binaryQuoted,
        binaryAdded,
        binaryDeleted,
        modeOnly,
        rename,
      ].join(''),
    );
    expect(files.map((file) => file.path)).toEqual([
      'headers.txt',
      'файл с пробелами.txt',
      'my file.txt',
      'файл с пробелами.bin',
      'new file.bin',
      'new file.bin',
      'файл с пробелами.txt',
      'новый файл.txt',
    ]);
    expect(files.every((file) => file.path.length > 0)).toBe(true);
  });

  it('round-trips a synthetic diff for a quoted path', () => {
    const file = buildUntrackedDiff('файл с пробелами.txt', 'one\ntwo\n');
    expect(file.raw).toContain('"a/\\321');
    const [parsed] = parseUnifiedDiff(file.raw);
    expect(parsed?.path).toBe('файл с пробелами.txt');
    expect(parsed?.status).toBe('added');
    expect(parsed?.additions).toBe(2);
  });
});

describe('decodeGitPath', () => {
  it('decodes octal escapes and drops the timestamp tab', () => {
    expect(decodeGitPath('"a/\\321\\204\\320\\260\\320\\271\\320\\273.txt"\t')).toBe(
      'a/файл.txt',
    );
    expect(decodeGitPath('a/my file.txt\t')).toBe('a/my file.txt');
    expect(decodeGitPath('"a/quote\\"name.txt"')).toBe('a/quote"name.txt');
  });
});
