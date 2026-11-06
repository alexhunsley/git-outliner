import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, fixtureGit as g } from "../scripts/fixture.ts";
import { inspect, readHistory, decodeLog } from "../server/git.ts";
import { ViewStore } from "../server/store.ts";
import { newView, parseTickets, ViewSchema, visible } from "../src/model.ts";
import { layout, renderSvg } from "../src/layout.ts";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "git-outliner-test-")),
    path = join(dir, "repo");
  const commits = await createFixture(path),
    repository = await inspect(path),
    view = newView(repository);
  view.branches = [view.root, "refs/heads/staging", "refs/heads/release/1.0"];
  return { dir, path, commits, repository, view };
}
test("ticket parsing handles multiple, duplicate, missing and custom tickets", () => {
  assert.deepEqual(parseTickets("CTR-123 CTR-123 AB2-9\nZ-1 CTR-77"), [
    "CTR-123",
    "AB2-9",
    "CTR-77",
  ]);
  assert.deepEqual(parseTickets("maintenance"), []);
  assert.deepEqual(parseTickets("bug#42", "bug#\\d+"), ["bug#42"]);
});
test("log decoding preserves control separators, multiline bodies and Unicode", () => {
  const sha = "a".repeat(40);
  const raw = `${sha}\0${sha} ${"b".repeat(40)}\0${1700}\0Subject café\n\nbody\x1e<xml>\n\0`;
  const [commit] = decodeLog(raw);
  assert.equal(commit.subject, "Subject café");
  assert.match(commit.body, /body\x1e<xml>/);
  assert.equal(commit.parents.length, 2);
});
test("versioned schema rejects malformed, unknown and inconsistent selections", async () => {
  const f = await setup();
  try {
    assert.equal(ViewSchema.parse(f.view).version, 1);
    for (const bad of [
      { ...f.view, version: 2 },
      { ...f.view, branches: [] },
      { ...f.view, branches: ["refs/heads/other"] },
      { ...f.view, graph: {} },
      { ...f.view, tickets: { pattern: "[" } },
      {
        ...f.view,
        visibility: { default: "include", overrides: { "CTR-123": false } },
      },
    ])
      assert.equal(ViewSchema.safeParse(bad).success, false);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("real histories yield exactly selected lanes and own shared merges only once", async () => {
  const f = await setup();
  try {
    const h = await readHistory(f.path, f.view);
    assert.deepEqual(
      h.lanes.map((l) => l.ref).sort(),
      [...f.view.branches].sort(),
    );
    const events = h.lanes.flatMap((l) => l.events);
    assert.equal(events.length, 5);
    assert.equal(new Set(events.map((c) => c.sha)).size, 5);
    assert.deepEqual(
      h.lanes[0].events.map((c) => c.sha).sort(),
      [f.commits.shared, f.commits.main].sort(),
    );
    assert.equal(h.links.length, 2);
    assert.ok(h.links.every((l) => l.sharedRefs?.length));
    assert.ok(h.links.every((l) => !l.inferred));
    assert.ok(events.some((c) => c.tickets.length === 0));
    assert.equal(events.filter((c) => c.tickets.includes("CTR-201")).length, 2);
    assert.ok(events.some((c) => c.tickets.includes("CTR-202")));
    assert.equal(h.repository.branches.length, 3);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("visibility is keyed by SHA; reset follows policy and rendering remains deterministic", async () => {
  const f = await setup();
  try {
    const h = await readHistory(f.path, f.view),
      initial = renderSvg(h, f.view);
    f.view.visibility.overrides[f.commits.staging] = false;
    assert.equal(visible(f.view, f.commits.staging), false);
    assert.equal(visible(f.view, f.commits.release), true);
    assert.equal(layout(h, f.view).events.length, 4);
    assert.equal(h.lanes.flatMap((l) => l.events).length, 5);
    const svg = renderSvg(h, f.view);
    assert.notEqual(initial, svg);
    assert.equal(svg, renderSvg(h, f.view));
    assert.match(initial, /&lt;angle brackets&gt;/);
    assert.match(svg, /<text/);
    assert.doesNotMatch(svg, /<script|<foreignObject|feature\/search/);
    delete f.view.visibility.overrides[f.commits.staging];
    assert.equal(visible(f.view, f.commits.staging), true);
    f.view.visibility.default = "exclude";
    assert.equal(visible(f.view, f.commits.staging), false);
    f.view.visibility.overrides[f.commits.staging] = true;
    assert.equal(visible(f.view, f.commits.staging), true);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("live refresh includes new merges, retains exclusions and leaves Git state unchanged", async () => {
  const f = await setup();
  try {
    f.view.visibility.overrides[f.commits.main] = false;
    const oldHead = g(f.path, "rev-parse", "HEAD");
    g(f.path, "switch", "-c", "feature/new");
    g(f.path, "commit", "--allow-empty", "-m", "new change");
    g(f.path, "switch", "main");
    g(f.path, "merge", "--no-ff", "feature/new", "-m", "CTR-999 New merge");
    const head = g(f.path, "rev-parse", "HEAD"),
      refs = g(f.path, "show-ref"),
      status = g(f.path, "status", "--porcelain=v1");
    assert.notEqual(head, oldHead);
    const h = await readHistory(f.path, f.view);
    assert.equal(visible(f.view, f.commits.main), false);
    assert.ok(h.lanes[0].events.some((c) => c.sha === head));
    assert.equal(visible(f.view, head), true);
    assert.equal(g(f.path, "rev-parse", "HEAD"), head);
    assert.equal(g(f.path, "show-ref"), refs);
    assert.equal(g(f.path, "status", "--porcelain=v1"), status);
    const positions = new Map(h.order.map((sha, i) => [sha, i]));
    assert.ok(positions.get(head)! > positions.get(f.commits.main)!);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("missing branches and rewritten merges are reported without ticket-based remapping", async () => {
  const f = await setup();
  try {
    f.view.visibility.overrides[f.commits.main] = false;
    g(f.path, "branch", "-m", "staging", "renamed-staging");
    g(f.path, "reset", "--hard", "HEAD~1");
    const h = await readHistory(f.path, f.view);
    assert.ok(h.unresolved.includes("refs/heads/staging"));
    assert.ok(h.warnings.some((w) => w.sha === f.commits.main));
    assert.equal(f.view.visibility.overrides[f.commits.main], false);
    assert.ok(!h.lanes.some((l) => l.ref.includes("renamed")));
    f.view.root = "refs/heads/missing";
    f.view.branches.push(f.view.root);
    const noRoot = await readHistory(f.path, f.view);
    assert.equal(noRoot.lanes.length, 0);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("unrelated roots are withheld and wrong repository imports are rejected", async () => {
  const f = await setup();
  try {
    g(f.path, "switch", "--orphan", "unrelated");
    g(f.path, "commit", "--allow-empty", "-m", "Other initial commit");
    assert.equal((await readHistory(f.path, f.view)).lanes.length, 3);
    const current = await inspect(f.path);
    const v = newView(current);
    v.branches.push("refs/heads/unrelated");
    const h = await readHistory(f.path, v);
    assert.ok(h.unresolved.includes("refs/heads/unrelated"));
    assert.equal(h.lanes.length, 1);
    v.repository.fingerprint = "0".repeat(64);
    await assert.rejects(readHistory(f.path, v), /identity/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("file persistence survives store recreation; schema import/export carries rules only", async () => {
  const f = await setup();
  try {
    const directory = join(f.dir, "views"),
      store = new ViewStore(directory);
    f.view.visibility.overrides[f.commits.main] = false;
    await store.save(f.view);
    const loaded = (await new ViewStore(directory).list())[0];
    assert.deepEqual(loaded, f.view);
    const json = await readFile(join(directory, f.view.id + ".json"), "utf8");
    assert.doesNotMatch(json, /"events"|"parents"|"order"/);
    assert.deepEqual(ViewSchema.parse(JSON.parse(json)), f.view);
    assert.throws(() => store.file("../bad"), /Invalid/);
    await store.delete(f.view.id);
    assert.equal((await store.list()).length, 0);
    await writeFile(join(directory, "broken.json"), "{}");
    await assert.rejects(store.list());
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("path, branch and commit-message special characters remain safe", async () => {
  const f = await setup();
  try {
    g(f.path, "branch", "topic/$hello;world");
    const v = newView(await inspect(f.path));
    v.branches.push("refs/heads/topic/$hello;world");
    const h = await readHistory(f.path, v);
    assert.equal(h.lanes.length, 2);
    await assert.rejects(inspect("/not/a/repository"));
    await assert.rejects(inspect("bad\0path"));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("pathological ticket regex is terminated without blocking history reads", async () => {
  const f = await setup();
  try {
    g(f.path, "switch", "-c", "regex-work");
    g(f.path, "commit", "--allow-empty", "-m", "regex test");
    g(f.path, "switch", "main");
    g(f.path, "merge", "--no-ff", "regex-work", "-m", "a".repeat(80) + "!");
    f.view.tickets.pattern = "(a+)+$";
    await assert.rejects(readHistory(f.path, f.view), /exceeded 2 seconds/);
    f.view.tickets.pattern = "CTR-\\d+";
    assert.ok((await readHistory(f.path, f.view)).lanes.length);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("imported narrow spacing remains collision-free and hidden events retain topology", async () => {
  const f = await setup();
  try {
    const h = await readHistory(f.path, f.view);
    f.view.layout.spacing = 48;
    const d = layout(h, f.view);
    const ordered = [...d.events].sort((a, b) => a.y - b.y);
    assert.ok(
      ordered.slice(1).every((event, i) => event.y - ordered[i].y >= 18),
    );
    assert.ok(
      d.lanes.every((lane) =>
        d.events
          .filter((event) => event.x === lane.x)
          .every((event) => event.y >= lane.start),
      ),
    );
    f.view.visibility.overrides[f.commits.staging] = false;
    const after = layout(h, f.view);
    assert.equal(after.events.length, d.events.length - 1);
    assert.equal(h.lanes.flatMap((lane) => lane.events).length, 5);
    assert.equal(after.links.length, 2);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("newest events sit above ancestors and branch lanes end at older fork points", async () => {
  const f = await setup();
  try {
    const h = await readHistory(f.path, f.view),
      d = layout(h, f.view);
    const y = (sha: string) =>
      d.events.find((event) => event.commit.sha === sha)!.y;
    assert.ok(y(f.commits.main) < y(f.commits.shared));
    assert.ok(y(f.commits.release) < y(f.commits.staging));
    assert.ok(d.links.every((link) => link.y2 < link.y1));
    assert.ok(
      d.lanes.every((lane) =>
        d.events
          .filter((event) => event.x === lane.x)
          .every((event) => event.y >= lane.start && event.y <= lane.end),
      ),
    );
    assert.match(renderSvg(h, f.view), /Newest to oldest/);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("multiline diagram filter matches any literal pattern in messages or SHAs and survives schema roundtrips", async () => {
  const f = await setup();
  try {
    const h = await readHistory(f.path, f.view);
    f.view.display.patterns = "\n search & DISCOVERY \r\nkeyboard navigation\n";
    assert.deepEqual(
      layout(h, f.view)
        .events.map((event) => event.commit.sha)
        .sort(),
      [f.commits.staging, f.commits.release].sort(),
    );
    f.view.display.patterns = "angle brackets";
    assert.deepEqual(
      layout(h, f.view).events.map((event) => event.commit.sha),
      [f.commits.staging],
    );
    f.view.display.patterns = f.commits.main.slice(0, 12);
    assert.deepEqual(
      layout(h, f.view).events.map((event) => event.commit.sha),
      [f.commits.main],
    );
    f.view.visibility.overrides[f.commits.main] = false;
    assert.equal(layout(h, f.view).events.length, 0);
    assert.equal(layout(h, f.view).links.length, 2);
    f.view.display.patterns = "[not a regex.*";
    assert.equal(layout(h, f.view).events.length, 0);
    f.view.display.patterns = " \n\n";
    assert.equal(layout(h, f.view).events.length, 4);
    assert.deepEqual(
      ViewSchema.parse(JSON.parse(JSON.stringify(f.view))).display,
      f.view.display,
    );
    const old = structuredClone(f.view) as Partial<typeof f.view>;
    delete old.display;
    assert.deepEqual(ViewSchema.parse(old).display, {
      mode: "merges",
      patterns: "",
    });
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("all-commit mode includes single commits; compact mode retains single-commit branching points", async () => {
  const f = await setup();
  try {
    g(f.path, "switch", "staging");
    g(
      f.path,
      "commit",
      "--allow-empty",
      "-m",
      "CTR-450 Single commit at branch point",
    );
    const fork = g(f.path, "rev-parse", "HEAD");
    g(f.path, "switch", "-c", "child");
    g(f.path, "commit", "--allow-empty", "-m", "CTR-451 Plain child commit");
    const child = g(f.path, "rev-parse", "HEAD");
    g(f.path, "switch", "main");
    g(f.path, "commit", "--allow-empty", "-m", "CTR-452 Plain root commit");
    const plain = g(f.path, "rev-parse", "HEAD");
    f.view.branches = [f.view.root, "refs/heads/staging", "refs/heads/child"];
    const h = await readHistory(f.path, f.view);
    const compact = layout(h, f.view).events.map((event) => event.commit.sha);
    assert.ok(compact.includes(fork));
    assert.ok(!compact.includes(child));
    assert.ok(!compact.includes(plain));
    f.view.display.mode = "all";
    const all = layout(h, f.view).events;
    assert.equal(all.length, 7);
    assert.equal(new Set(all.map((event) => event.commit.sha)).size, 7);
    assert.ok(
      all.some(
        (event) =>
          event.commit.sha === child &&
          event.commit.tickets.includes("CTR-451"),
      ),
    );
    assert.ok(all.some((event) => event.commit.sha === plain));
    f.view.visibility.overrides[plain] = false;
    f.view.display.mode = "merges";
    assert.ok(
      !(await readHistory(f.path, f.view)).warnings.some(
        (warning) => warning.sha === plain,
      ),
    );
    f.view.display.mode = "all";
    assert.ok(
      !layout(h, f.view).events.some((event) => event.commit.sha === plain),
    );
    assert.equal(layout(h, f.view).links.length, 2);
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("real interleaved branch histories overlap labels vertically with date-ordered staggered circles", async () => {
  const f = await setup();
  try {
    const dated = (branch: string, day: number) => {
      g(f.path, "switch", branch);
      execFileSync(
        "git",
        [
          "-C",
          f.path,
          "commit",
          "--allow-empty",
          "-m",
          `${branch}: ` +
            "A sufficiently long subject to require several lines of label text. ".repeat(
              5,
            ),
        ],
        {
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_DATE: `2026-01-${day}T12:00:00Z`,
            GIT_COMMITTER_DATE: `2026-01-${day}T12:00:00Z`,
          },
        },
      );
      return g(f.path, "rev-parse", "HEAD");
    };
    const main10 = dated("main", 10),
      main12 = dated("main", 12),
      child11 = dated("staging", 11),
      child13 = dated("staging", 13);
    f.view.branches = [f.view.root, "refs/heads/staging"];
    f.view.display.mode = "all";
    f.view.layout.laneWidth = 240;
    const h = await readHistory(f.path, f.view),
      d = layout(h, f.view, undefined, 700);
    const added = new Set([main10, main12, child11, child13]);
    const events = d.events
      .filter((e) => added.has(e.commit.sha))
      .sort((a, b) => a.y - b.y);
    assert.deepEqual(
      events.map((e) => e.commit.sha),
      [child13, main12, child11, main10],
    );
    assert.equal(events[1].y - events[0].y, 18);
    assert.ok(events[1].y - 14 < events[0].y - 14 + events[0].height);
    assert.ok(events.every((e) => e.lines.length > 1));
    for (let i = 1; i < events.length; i++)
      assert.ok(events[i].y - events[i - 1].y >= 18);
    // Date order must still respect ancestry when a child's clock moves backwards.
    const backdated = dated("staging", 2);
    const updated = await readHistory(f.path, f.view);
    assert.ok(
      updated.order.indexOf(backdated) > updated.order.indexOf(child13),
    );
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});

test("segment graph is independent of selection order, overrides and post-fork branch activity", async () => {
  const f = await setup();
  try {
    const before = await readHistory(f.path, f.view);
    f.view.branches = [
      f.view.root,
      "refs/heads/release/1.0",
      "refs/heads/staging",
    ];
    const reversed = await readHistory(f.path, f.view);
    assert.deepEqual(reversed.graph, before.graph);
    assert.deepEqual(reversed.lanes, before.lanes);
    g(f.path, "switch", "staging");
    g(f.path, "commit", "--allow-empty", "-m", "B advances after fork");
    const after = await readHistory(f.path, f.view);
    const fork = after.graph!.segments.find((s) =>
      s.commits.some((c) => c.sha === f.commits.staging),
    )!;
    assert.deepEqual(fork.refs, [
      "refs/heads/release/1.0",
      "refs/heads/staging",
    ]);
    assert.equal(
      after.graph!.segments.filter((s) => s.parent === fork.id).length,
      2,
    );
    assert.equal(after.unresolved.length, 0);
    const diagram = layout(after, f.view);
    assert.ok(diagram.paths.some((path) => path.refs.length > 1));
    assert.ok(
      diagram.captions.some((caption) =>
        caption.lines.join(" ").includes("Shared:"),
      ),
    );
    assert.match(renderSvg(after, f.view), /Shared segment/);
    const unchanged = JSON.stringify(after.graph);
    f.view.visibility.overrides[f.commits.staging] = false;
    assert.ok(layout(after, f.view).captions.length);
    assert.equal(JSON.stringify(after.graph), unchanged);
    delete f.view.visibility.overrides[f.commits.staging];

    f.view.branchParents = {
      "refs/heads/staging": "refs/heads/release/1.0",
      "refs/heads/release/1.0": "refs/heads/staging",
    };
    const ignored = await readHistory(f.path, f.view);
    assert.deepEqual(ignored.graph, after.graph);
    assert.deepEqual(ignored.links, after.links);
    assert.ok(ignored.warnings.some((w) => w.message.includes("ignored")));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
test("A/B/C fork topology survives different names, activity, identical tips and missing refs", async () => {
  const f = await setup();
  try {
    g(f.path, "branch", "-m", "main", "A");
    g(f.path, "branch", "-m", "staging", "Z-B");
    g(f.path, "branch", "-m", "release/1.0", "B-C");
    g(f.path, "switch", "Z-B");
    for (let i = 0; i < 5; i++)
      g(f.path, "commit", "--allow-empty", "-m", "Parent advances " + i);
    f.view.root = "refs/heads/A";
    f.view.branches = ["refs/heads/B-C", "refs/heads/A", "refs/heads/Z-B"];
    const h = await readHistory(f.path, f.view),
      graph = h.graph!;
    const bc = graph.segments.find((s) =>
      s.commits.some((c) => c.sha === f.commits.staging),
    )!;
    assert.deepEqual(bc.refs, ["refs/heads/B-C", "refs/heads/Z-B"]);
    const children = graph.segments.filter((s) => s.parent === bc.id);
    assert.equal(children.length, 2);
    assert.ok(
      children.every((s) => s.commits.at(-1)!.parents[0] === f.commits.staging),
    );
    const ancestor = graph.segments.find((s) => s.id === bc.parent)!;
    assert.ok(ancestor.refs.includes(f.view.root));
    assert.equal(
      new Set(graph.segments.flatMap((s) => s.commits.map((c) => c.sha))).size,
      graph.segments.flatMap((s) => s.commits).length,
    );
    f.view.branches.reverse();
    assert.deepEqual((await readHistory(f.path, f.view)).graph, graph);
    g(f.path, "branch", "identical", "Z-B");
    f.view.branches.push("refs/heads/identical");
    const identical = await readHistory(f.path, f.view);
    assert.equal(identical.lanes.length, 4);
    assert.equal(identical.unresolved.length, 0);
    g(f.path, "branch", "-D", "B-C");
    const missing = await readHistory(f.path, f.view);
    assert.ok(missing.unresolved.includes("refs/heads/B-C"));
  } finally {
    await rm(f.dir, { recursive: true, force: true });
  }
});
