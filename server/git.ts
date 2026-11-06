import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { sameRepository } from "../src/model.ts";
import type { Commit, Repository, TunedView, History } from "../src/model.ts";
import { rewriteMessages } from "./rewrite.ts";
import { readVersionTags, versionLabel } from "./versions.ts";
import { upstreamMergeShas } from "./upstream.ts";
import { deriveGraph } from "./graph.ts";
const exec = promisify(execFile);
export async function git(path: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["--no-pager", "-C", path, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    });
    return stdout;
  } catch (e: any) {
    throw new Error(
      `Git could not read repository history: ${String(e.stderr || e.message).slice(0, 800)}`,
    );
  }
}
export function decodeLog(raw: string): Commit[] {
  const fields = raw.split("\0");
  const result: Commit[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const body = fields[i + 3].trimEnd();
    result.push({
      sha: fields[i].trim(),
      parents: fields[i + 1].split(" ").filter(Boolean),
      timestamp: Number(fields[i + 2]),
      body,
      subject: body.split("\n")[0],
      tickets: [],
    });
  }
  return result;
}
export async function inspect(path: string): Promise<Repository> {
  if (typeof path !== "string" || !path || path.includes("\0"))
    throw new Error("Supply a valid local repository path.");
  path = await realpath(path);
  const top = (await git(path, ["rev-parse", "--show-toplevel"])).trim();
  path = await realpath(top);
  const branches = (
    await git(path, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/heads/",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha] = line.split("\0");
      return { ref, sha };
    });
  if (!branches.length) throw new Error("Repository has no local branches.");
  const roots = [
    ...new Set(
      (
        await git(path, [
          "rev-list",
          "--max-parents=0",
          ...branches.map((b) => b.sha),
          "--",
        ])
      )
        .trim()
        .split("\n")
        .filter(Boolean),
    ),
  ].sort();
  const fingerprint = createHash("sha256")
    .update(roots.join("\n"))
    .digest("hex");
  return { path, identity: { roots, fingerprint, pathHint: path }, branches };
}
// Run user-supplied expressions off the server thread, with a hard execution deadline.
async function tickets(commits: Commit[], pattern: string) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
      try { const regex = new RegExp(workerData.pattern, 'g'); parentPort.postMessage(workerData.messages.map(s => [...new Set(Array.from(s.matchAll(regex), m => m[0]).filter(Boolean))])); }
      catch(e) { throw e; }`,
      {
        eval: true,
        workerData: { pattern, messages: commits.map((c) => c.body) },
      },
    );
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(
        new Error("Ticket expression exceeded 2 seconds. Simplify the regex."),
      );
    }, 2000);
    worker.once("message", (values: string[][]) => {
      clearTimeout(timer);
      commits.forEach((c, i) => (c.tickets = values[i]));
      void worker.terminate();
      resolve();
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
export async function readHistory(
  path: string,
  view: TunedView,
): Promise<History> {
  const repository = await inspect(path);
  if (
    view.repository.fingerprint !==
      createHash("sha256")
        .update([...view.repository.roots].sort().join("\n"))
        .digest("hex") ||
    !sameRepository(view.repository, repository.identity)
  )
    throw new Error(
      "Repository identity differs from this view. Open the original repository, or create a new view here.",
    );
  const result: History = {
    repository,
    lanes: [],
    links: [],
    order: [],
    warnings: [],
    unresolved: [],
  };
  if (
    (
      await git(repository.path, ["rev-parse", "--is-shallow-repository"])
    ).trim() === "true"
  )
    result.warnings.push({
      kind: "ancestry",
      message:
        "This is a shallow repository. Earlier history and ancestry may be incomplete; fetch full history outside this read-only app if needed.",
    });
  const refs = [view.root, ...view.branches.filter((r) => r !== view.root)];
  const histories = new Map<string, Commit[]>();
  for (const ref of refs) {
    const branch = repository.branches.find((b) => b.ref === ref);
    if (!branch) {
      result.unresolved.push(ref);
      result.warnings.push({
        kind: "branch",
        ref,
        message: `Missing local branch ${ref}. Reassign it or remove it from the view.`,
      });
      continue;
    }
    histories.set(
      ref,
      decodeLog(
        await git(repository.path, [
          "log",
          "--first-parent",
          "-z",
          "--format=%H%x00%P%x00%ct%x00%B",
          branch.sha,
          "--",
        ]),
      ),
    );
  }
  if (histories.has(view.root)) {
    const rootSet = new Set(histories.get(view.root)!.map((c) => c.sha));
    const eligible = new Map<string, Commit[]>();
    for (const ref of [...histories.keys()].sort()) {
      const commits = histories.get(ref)!;
      if (ref === view.root || commits.some((c) => rootSet.has(c.sha)))
        eligible.set(ref, commits);
      else {
        result.unresolved.push(ref);
        result.warnings.push({
          kind: "ancestry",
          ref,
          message: `Cannot establish ${ref} on the root's first-parent lineage. Its lane is withheld.`,
        });
      }
    }
    const upstreamMerges = upstreamMergeShas(eligible, view.root);
    for (const commits of eligible.values())
      for (const commit of commits)
        if (upstreamMerges.has(commit.sha)) commit.upstreamMerge = true;
    const graph = deriveGraph(eligible);
    result.graph = graph;
    const owner = (refs: string[]) =>
      refs.includes(view.root) ? view.root : refs[0];
    const byId = new Map(graph.segments.map((s) => [s.id, s]));
    const owned = new Map<string, Commit[]>();
    for (const ref of [
      view.root,
      ...[...eligible.keys()].filter((r) => r !== view.root).sort(),
    ])
      owned.set(ref, []);
    for (const segment of graph.segments) {
      const ref = owner(segment.refs);
      owned.get(ref)!.push(...segment.commits);
      if (segment.parent) {
        const parent = byId.get(segment.parent)!;
        if (owner(parent.refs) !== ref)
          result.links.push({
            branch: ref,
            parent: owner(parent.refs),
            base: segment.commits.at(-1)!.parents[0],
            inferred: false,
            sharedRefs: parent.refs,
          });
      }
    }
    for (const tip of graph.tips)
      if (!owned.get(tip.ref)!.length && tip.ref !== view.root) {
        const segment = graph.segments.find((s) =>
          s.commits.some((c) => c.sha === tip.sha),
        )!;
        result.links.push({
          branch: tip.ref,
          parent: owner(segment.refs),
          base: tip.sha,
          inferred: false,
          sharedRefs: segment.refs,
          tip: true,
        });
      }
    result.links.sort((a, b) =>
      a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0,
    );
    for (const [ref, commits] of owned)
      result.lanes.push({
        ref,
        commits,
        events: commits.filter((c) => c.parents.length > 1),
      });
    if (Object.keys(view.branchParents).length)
      result.warnings.push({
        kind: "ancestry",
        message:
          "Legacy parent-branch overrides are retained but ignored: commit segments and fork points are derived automatically from Git.",
      });
  } else if (histories.size)
    result.warnings.push({
      kind: "ancestry",
      message: "The root is missing. Reassign it to render descendant lanes.",
    });
  const events = result.lanes.flatMap((l) => l.commits);
  const versions = await readVersionTags(repository.path, git);
  for (const commit of events) {
    const labels = [
      ...new Set(
        (versions.get(commit.sha) || []).map((tag) => versionLabel(tag)!),
      ),
    ];
    if (labels.length) commit.versions = labels;
  }
  await tickets(events, view.tickets.pattern);
  const labels = await rewriteMessages(
    events.map((commit) => commit.subject),
    view.rewritesEnabled ? view.rewrites : [],
  );
  events.forEach((commit, i) => {
    commit.label = labels[i];
  });
  const relevant = new Set(
    [...histories.values()].flatMap((h) => h.map((c) => c.sha)),
  );
  for (const sha of Object.keys(view.visibility.overrides))
    if (!relevant.has(sha))
      result.warnings.push({
        kind: "merge",
        sha,
        message: `Commit override ${sha.slice(0, 8)} is absent from selected histories. It is retained; reset or explicitly remap it if needed.`,
      });
  const tips = refs.flatMap((ref) =>
    repository.branches.filter((b) => b.ref === ref).map((b) => b.sha),
  );
  if (tips.length)
    result.order = (
      await git(repository.path, [
        "rev-list",
        "--date-order",
        "--reverse",
        ...tips,
        "--",
      ])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
  const rank = new Map(result.order.map((sha, i) => [sha, i]));
  for (const lane of result.lanes) {
    lane.commits.sort(
      (a, b) => (rank.get(b.sha) ?? 0) - (rank.get(a.sha) ?? 0),
    );
    lane.events = lane.commits.filter((c) => c.parents.length > 1);
  }
  return result;
}
