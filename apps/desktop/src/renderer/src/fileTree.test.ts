import { describe, expect, it } from 'vitest';
import { buildFileTree, type TreeDir, type TreeNode } from './fileTree';

interface Entry {
  path: string;
  marker?: string;
}

const entry = (path: string): Entry => ({ path });

function names(nodes: TreeNode<Entry>[]): string[] {
  return nodes.map((node) => (node.kind === 'dir' ? `${node.name}/` : node.name));
}

describe('buildFileTree', () => {
  it('nests files under directories and sorts directories first', () => {
    const tree = buildFileTree(
      [entry('README.md'), entry('src/b.ts'), entry('src/a.ts'), entry('src/nested/c.ts')],
      { compact: false },
    );

    expect(names(tree)).toEqual(['src/', 'README.md']);
    const src = tree[0] as TreeDir<Entry>;
    expect(names(src.children)).toEqual(['nested/', 'a.ts', 'b.ts']);
    expect(src.fileCount).toBe(3);
    expect((src.children[0] as TreeDir<Entry>).children[0]).toMatchObject({
      kind: 'file',
      path: 'src/nested/c.ts',
      name: 'c.ts',
    });
  });

  it('collapses single-child directory chains', () => {
    const tree = buildFileTree([
      entry('apps/desktop/src/main/index.ts'),
      entry('apps/desktop/src/main/ipc.ts'),
      entry('apps/web/index.ts'),
    ]);

    expect(names(tree)).toEqual(['apps/']);
    const apps = tree[0] as TreeDir<Entry>;
    // `apps` has two children, so only the chain below it collapses.
    expect(names(apps.children)).toEqual(['desktop/src/main/', 'web/']);
    const main = apps.children[0] as TreeDir<Entry>;
    expect(main.path).toBe('apps/desktop/src/main');
    expect(main.fileCount).toBe(2);
    expect(names(main.children)).toEqual(['index.ts', 'ipc.ts']);
  });

  it('keeps a chain apart when a directory has its own file', () => {
    const tree = buildFileTree([entry('src/index.ts'), entry('src/lib/util.ts')]);
    expect(names(tree)).toEqual(['src/']);
    const src = tree[0] as TreeDir<Entry>;
    expect(names(src.children)).toEqual(['lib/', 'index.ts']);
  });

  it('normalizes backslashes and ignores empty paths', () => {
    const tree = buildFileTree([entry('src\\main\\index.ts'), entry('')]);
    expect(tree).toHaveLength(1);
    const src = tree[0] as TreeDir<Entry>;
    expect(src.path).toBe('src/main');
  });
});
