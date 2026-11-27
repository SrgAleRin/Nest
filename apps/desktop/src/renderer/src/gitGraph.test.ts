import { describe, expect, it } from 'vitest';
import type { GitCommit } from '@nest/shared';
import { buildGitGraph, type GraphEdge, type GraphNode } from './gitGraph';

function commit(hash: string, parents: string[] = [], refs: string[] = []): GitCommit {
  return {
    hash,
    parents,
    authorName: 'Ada',
    authorEmail: 'ada@example.com',
    authoredAt: '2026-01-01T10:00:00.000Z',
    committedAt: '2026-01-01T10:00:00.000Z',
    subject: hash,
    body: '',
    refs,
  };
}

function row(graph: GraphNode[], hash: string): GraphNode {
  const node = graph.find((entry) => entry.hash === hash);
  if (!node) throw new Error(`no graph row for ${hash}`);
  return node;
}

function kinds(node: GraphNode, kind: GraphEdge['kind']): GraphEdge[] {
  return node.edges.filter((edge) => edge.kind === kind);
}

/** A row without the edges, for a compact whole-graph assertion. */
function plain(node: GraphNode): Record<string, unknown> {
  return {
    hash: node.hash,
    lane: node.lane,
    color: node.color,
    lanes: node.lanes,
    onHeadPath: node.onHeadPath,
    isHead: node.isHead,
    continuesBelow: node.continuesBelow,
  };
}

describe('git graph layout', () => {
  it('draws a linear history as a single lane', () => {
    const graph = buildGitGraph([commit('c3', ['c2']), commit('c2', ['c1']), commit('c1')], {
      headHash: 'c3',
    });

    expect(graph.map(plain)).toEqual([
      {
        hash: 'c3',
        lane: 0,
        color: 0,
        lanes: [0],
        onHeadPath: true,
        isHead: true,
        continuesBelow: [],
      },
      {
        hash: 'c2',
        lane: 0,
        color: 0,
        lanes: [0],
        onHeadPath: true,
        isHead: false,
        continuesBelow: [],
      },
      {
        hash: 'c1',
        lane: 0,
        color: 0,
        lanes: [0],
        onHeadPath: true,
        isHead: false,
        continuesBelow: [],
      },
    ]);

    // The tip opens the lane and its parent continues it.
    expect(row(graph, 'c3').edges).toEqual([
      { kind: 'outgoing', fromLane: 0, toLane: 0, color: 0 },
    ]);
    // The middle commit both receives the line from above and sends it on.
    expect(row(graph, 'c2').edges).toEqual([
      { kind: 'incoming', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'outgoing', fromLane: 0, toLane: 0, color: 0 },
    ]);
    // A root has nothing below it.
    expect(row(graph, 'c1').edges).toEqual([
      { kind: 'incoming', fromLane: 0, toLane: 0, color: 0 },
    ]);
  });

  it('gives two diverging branches their own lanes until they meet again', () => {
    const graph = buildGitGraph(
      [
        commit('b2', ['b1']),
        commit('a2', ['a1']),
        commit('b1', ['base']),
        commit('a1', ['base']),
        commit('base'),
      ],
      { headHash: 'b2' },
    );

    expect(graph.map((node) => [node.hash, node.lane, node.color])).toEqual([
      ['b2', 0, 0],
      ['a2', 1, 1],
      ['b1', 0, 0],
      ['a1', 1, 1],
      ['base', 0, 0],
    ]);
    // The second tip opens the lane next to the one that is already open.
    expect(row(graph, 'a2').lanes).toEqual([0, 1]);
    // The lane that is not this row's dot is a straight line through it.
    expect(kinds(row(graph, 'a2'), 'through')).toEqual([
      { kind: 'through', fromLane: 0, toLane: 0, color: 0 },
    ]);
    // `a1` joins the lane already waiting for the shared base: one line leaving
    // the dot to the left. The branch line does not continue below it.
    expect(row(graph, 'a1').edges).toEqual([
      { kind: 'through', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'incoming', fromLane: 1, toLane: 1, color: 1 },
      { kind: 'outgoing', fromLane: 1, toLane: 0, color: 0 },
    ]);
    expect(row(graph, 'base').edges).toEqual([
      { kind: 'incoming', fromLane: 0, toLane: 0, color: 0 },
    ]);
    // Only the branch `HEAD` points at is highlighted, its ancestors included.
    expect(graph.filter((node) => node.onHeadPath).map((node) => node.hash)).toEqual([
      'b2',
      'b1',
      'base',
    ]);
  });

  it('opens a lane per extra parent for a normal merge', () => {
    const graph = buildGitGraph(
      [commit('m', ['b1', 'a1']), commit('b1', ['base']), commit('a1', ['base']), commit('base')],
      { headHash: 'm' },
    );

    const merge = row(graph, 'm');
    expect(merge.lane).toBe(0);
    expect(merge.lanes).toEqual([0, 1]);
    // `parents[0]` keeps the dot's lane; the merged branch opens lane 1.
    expect(merge.edges).toEqual([
      { kind: 'outgoing', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'outgoing', fromLane: 0, toLane: 1, color: 1 },
    ]);

    // The merged commit joins the lane that waits for the shared base, and its
    // own lane is free again.
    expect(row(graph, 'a1').edges).toEqual([
      { kind: 'through', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'incoming', fromLane: 1, toLane: 1, color: 1 },
      { kind: 'outgoing', fromLane: 1, toLane: 0, color: 0 },
    ]);
    expect(row(graph, 'base').lanes).toEqual([0]);
    expect(graph.every((node) => node.onHeadPath)).toBe(true);
  });

  it('handles an octopus merge with three parents', () => {
    const graph = buildGitGraph(
      [
        commit('m', ['b1', 'c1', 'd1']),
        commit('b1', ['base']),
        commit('c1', ['base']),
        commit('d1', ['base']),
        commit('base'),
      ],
      { headHash: 'm' },
    );

    const merge = row(graph, 'm');
    expect(merge.lanes).toEqual([0, 1, 2]);
    expect(merge.edges).toEqual([
      { kind: 'outgoing', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'outgoing', fromLane: 0, toLane: 1, color: 1 },
      { kind: 'outgoing', fromLane: 0, toLane: 2, color: 2 },
    ]);
    expect(graph.map((node) => node.lane)).toEqual([0, 0, 1, 2, 0]);
    // `d1` still has the free `c1` lane on its left, and it is gone from the row.
    expect(row(graph, 'd1').lanes).toEqual([0, 2]);
    expect(kinds(row(graph, 'c1'), 'through')).toEqual([
      { kind: 'through', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'through', fromLane: 2, toLane: 2, color: 2 },
    ]);
    expect(row(graph, 'base').lanes).toEqual([0]);
  });

  it('lays out independent branch tips in whatever order the log returns them', () => {
    const tips = [
      commit('abc123', ['abc122'], ['nest/a']),
      commit('def456', ['def455'], ['nest/b']),
      commit('012abc', ['012abb'], ['origin/main']),
      commit('abc122'),
      commit('def455'),
      commit('012abb'),
    ];
    const graph = buildGitGraph(tips, { headHash: 'abc123' });

    expect(graph.slice(0, 3).map((node) => [node.hash, node.lane, node.color])).toEqual([
      ['abc123', 0, 0],
      ['def456', 1, 1],
      ['012abc', 2, 2],
    ]);
    // Every tip row shows all three lanes, its own included.
    expect(graph.slice(0, 3).map((node) => node.lanes)).toEqual([[0], [0, 1], [0, 1, 2]]);
    expect(row(graph, '012abc').edges).toEqual([
      { kind: 'through', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'through', fromLane: 1, toLane: 1, color: 1 },
      { kind: 'outgoing', fromLane: 2, toLane: 2, color: 2 },
    ]);
    // The trees are unrelated, so only `nest/a` is on the head path.
    expect(graph.filter((node) => node.onHeadPath).map((node) => node.hash)).toEqual([
      'abc123',
      'abc122',
    ]);
    expect(row(graph, 'def456').refs).toEqual(['nest/b']);

    // Another valid topological order: the same tree, the tips the other way
    // round, so the lanes are handed out in that order.
    const otherOrder = buildGitGraph(
      [
        commit('012abc', ['012abb'], ['origin/main']),
        commit('def456', ['def455'], ['nest/b']),
        commit('abc123', ['abc122'], ['nest/a']),
        commit('012abb'),
        commit('def455'),
        commit('abc122'),
      ],
      { headHash: 'abc123' },
    );
    expect(otherOrder.map((node) => [node.hash, node.lane, node.color])).toEqual([
      ['012abc', 0, 0],
      ['def456', 1, 1],
      ['abc123', 2, 2],
      ['012abb', 0, 0],
      ['def455', 1, 1],
      ['abc122', 2, 2],
    ]);
    expect(row(otherOrder, 'abc122').edges).toEqual([
      { kind: 'incoming', fromLane: 2, toLane: 2, color: 2 },
    ]);
  });

  it('reuses a lane freed by a root for the next tip', () => {
    const graph = buildGitGraph([
      commit('a2', ['a1']),
      commit('b2', ['b1']),
      commit('a1'),
      commit('c2', ['c1']),
      commit('b1'),
      commit('c1'),
    ]);

    expect(graph.map((node) => [node.hash, node.lane])).toEqual([
      ['a2', 0],
      ['b2', 1],
      ['a1', 0],
      ['c2', 0],
      ['b1', 1],
      ['c1', 0],
    ]);
    // `c2` is not the continuation of `a2`: the lane was free, so nothing comes
    // into its dot from above.
    expect(row(graph, 'c2').edges).toEqual([
      { kind: 'through', fromLane: 1, toLane: 1, color: 1 },
      { kind: 'outgoing', fromLane: 0, toLane: 0, color: 0 },
    ]);
  });

  it('marks the lanes still open at the end of a truncated page', () => {
    const page = [commit('m', ['b1', 'a1']), commit('b1', ['base'])];
    const truncated = buildGitGraph(page, { headHash: 'm', hasMore: true });
    const complete = buildGitGraph(page, { headHash: 'm' });

    expect(truncated[0]).toEqual(complete[0]);
    expect(row(truncated, 'b1').continuesBelow).toEqual([0, 1]);
    expect(row(complete, 'b1').continuesBelow).toEqual([]);
    // The marker does not invent lanes: this row still ends its own dot's lane
    // and passes the merged branch through.
    expect(row(truncated, 'b1').edges).toEqual([
      { kind: 'through', fromLane: 1, toLane: 1, color: 1 },
      { kind: 'incoming', fromLane: 0, toLane: 0, color: 0 },
      { kind: 'outgoing', fromLane: 0, toLane: 0, color: 0 },
    ]);
  });

  it('highlights nothing without a head, or when the head is off the page', () => {
    const graph = buildGitGraph([commit('c2', ['c1']), commit('c1')]);
    expect(graph.every((node) => !node.onHeadPath && !node.isHead)).toBe(true);

    const otherPage = buildGitGraph([commit('c2', ['c1']), commit('c1')], {
      headHash: 'elsewhere',
    });
    expect(otherPage.every((node) => !node.onHeadPath)).toBe(true);
    expect(otherPage.every((node) => !node.isHead)).toBe(true);
  });

  it('walks an arbitrarily deep head path without recursing', () => {
    const depth = 20000;
    const commits: GitCommit[] = [];
    for (let index = depth; index > 0; index -= 1) {
      commits.push(commit(`c${index}`, index === 1 ? [] : [`c${index - 1}`]));
    }

    const graph = buildGitGraph(commits, { headHash: `c${depth}` });

    expect(graph).toHaveLength(depth);
    expect(graph.every((node) => node.onHeadPath)).toBe(true);
    expect(graph.every((node) => node.lane === 0)).toBe(true);
    expect(graph[0]?.isHead).toBe(true);
  });

  it('has no rows for no commits', () => {
    expect(buildGitGraph([])).toEqual([]);
  });
});
