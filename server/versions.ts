// Exact release tags only: no prerelease/build suffixes or partial matches.
export function versionLabel(tag: string): string | undefined {
  return /^v?\d+\.\d+\.\d+$/.test(tag) ? tag.replace(/^v/, "") : undefined;
}
export async function readVersionTags(
  path: string,
  git: (path: string, args: string[]) => Promise<string>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const raw = await git(path, [
    "for-each-ref",
    "--format=%(refname:strip=2)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)",
    "refs/tags/",
  ]);
  for (const line of raw.trimEnd().split("\n").filter(Boolean)) {
    const [name, sha, type, peeled, peeledType] = line.split("\0");
    if (versionLabel(name) === undefined) continue;
    let commit =
      type === "commit" ? sha : peeledType === "commit" ? peeled : undefined;
    if (!commit && type === "tag") {
      // Resolve nested annotated tags; tags of trees/blobs have no commit node.
      try {
        commit = (
          await git(path, ["rev-parse", "--verify", `${sha}^{commit}`])
        ).trim();
      } catch {
        continue;
      }
    }
    if (!commit) continue;
    if (!result.has(commit)) result.set(commit, []);
    result.get(commit)!.push(name);
  }
  for (const names of result.values()) names.sort();
  return result;
}
