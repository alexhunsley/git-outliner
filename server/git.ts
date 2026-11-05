import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { sameRepository } from "../src/model.ts";
import type { Commit, Repository, TunedView, History } from "../src/model.ts";
import { rewriteMessages } from "./rewrite.ts";
import { deriveHierarchy } from "./hierarchy.ts";
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
    const hierarchy = deriveHierarchy(histories, view);
    result.links = hierarchy.links;
    result.warnings.push(...hierarchy.warnings);
    result.unresolved.push(...hierarchy.unresolved);
    const connected = hierarchy.ordered;
    // Ownership follows the resolved hierarchy, never checkbox selection order.
    const owned = new Set<string>();
    for (const ref of connected) {
      const commits = histories.get(ref)!;
      const segment = commits.filter((c) => !owned.has(c.sha));
      const events = segment.filter((c) => c.parents.length > 1);
      commits.forEach((c) => owned.add(c.sha));
      result.lanes.push({ ref, events, commits: segment });
    }
  } else if (histories.size)
    result.warnings.push({
      kind: "ancestry",
      message: "The root is missing. Reassign it to render descendant lanes.",
    });
  const events = result.lanes.flatMap((l) => l.commits);
  await tickets(events, view.tickets.pattern);
  const labels = await rewriteMessages(
    events.map((commit) => commit.subject),
    view.rewrites,
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
  return result;
}
