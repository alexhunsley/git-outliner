import type { Commit } from "../src/model.ts";
// Conservative evidence only. The designated root establishes the logical
// upstream direction. Shared fork membership alone never establishes it.
export function upstreamMergeShas(
  histories: Map<string, Commit[]>,
  root: string,
): Set<string> {
  const rootPath = new Set(histories.get(root)?.map((c) => c.sha) || []);
  const membership = new Map<string, Set<string>>();
  for (const [ref, commits] of histories)
    for (const commit of commits) {
      if (!membership.has(commit.sha)) membership.set(commit.sha, new Set());
      membership.get(commit.sha)!.add(ref);
    }
  const result = new Set<string>(),
    checked = new Set<string>();
  for (const [, commits] of histories) {
    const position = new Map(commits.map((commit, i) => [commit.sha, i]));
    commits.forEach((commit, index) => {
      if (checked.has(commit.sha)) return;
      checked.add(commit.sha);
      if (commit.parents.length < 2 || rootPath.has(commit.sha)) return;
      const destinations = membership.get(commit.sha)!;
      const onlyUpstream = commit.parents.slice(1).every((parent) => {
        if (rootPath.has(parent)) return true;
        // A redundant parent already inherited on the first-parent path,
        // shared with another selected lineage, is also established ancestry.
        const inherited = (position.get(parent) ?? -1) > index;
        return (
          inherited &&
          [...(membership.get(parent) || [])].some(
            (ref) => !destinations.has(ref),
          )
        );
      });
      if (onlyUpstream) result.add(commit.sha);
    });
  }
  return result;
}
