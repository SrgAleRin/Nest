import { describe, expect, it } from 'vitest';
import { buildUntrackedDiff, parseUnifiedDiff } from '../src/git/diff.js';

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
