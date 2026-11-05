import { z } from "zod";

export const DEFAULT_PATTERN = String.raw`\b[A-Z][A-Z0-9]+-\d+\b`;
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ref = z.string().startsWith("refs/heads/").min(12).max(1024);
export const ViewSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    repository: z
      .object({
        roots: z.array(sha).min(1),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        pathHint: z.string(),
      })
      .strict(),
    root: ref,
    branches: z.array(ref).min(1).max(64),
    visibility: z
      .object({
        default: z.enum(["include", "exclude"]),
        overrides: z.record(sha, z.boolean()),
      })
      .strict(),
    tickets: z.object({ pattern: z.string().min(1).max(500) }).strict(),
    layout: z
      .object({
        spacing: z.number().int().min(48).max(220),
        laneWidth: z.number().int().min(240).max(600),
        compact: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      !v.branches.includes(v.root) ||
      new Set(v.branches).size !== v.branches.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Select exactly one root within unique selected branches.",
      });
    try {
      new RegExp(v.tickets.pattern, "g");
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid ticket regular expression.",
      });
    }
  });
export type TunedView = z.infer<typeof ViewSchema>;
export interface Commit {
  sha: string;
  parents: string[];
  timestamp: number;
  subject: string;
  body: string;
  tickets: string[];
}
export interface Repository {
  path: string;
  identity: TunedView["repository"];
  branches: { ref: string; sha: string }[];
}
export interface Link {
  branch: string;
  parent: string;
  base: string;
  inferred: true;
}
export interface Warning {
  kind: "branch" | "merge" | "ancestry" | "identity";
  message: string;
  ref?: string;
  sha?: string;
}
export interface History {
  repository: Repository;
  lanes: { ref: string; events: Commit[] }[];
  links: Link[];
  order: string[];
  warnings: Warning[];
  unresolved: string[];
}
export function visible(view: TunedView, sha: string): boolean {
  return (
    view.visibility.overrides[sha] ?? view.visibility.default === "include"
  );
}
export function parseTickets(
  message: string,
  pattern = DEFAULT_PATTERN,
): string[] {
  return [
    ...new Set(
      Array.from(
        message.matchAll(new RegExp(pattern, "g")),
        (m) => m[0],
      ).filter(Boolean),
    ),
  ];
}
export function newView(repository: Repository): TunedView {
  const root =
    repository.branches.find((b) => b.ref === "refs/heads/main")?.ref ??
    repository.branches[0]?.ref;
  if (!root) throw new Error("This repository has no local branches.");
  return {
    version: 1,
    id: crypto.randomUUID(),
    name: "Untitled view",
    repository: repository.identity,
    root,
    branches: [root],
    visibility: { default: "include", overrides: {} },
    tickets: { pattern: DEFAULT_PATTERN },
    layout: { spacing: 92, laneWidth: 320, compact: false },
  };
}

export function sameRepository(
  saved: TunedView["repository"],
  current: TunedView["repository"],
) {
  return saved.roots.every((root) => current.roots.includes(root));
}
