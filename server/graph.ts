import type { Commit, HistorySegment, SegmentGraph } from "../src/model.ts";
// Build the union of selected first-parent paths. Membership changes and forks
// split segments; no branch-name parent relationship is inferred.
export function deriveGraph(histories: Map<string, Commit[]>): SegmentGraph {
  const nodes = new Map<string, Commit>(),
    members = new Map<string, Set<string>>(),
    children = new Map<string, Set<string>>();
  const refs = [...histories.keys()].sort();
  for (const ref of refs)
    for (const commit of histories.get(ref)!) {
      nodes.set(commit.sha, commit);
      if (!members.has(commit.sha)) members.set(commit.sha, new Set());
      members.get(commit.sha)!.add(ref);
    }
  for (const commit of nodes.values()) {
    const parent = commit.parents[0];
    if (parent && nodes.has(parent)) {
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(commit.sha);
    }
  }
  const tips = refs.map((ref) => ({ ref, sha: histories.get(ref)![0].sha }));
  const tipSet = new Set(tips.map((t) => t.sha)),
    byCommit = new Map<string, HistorySegment>(),
    segments: HistorySegment[] = [];
  for (const ref of refs)
    for (const commit of [...histories.get(ref)!].reverse()) {
      if (byCommit.has(commit.sha)) continue;
      const parent = byCommit.get(commit.parents[0]),
        membership = [...members.get(commit.sha)!].sort();
      if (
        parent &&
        children.get(commit.parents[0])?.size === 1 &&
        !tipSet.has(commit.parents[0]) &&
        parent.refs.join("\0") === membership.join("\0")
      ) {
        parent.commits.push(commit);
        byCommit.set(commit.sha, parent);
      } else {
        const segment = {
          id: commit.sha,
          commits: [commit],
          refs: membership,
          parent: parent?.id ?? null,
        };
        segments.push(segment);
        byCommit.set(commit.sha, segment);
      }
    }
  segments.forEach((segment) => segment.commits.reverse());
  return {
    edges: [...nodes.values()]
      .flatMap((commit) =>
        commit.parents.flatMap((parent, index) =>
          nodes.has(parent)
            ? [{ parent, child: commit.sha, firstParent: index === 0 }]
            : [],
        ),
      )
      .sort((a, b) =>
        (a.child + ":" + a.parent).localeCompare(b.child + ":" + b.parent),
      ),
    segments: segments.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    tips,
  };
}
