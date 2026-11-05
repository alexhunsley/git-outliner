import type { Commit, History, TunedView } from "../src/model.ts";
export function deriveHierarchy(
  histories: Map<string, Commit[]>,
  view: TunedView,
) {
  const warnings: History["warnings"] = [],
    unresolved: string[] = [],
    links: History["links"] = [];
  const refs = [...histories.keys()].filter((ref) => ref !== view.root).sort();
  const sets = new Map(
    [...histories].map(([ref, commits]) => [
      ref,
      new Set(commits.map((c) => c.sha)),
    ]),
  );
  const common = (child: string, parent: string) =>
    histories.get(child)?.find((c) => sets.get(parent)?.has(c.sha));
  const precedes = (parent: string, child: string) =>
    sets.get(child)!.has(histories.get(parent)![0].sha) &&
    !sets.get(parent)!.has(histories.get(child)![0].sha);
  const parents = new Map<string, string>();
  const flexible = new Set<string>();
  const fail = (ref: string, message: string) => {
    if (!unresolved.includes(ref)) {
      unresolved.push(ref);
      warnings.push({ kind: "ancestry", ref, message });
    }
  };
  for (const ref of refs) {
    if (!common(ref, view.root)) {
      fail(
        ref,
        `Cannot establish ${ref} on the root's first-parent lineage. Its lane is withheld.`,
      );
      continue;
    }
    const explicit = view.branchParents[ref];
    if (explicit) {
      if (
        explicit === ref ||
        !view.branches.includes(explicit) ||
        !histories.has(explicit) ||
        !common(ref, explicit) ||
        (explicit !== view.root && precedes(ref, explicit))
      ) {
        fail(
          ref,
          `The explicit parent ${explicit} for ${ref} is missing, unselected, unsupported, or reverses tip ancestry. Choose another parent or Auto.`,
        );
        continue;
      }
      parents.set(ref, explicit);
      continue;
    }
    const candidates = refs.filter(
      (parent) => parent !== ref && precedes(parent, ref),
    );
    const nearest = candidates.filter(
      (parent) =>
        !candidates.some(
          (other) => other !== parent && precedes(parent, other),
        ),
    );
    if (nearest.length === 1) parents.set(ref, nearest[0]);
    else {
      parents.set(ref, view.root);
      flexible.add(ref);
      const ambiguous =
        nearest.length > 1 ||
        refs.some(
          (other) =>
            other !== ref &&
            !precedes(ref, other) &&
            !precedes(other, ref) &&
            common(ref, other)?.sha !== common(ref, view.root)?.sha,
        );
      if (ambiguous)
        warnings.push({
          kind: "ancestry",
          ref,
          message: `Ambiguous lineage for ${ref}: shared commits do not establish branch direction. The visual hierarchy uses closest shared history; named-branch direction is inferred. Choose an explicit parent if known.`,
        });
    }
  }
  if (view.branchParents[view.root])
    warnings.push({
      kind: "ancestry",
      ref: view.root,
      message:
        "A saved parent override for the designated root is inactive. The root remains the visual origin.",
    });
  const ordered = [view.root],
    visiting = new Set<string>(),
    done = new Set<string>([view.root]);
  const visit = (ref: string): boolean => {
    if (done.has(ref)) return !unresolved.includes(ref);
    if (unresolved.includes(ref)) return false;
    if (visiting.has(ref)) {
      fail(
        ref,
        `Parent selections contain a cycle involving ${ref}. Choose another parent or Auto.`,
      );
      return false;
    }
    visiting.add(ref);
    let parent = parents.get(ref);
    if (flexible.has(ref)) {
      const commits = histories.get(ref)!;
      let nearest = commits.findIndex(
        (commit) => commit.sha === common(ref, view.root)!.sha,
      );
      for (const candidate of ordered) {
        if (
          candidate === view.root ||
          candidate === ref ||
          precedes(ref, candidate)
        )
          continue;
        const base = common(ref, candidate);
        if (!base) continue;
        const distance = commits.findIndex((commit) => commit.sha === base.sha);
        if (distance < nearest) {
          nearest = distance;
          parent = candidate;
        }
      }
      parents.set(ref, parent!);
    }
    const ok = !!parent && visit(parent);
    visiting.delete(ref);
    done.add(ref);
    if (!ok) {
      fail(
        ref,
        `The parent chain for ${ref} is unresolved or cyclic. Choose another parent or Auto.`,
      );
      return false;
    }
    ordered.push(ref);
    const base = common(ref, parent!)!.sha;
    links.push({ branch: ref, parent: parent!, base, inferred: true });
    warnings.push({
      kind: "ancestry",
      ref,
      message: `${ref}: ${view.branchParents[ref] ? "user-selected parent" : "ancestry-supported visual parent"} ${parent}, common first-parent ancestor ${base.slice(0, 8)}. Historical named-branch creation remains inferred.`,
    });
    return true;
  };
  // Rootward shared-history depth picks a stable visual spine, not a claim
  // about historical named-branch creation. Dependencies still visit parent first.
  const rootDistance = (ref: string) =>
    histories
      .get(ref)!
      .findIndex((commit) => commit.sha === common(ref, view.root)?.sha);
  [...refs]
    .sort(
      (a, b) =>
        rootDistance(a) - rootDistance(b) || (a < b ? -1 : a > b ? 1 : 0),
    )
    .forEach(visit);
  return { ordered, links, warnings, unresolved };
}
