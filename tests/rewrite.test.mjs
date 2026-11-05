import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { rewriteMessage, RewriteRulesSchema } from "../src/rewrite.ts";
import { rewriteMessages } from "../server/rewrite.ts";
import { newView, ViewSchema, matchesPatterns } from "../src/model.ts";
import { renderSvg } from "../src/layout.ts";
const rules = [
  {
    pattern: String.raw`^Merged PR \d+:\s+([A-Z]+\d+)\s+(.+)$`,
    replacement: "$1: $2",
  },
];
test("ordered capture replacements preserve unmatched subjects and support literal dollars", async () => {
  assert.equal(
    rewriteMessage("Merged PR 2556: XYZ123 Fix a bug", rules),
    "XYZ123: Fix a bug",
  );
  assert.equal(rewriteMessage("Unmatched subject", rules), "Unmatched subject");
  assert.equal(
    rewriteMessage("abc abc", [{ pattern: "abc", replacement: "X" }]),
    "X abc",
  );
  assert.equal(
    rewriteMessage("abc", [{ pattern: "abc", replacement: "$& $$" }]),
    "abc $",
  );
  const ordered = [...rules, { pattern: "^XYZ123:", replacement: "Issue:" }];
  assert.equal(
    rewriteMessage("Merged PR 2556: XYZ123 Fix a bug", ordered),
    "Issue: Fix a bug",
  );
  assert.deepEqual(
    await rewriteMessages(
      ["Merged PR 2556: XYZ123 Fix a bug", "Unmatched"],
      ordered,
    ),
    ["Issue: Fix a bug", "Unmatched"],
  );
  assert.equal(
    RewriteRulesSchema.safeParse([{ pattern: "[", replacement: "" }]).success,
    false,
  );
  assert.deepEqual(RewriteRulesSchema.parse(undefined), []);
});
test("SVG shows rewritten labels, original hover messages, and identical-size commit/merge circles", async () => {
  const sha = "a".repeat(40),
    other = "b".repeat(40);
  const repository = {
    path: "/tmp/example",
    identity: {
      roots: [sha],
      fingerprint: "c".repeat(64),
      pathHint: "/tmp/example",
    },
    branches: [{ ref: "refs/heads/main", sha: other }],
  };
  const view = newView(repository);
  view.rewrites = rules;
  view.display.mode = "all";
  const subject = "Merged PR 2556: XYZ123 Fix a bug";
  const [label] = await rewriteMessages([subject], view.rewrites);
  const merge = {
    sha: other,
    parents: [sha, "d".repeat(40)],
    subject,
    body: subject + "\n\nOriginal details",
    timestamp: 1,
    tickets: [],
    label,
  };
  const commit = {
    sha,
    parents: [],
    subject: "A plain commit",
    body: "A plain commit",
    timestamp: 0,
    tickets: [],
    label: "A plain commit",
  };
  const history = {
    repository,
    lanes: [{ ref: view.root, commits: [merge, commit], events: [merge] }],
    order: [sha, other],
    links: [],
    warnings: [],
    unresolved: [],
  };
  const doc = new JSDOM(renderSvg(history, view), {
    contentType: "image/svg+xml",
  }).window.document;
  const mergeNode = doc.querySelector('[data-kind="merge"]'),
    commitNode = doc.querySelector('[data-kind="commit"]');
  assert.equal(
    mergeNode.querySelector("circle").getAttribute("r"),
    commitNode.querySelector("circle").getAttribute("r"),
  );
  assert.equal(
    mergeNode.querySelector('text[aria-label="Merge"]').textContent,
    "M",
  );
  assert.equal(commitNode.querySelector('text[aria-label="Merge"]'), null);
  assert.match(
    mergeNode.querySelector("title").textContent,
    /Merged PR 2556.*Original details/s,
  );
  assert.ok(
    [...mergeNode.querySelectorAll("text")].some(
      (text) => text.textContent === "XYZ123: Fix a bug",
    ),
  );
  assert.equal(matchesPatterns(merge, "Merged PR 2556"), true);
  assert.equal(matchesPatterns(merge, "XYZ123: Fix"), false);
  assert.equal(merge.subject, subject);
  const old = structuredClone(view);
  delete old.rewrites;
  assert.deepEqual(ViewSchema.parse(old).rewrites, []);
  assert.deepEqual(
    ViewSchema.parse(JSON.parse(JSON.stringify(view))).rewrites,
    rules,
  );
  view.rewrites = [{ pattern: ".*", replacement: '<script>&"' }];
  merge.label = (await rewriteMessages([subject], view.rewrites))[0];
  const escaped = renderSvg(history, view);
  assert.match(escaped, /&lt;script&gt;&amp;&quot;/);
  assert.doesNotMatch(escaped, /<script>/);
});
test("pathological rewrite expression times out in worker and a subsequent rewrite succeeds", async () => {
  await assert.rejects(
    rewriteMessages(
      ["a".repeat(80) + "!"],
      [{ pattern: "(a+)+$", replacement: "X" }],
    ),
    /exceeded 2 seconds/,
  );
  assert.deepEqual(
    await rewriteMessages(["abc"], [{ pattern: "a", replacement: "A" }]),
    ["Abc"],
  );
});
