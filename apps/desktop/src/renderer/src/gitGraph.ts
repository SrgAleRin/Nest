import type { GitCommit } from '@nest/shared';

/**
 * What a row has to draw between its top and its bottom edge:
 *
 * - `through`: a lane that crosses the row untouched — it waits for a commit
 *   further down and has nothing to do with this row's dot;
 * - `incoming`: a line from the top edge into the dot. The dot's own lane is
 *   one of them, and so is every duplicate lane whose expected commit is this
 *   dot (a merge collapses several lanes into one row);
 * - `outgoing`: a line from the dot out of the bottom edge. `parents[0]`
 *   continues the dot's lane; the other parents of a merge, and the lane a
 *   branch tip opens, are separate outgoing lines.
 *
 * Lanes are 0-based columns from the left; a row is a whole grid cell tall, so
 * a renderer draws `fromLane` at the top edge and `toLane` at the bottom edge
 * and never has to look at its neighbours to know where a line goes.
 */
export type GraphEdgeKind = 'through' | 'incoming' | 'outgoing';

export interface GraphEdge {
  kind: GraphEdgeKind;
  /** Lane at the row's top edge; the dot's lane for an `outgoing` line. */
  fromLane: number;
  /** Lane at the row's bottom edge; the dot's lane for an `incoming` line. */
  toLane: number;
  /**
   * Colour index of the line: the colour of the lane it belongs to, which for
   * an `outgoing` line is the lane it lands in.
   */
  color: number;
}

/** One commit as the virtualized list draws it. */
export interface GraphNode {
  hash: string;
  /** Column of the commit dot. */
  lane: number;
  /** Colour index of the dot and of the lane it continues below the row. */
  color: number;
  /** Lanes alive on this row, left to right; `edges` touches nothing outside. */
  lanes: number[];
  /** `through` lines left to right, then `incoming` left to right, then `outgoing` in parent order. */
  edges: GraphEdge[];
  /** Parents as Git reported them, for a tooltip or a walk the caller needs. */
  parents: string[];
  /** Branch, remote and tag badges of the commit. */
  refs: string[];
  /** Reachable from `headHash` by following parents inside the loaded page. */
  onHeadPath: boolean;
  isHead: boolean;
  /**
   * Lanes still open under the last row of the page: the list draws them as
   * continuing when more commits can be loaded. Empty on every other row.
   */
  continuesBelow: number[];
}

export interface GitGraphOptions {
  /** Tip of the current branch; `null` (or absent) skips the ancestor walk. */
  headHash?: string | null;
  /** The page was cut short, so lanes open at its end have more commits below. */
  hasMore?: boolean;
}

/** A column of the graph: the hash it waits for, or `null` when it is free. */
interface Lane {
  hash: string | null;
  color: number;
}

/**
 * Lays out the commit DAG of one page of `git log --topo-order`.
 *
 * Pure and deterministic: the same commits and options always produce the same
 * rows, never more than the number of commits, and never a lane beyond the
 * widest point of the page. A commit already expected in one or more live lanes
 * takes the leftmost of them and the duplicates collapse into it; an unexpected
 * commit (a branch tip) takes the first free lane or appends one. `parents[0]`
 * continues the node's lane, the other parents join the lane that already waits
 * for them or open a free one, and a root commit frees its lane.
 */
export function buildGitGraph(
  commits: readonly GitCommit[],
  options: GitGraphOptions = {},
): GraphNode[] {
  const headHash = options.headHash ?? null;
  const ancestry = headAncestry(commits, headHash);
  const lanes: Lane[] = [];
  const nodes: GraphNode[] = [];

  const laneAt = (index: number): Lane => {
    for (let next = lanes.length; next <= index; next += 1) lanes.push({ hash: null, color: -1 });
    return lanes[index] as Lane;
  };

  const firstFreeLane = (): number => {
    const index = lanes.findIndex((lane) => lane.hash === null);
    return index === -1 ? lanes.length : index;
  };

  const laneWaitingFor = (hash: string): number => lanes.findIndex((lane) => lane.hash === hash);

  /** The lowest colour index no live lane uses, so colours stay few and stable. */
  const freeColor = (): number => {
    const used = new Set<number>();
    for (const lane of lanes) if (lane.hash !== null && lane.color >= 0) used.add(lane.color);
    let color = 0;
    while (used.has(color)) color += 1;
    return color;
  };

  /** Dropping trailing free lanes keeps the next opened lane as far left as possible. */
  const trim = (): void => {
    while (lanes.length > 0 && lanes[lanes.length - 1]!.hash === null) lanes.pop();
  };

  for (const commit of commits) {
    const before = lanes.map((lane) => ({ ...lane }));
    const expected: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index]!.hash === commit.hash) expected.push(index);
    }

    // The leftmost lane that waits for the commit, or the first free one.
    const lane = expected[0] ?? firstFreeLane();
    const own = laneAt(lane);
    const continuesLane = own.hash === commit.hash;

    const incoming: GraphEdge[] = [];
    if (continuesLane) {
      incoming.push({ kind: 'incoming', fromLane: lane, toLane: lane, color: own.color });
    }
    for (const index of expected) {
      if (index === lane) continue;
      const collapsed = laneAt(index);
      incoming.push({ kind: 'incoming', fromLane: index, toLane: lane, color: collapsed.color });
      collapsed.hash = null;
      collapsed.color = -1;
    }

    const color = continuesLane ? own.color : freeColor();

    // A root keeps nothing below it; every other commit reuses this lane, so
    // freeing it first lets `laneWaitingFor` find a lane another commit opened.
    own.hash = null;
    own.color = -1;

    const outgoing: GraphEdge[] = [];
    const parents = commit.parents.filter((parent) => parent !== '');
    const first = parents[0];
    if (first !== undefined) {
      const existing = laneWaitingFor(first);
      if (existing === -1) {
        own.hash = first;
        own.color = color;
        outgoing.push({ kind: 'outgoing', fromLane: lane, toLane: lane, color });
      } else {
        outgoing.push({
          kind: 'outgoing',
          fromLane: lane,
          toLane: existing,
          color: laneAt(existing).color,
        });
      }
    }
    for (const parent of parents.slice(1)) {
      const existing = laneWaitingFor(parent);
      if (existing !== -1) {
        outgoing.push({
          kind: 'outgoing',
          fromLane: lane,
          toLane: existing,
          color: laneAt(existing).color,
        });
        continue;
      }
      const index = firstFreeLane();
      const opened = laneAt(index);
      opened.color = freeColor();
      opened.hash = parent;
      outgoing.push({ kind: 'outgoing', fromLane: lane, toLane: index, color: opened.color });
    }

    // A lane alive before and after the row, out of the way of this dot, is a
    // straight line: it asks nothing of the commit and the commit asks nothing
    // of it.
    const through: GraphEdge[] = [];
    for (let index = 0; index < Math.max(before.length, lanes.length); index += 1) {
      if (index === lane) continue;
      const was = before[index];
      const now = lanes[index];
      if (!was || was.hash === null || !now || now.hash !== was.hash) continue;
      through.push({ kind: 'through', fromLane: index, toLane: index, color: was.color });
    }

    trim();

    const alive = new Set<number>();
    for (const edge of [...through, ...incoming, ...outgoing]) {
      alive.add(edge.fromLane);
      alive.add(edge.toLane);
    }

    nodes.push({
      hash: commit.hash,
      lane,
      color,
      lanes: [...alive].sort((left, right) => left - right),
      edges: [...through, ...incoming, ...outgoing],
      parents: [...commit.parents],
      refs: [...commit.refs],
      onHeadPath: ancestry.has(commit.hash),
      isHead: headHash !== null && commit.hash === headHash,
      continuesBelow: [],
    });
  }

  const last = nodes[nodes.length - 1];
  if (last && options.hasMore === true) {
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index]!.hash !== null) last.continuesBelow.push(index);
    }
  }

  return nodes;
}

/**
 * Every commit reachable from `headHash` through the parents the page knows
 * about. The walk is iterative and remembers what it visited, so a deep history
 * never overflows the stack and the page may stop before the root.
 */
function headAncestry(commits: readonly GitCommit[], headHash: string | null): Set<string> {
  const ancestry = new Set<string>();
  if (headHash === null) return ancestry;

  const parents = new Map<string, readonly string[]>();
  for (const commit of commits) parents.set(commit.hash, commit.parents);

  const stack = [headHash];
  while (stack.length > 0) {
    const hash = stack.pop() as string;
    if (ancestry.has(hash)) continue;
    ancestry.add(hash);
    for (const parent of parents.get(hash) ?? []) {
      if (!ancestry.has(parent)) stack.push(parent);
    }
  }
  return ancestry;
}
