import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upstreamMergeShas } from "../server/upstream.ts";
import { createFixture, fixtureGit as g } from "../scripts/fixture.ts";
import { inspect, readHistory } from "../server/git.ts";
import { newView, ViewSchema } from "../src/model.ts";
import { layout } from "../src/layout.ts";
import type { Commit } from "../src/model.ts";
const c = (sha: string, parents: string[]): Commit => ({
  sha,
  parents,
  timestamp: 0,
  subject: sha,
  body: sha,
  tickets: [],
});
test("uncertain sibling directions and mixed-source octopus merges are not classified as upstream", () => {
  const a = c("a", []),
    p = c("p", ["a"]),
    b = c("b", ["p"]),
    d = c("d", ["p"]),
    m = c("m", ["d", "b"]);
  assert.equal(
    upstreamMergeShas(
      new Map([
        ["A", [a]],
        ["B", [b, p, a]],
        ["C", [m, d, p, a]],
      ]),
      "A",
    ).has("m"),
    false,
  );
  const x = c("x", ["a"]),
    mixed = c("mixed", ["d", "x", "unknown"]);
  assert.equal(
    upstreamMergeShas(
      new Map([
        ["A", [x, a]],
        ["C", [mixed, d, p, a]],
      ]),
      "A",
    ).has("mixed"),
    false,
  );
  const redundant = c("redundant", ["d", "p"]);
  assert.equal(
    upstreamMergeShas(
      new Map([
        ["A", [a]],
        ["B", [b, p, a]],
        ["C", [redundant, d, p, a]],
      ]),
      "A",
    ).has("redundant"),
    true,
  );
});
test("verified back-merges filter independently of topology, retain forward merges, ghost correctly, and respect version exception", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-upstream-")),
    path = join(dir, "repo");
  try {
    await createFixture(path);
    g(path, "switch", "staging");
    g(path, "merge", "--no-ff", "main", "-m", "Bring upstream changes");
    const back = g(path, "rev-parse", "HEAD");
    g(
      path,
      "merge",
      "--no-ff",
      "release/1.0",
      "-m",
      "Merge child release into staging",
    );
    const forward = g(path, "rev-parse", "HEAD");
    g(path, "switch", "main");
    g(
      path,
      "merge",
      "--no-ff",
      "staging",
      "-m",
      "Merge child staging into root",
    );
    const rootForward = g(path, "rev-parse", "HEAD");
    const view = newView(await inspect(path));
    view.branches = [view.root, "refs/heads/staging", "refs/heads/release/1.0"];
    view.display.mode = "all";
    const history = await readHistory(path, view),
      original = layout(history, view);
    assert.ok(original.events.some((e) => e.commit.sha === back));
    assert.equal(
      history.lanes.flatMap((l) => l.commits).find((c) => c.sha === back)!
        .upstreamMerge,
      true,
    );
    const topology = JSON.stringify(history.graph!.edges);
    view.display.omitParentMerges = true;
    const omitted = layout(history, view);
    assert.ok(!omitted.events.some((e) => e.commit.sha === back));
    assert.ok(omitted.events.some((e) => e.commit.sha === forward));
    assert.ok(omitted.events.some((e) => e.commit.sha === rootForward));
    view.layout.ghostFiltered = true;
    assert.equal(
      layout(history, view).events.find((e) => e.commit.sha === back)!.ghost,
      true,
    );
    assert.equal(JSON.stringify(history.graph!.edges), topology);
    g(path, "tag", "v8.1.2", back);
    const tagged = await readHistory(path, view);
    assert.equal(
      layout(tagged, view).events.find((e) => e.commit.sha === back)!.ghost,
      false,
    );
    assert.equal(
      ViewSchema.parse(JSON.parse(JSON.stringify(view))).display
        .omitParentMerges,
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
