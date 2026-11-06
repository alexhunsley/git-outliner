import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, fixtureGit as g } from "../scripts/fixture.ts";
import { inspect, readHistory, git } from "../server/git.ts";
import { versionLabel, readVersionTags } from "../server/versions.ts";
import { newView, eventVisible } from "../src/model.ts";
import { layout, renderSvg } from "../src/layout.ts";
test("version tags require exact numeric triples and strip only a leading lowercase v", () => {
  assert.equal(versionLabel("v6.2.18"), "6.2.18");
  assert.equal(versionLabel("6.1.19"), "6.1.19");
  for (const tag of [
    "V6.2.18",
    "v6.2",
    "v6.2.18-beta",
    "6.2.18+build",
    "release/v6.2.18",
    "x6.2.18",
    "6.a.18",
  ])
    assert.equal(versionLabel(tag), undefined);
});
test("lightweight, annotated and nested version tags force filtered and excluded ordinary commits into the diagram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-versions-")),
    path = join(dir, "repo");
  try {
    const fixture = await createFixture(path);
    g(path, "commit", "--allow-empty", "-m", "Set release version");
    const plain = g(path, "rev-parse", "HEAD");
    g(path, "tag", "6.1.19", plain);
    g(path, "tag", "v6.1.19", plain);
    g(path, "tag", "-a", "v6.2.18", fixture.main, "-m", "Release");
    g(
      path,
      "-c",
      "advice.nestedTag=false",
      "tag",
      "-a",
      "v6.2.19",
      "v6.2.18",
      "-m",
      "Nested annotated tag",
    );
    g(path, "tag", "v6.2.18-beta", fixture.shared);
    const tree = g(path, "rev-parse", "HEAD^{tree}");
    g(path, "tag", "7.0.0", tree);
    const tags = await readVersionTags(path, git);
    assert.deepEqual(tags.get(plain), ["6.1.19", "v6.1.19"]);
    assert.deepEqual(tags.get(fixture.main), ["v6.2.18", "v6.2.19"]);
    assert.equal(tags.has(tree), false);
    const view = newView(await inspect(path));
    view.display.patterns = "DOES NOT MATCH ANYTHING";
    view.visibility.default = "exclude";
    view.visibility.overrides[plain] = false;
    view.visibility.overrides[fixture.main] = false;
    const beforeRefs = g(path, "show-ref"),
      beforeStatus = g(path, "status", "--porcelain");
    let history = await readHistory(path, view),
      diagram = layout(history, view);
    assert.deepEqual(
      diagram.events.map((e) => e.commit.sha).sort(),
      [plain, fixture.main].sort(),
    );
    const ordinary = diagram.events.find((e) => e.commit.sha === plain)!;
    assert.equal(ordinary.commit.parents.length, 1);
    assert.deepEqual(ordinary.commit.versions, ["6.1.19"]);
    assert.equal(eventVisible(view, ordinary.commit), true);
    assert.ok(ordinary.x - 16 - ordinary.badgeWidth >= 24);
    const svg = renderSvg(history, view);
    assert.match(svg, /data-version="6.1.19"/);
    assert.match(svg, /data-version="6.2.18"/);
    assert.match(svg, /rx="5" fill="#dff3dc"/);
    assert.doesNotMatch(svg, /data-version="v/);
    assert.equal(g(path, "show-ref"), beforeRefs);
    assert.equal(g(path, "status", "--porcelain"), beforeStatus);
    g(path, "tag", "-d", "6.1.19", "v6.1.19");
    history = await readHistory(path, view);
    diagram = layout(history, view);
    assert.ok(!diagram.events.some((e) => e.commit.sha === plain));
    assert.equal(view.visibility.overrides[plain], false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
