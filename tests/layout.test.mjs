import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { wrapText } from "../src/text.ts";
import { newView, ViewSchema } from "../src/model.ts";
import { layout, renderSvg } from "../src/layout.ts";
const measure = (text, size) => [...text].length * size * 0.65;
test("wrapping preserves words, Unicode, paragraphs and oversized identifiers without ellipses", () => {
  for (const text of [
    "A message with punctuation & café 中文 😀",
    "XYZ".repeat(70),
    "first line\nsecond line",
  ]) {
    const lines = wrapText(text, 120, measure);
    assert.equal(lines.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
    assert.ok(lines.every((line) => measure(line, 13) <= 120));
    assert.ok(!lines.join("").includes("…"));
  }
});
test("labels and headings grow without collisions; full and compact SVG retain one complete subject", () => {
  const root = "refs/heads/" + "a-long-branch-name-".repeat(6),
    sha = "a".repeat(40),
    newer = "b".repeat(40);
  const repository = {
    path: "/repo",
    identity: { roots: [sha], fingerprint: "c".repeat(64), pathHint: "/repo" },
    branches: [{ ref: root, sha: newer }],
  };
  const view = newView(repository);
  view.layout.laneWidth = 240;
  view.display.mode = "all";
  const subject =
    "CTR-123 " +
    "A long message with café punctuation & Unicode 中文. ".repeat(6);
  const commit = {
    sha: newer,
    parents: [sha, "d".repeat(40)],
    timestamp: 1,
    subject,
    body: subject,
    tickets: ["CTR-123"],
  };
  const older = {
    sha,
    parents: [],
    timestamp: 0,
    subject: "Older commit",
    body: "Older commit",
    tickets: [],
  };
  const history = {
    repository,
    lanes: [{ ref: root, events: [commit], commits: [commit, older] }],
    order: [sha, newer],
    links: [],
    warnings: [],
    unresolved: [],
  };
  for (const compact of [false, true]) {
    view.layout.compact = compact;
    const d = layout(history, view, measure),
      events = [...d.events].sort((a, b) => a.y - b.y);
    assert.ok(events[0].lines.length > 1);
    assert.ok(events[1].y - 14 > events[0].y - 14 + events[0].height);
    assert.ok(
      d.lanes[0].start > d.headingY + (d.lanes[0].headingLines.length - 1) * 18,
    );
    assert.ok(d.height > events.at(-1).y + events.at(-1).height);
    const doc = new JSDOM(renderSvg(history, view, measure), {
      contentType: "image/svg+xml",
    }).window.document;
    const node = doc.querySelector(`[data-event="${newer}"]`);
    const label = node.querySelector('text[font-size="13"]');
    assert.equal(
      label.textContent.replace(/\s/g, ""),
      subject.replace(/\s/g, ""),
    );
    assert.equal(node.querySelectorAll('text[font-size="13"]').length, 1);
    assert.equal(
      node.querySelectorAll('text[font-size="10"]').length,
      compact ? 0 : 1,
    );
    assert.ok(label.querySelectorAll("tspan").length > 1);
    assert.equal(
      node.querySelector('text[aria-label="Merge"]').textContent,
      "M",
    );
    assert.equal(
      Array.from(
        doc.querySelectorAll('text[font-weight="700"][font-size="13"] tspan'),
        (node) => node.textContent,
      )
        .join("")
        .replace(/\s/g, ""),
      (root.replace("refs/heads/", "") + " · ROOT").replace(/\s/g, ""),
    );
  }
});

function widthFixture() {
  const hashes = ["1", "2", "3", "4"].map((c) => c.repeat(40));
  const repository = {
    path: "/repo",
    identity: {
      roots: [hashes[0]],
      fingerprint: "a".repeat(64),
      pathHint: "/repo",
    },
    branches: [
      { ref: "refs/heads/main", sha: hashes[2] },
      { ref: "refs/heads/child", sha: hashes[3] },
    ],
  };
  const view = newView(repository);
  view.branches = repository.branches.map((b) => b.ref);
  view.display.mode = "all";
  view.layout.laneWidth = 240;
  const commits = hashes.map((sha, i) => ({
    sha,
    parents: i ? [hashes[i - 1]] : [],
    timestamp: i,
    subject:
      "A full label that uses free horizontal space rather than wrapping needlessly ".repeat(
        3,
      ),
    body: "body",
    tickets: [],
  }));
  const history = {
    repository,
    lanes: [
      { ref: view.root, events: [], commits: commits.slice(0, 3) },
      { ref: view.branches[1], events: [], commits: [commits[3]] },
    ],
    order: hashes,
    links: [
      {
        parent: view.root,
        branch: view.branches[1],
        base: hashes[1],
        inferred: true,
      },
    ],
    warnings: [],
    unresolved: [],
  };
  return { view, history, hashes };
}
test("single lane uses available width and rewraps completely when narrowed", () => {
  const { view, history } = widthFixture();
  history.lanes = history.lanes.slice(0, 1);
  history.links = [];
  view.branches = [view.root];
  const narrow = layout(history, view, measure, 350),
    wide = layout(history, view, measure, 1000);
  assert.equal(wide.width, 1000);
  assert.equal(narrow.width, 350);
  assert.ok(wide.events[0].width > narrow.events[0].width);
  assert.ok(wide.events[0].lines.length < narrow.events[0].lines.length);
  assert.ok(wide.height < narrow.height);
  for (const diagram of [narrow, wide])
    for (const event of diagram.events)
      assert.ok(event.x + 14 + event.width <= diagram.width - 24);
  const svg = renderSvg(history, view, measure, 1000);
  assert.equal(
    new JSDOM(svg, {
      contentType: "image/svg+xml",
    }).window.document.documentElement.getAttribute("width"),
    "1000",
  );
});
test("labels borrow past ended lanes, stop before active lanes and leave fork connections clear", () => {
  const { view, history, hashes } = widthFixture();
  const d = layout(history, view, measure, 1000);
  const older = d.events.find((e) => e.commit.sha === hashes[0]),
    newer = d.events.find((e) => e.commit.sha === hashes[2]),
    fork = d.events.find((e) => e.commit.sha === hashes[1]),
    child = d.events.find((e) => e.commit.sha === hashes[3]);
  assert.ok(older.width > newer.width);
  assert.ok(newer.x + 14 + newer.width <= d.lanes[1].x - 24);
  assert.ok(fork.x + 14 + fork.width <= d.lanes[1].x - 24);
  assert.equal(child.x + 14 + child.width, d.width - 24);
  assert.ok(older.y - 14 > d.lanes[1].end);
  const narrow = layout(history, view, measure, 300);
  assert.ok(narrow.width >= 2 * view.layout.laneWidth + 70);
  assertNoCollisions(d);
});

function assertNoCollisions(diagram) {
  const events = [...diagram.events].sort((a, b) => a.y - b.y);
  for (let i = 0; i < events.length; i++) {
    const a = events[i];
    if (i) assert.ok(a.y - events[i - 1].y >= 18);
    for (const b of events.slice(i + 1)) {
      const horizontal =
        a.x - 8 < b.x + 14 + b.width && b.x - 8 < a.x + 14 + a.width;
      if (horizontal) assert.ok(a.y - 14 + a.height + 8 <= b.y - 14);
    }
    for (const link of diagram.links) {
      if (link.base === a.commit.sha) continue;
      const left = Math.min(link.x1, link.x2) - 8,
        right = Math.max(
          link.x1 + 8,
          link.x2 + 18 + measure(`inferred · ${link.base.slice(0, 7)}`, 10),
        );
      if (a.x - 8 < right && left < a.x + 14 + a.width)
        assert.ok(
          a.y - 14 >= link.y1 + 16 || a.y - 14 + a.height + 8 <= link.y1 - 40,
        );
    }
  }
}
test("interleaved lane labels share vertical space while circles keep strict newest-first order", () => {
  const { view, history } = widthFixture();
  const newer = history.lanes[1].commits[0],
    next = history.lanes[0].commits[2];
  const d = layout(history, view, measure, 1000);
  const a = d.events.find((e) => e.commit.sha === newer.sha),
    b = d.events.find((e) => e.commit.sha === next.sha);
  assert.equal(b.y - a.y, 18);
  assert.ok(a.y - 14 + a.height > b.y - 14);
  assertNoCollisions(d);
  const expected = history.order.slice().reverse();
  assert.deepEqual(
    [...d.events].sort((a, b) => a.y - b.y).map((e) => e.commit.sha),
    expected,
  );
  assert.equal(
    renderSvg(history, view, measure, 1000),
    renderSvg(history, view, measure, 1000),
  );
});
test("lane spacing applies within a lane, and nested forks and filtered bases remain collision-free", () => {
  const { view, history, hashes } = widthFixture();
  view.layout.padding = 100;
  history.lanes.forEach((l) =>
    l.commits.forEach((c) => (c.subject = "Short subject")),
  );
  for (const compact of [false, true]) {
    view.layout.compact = compact;
    let d = layout(history, view, measure, 1000);
    assertNoCollisions(d);
    for (const lane of d.lanes) {
      const events = d.events
        .filter((e) => e.x === lane.x)
        .sort((a, b) => a.y - b.y);
      assert.ok(
        events
          .slice(1)
          .every((e, i) => e.y - events[i].y - events[i].height >= 100),
      );
    }
    view.visibility.overrides[hashes[1]] = false;
    d = layout(history, view, measure, 1000);
    assertNoCollisions(d);
    assert.equal(d.links.length, 1);
    delete view.visibility.overrides[hashes[1]];
  }
  // Add a selected child of the existing descendant and an independent marker.
  const nestedSha = "5".repeat(40),
    child = history.lanes[1];
  const commit = { ...child.commits[0], sha: nestedSha, parents: [hashes[3]] };
  history.lanes.push({
    ref: "refs/heads/nested",
    commits: [commit],
    events: [],
  });
  view.branches.push("refs/heads/nested");
  history.order.push(nestedSha);
  history.links.push({
    parent: child.ref,
    branch: "refs/heads/nested",
    base: hashes[3],
    inferred: true,
  });
  const d = layout(history, view, measure, 1100);
  assertNoCollisions(d);
  assert.equal(d.links.length, 2);
});

test("multiline and metadata switches are independent, and padding controls branch label gaps", () => {
  const { view, history } = widthFixture();
  const legacy = structuredClone(view);
  delete legacy.layout.multiline;
  delete legacy.layout.padding;
  const restored = ViewSchema.parse(legacy);
  assert.equal(restored.layout.multiline, true);
  assert.equal(restored.layout.padding, 8);
  assert.equal(
    ViewSchema.safeParse({ ...view, layout: { ...view.layout, padding: -1 } })
      .success,
    false,
  );
  history.lanes.forEach((lane) =>
    lane.commits.forEach((commit) => {
      commit.body = commit.subject;
    }),
  );
  view.layout.spacing = 48;
  const expanded = layout(history, view, measure, 600);
  view.layout.multiline = false;
  const single = layout(history, view, measure, 600);
  assert.ok(expanded.events.some((e) => e.lines.length > 1));
  assert.ok(single.events.every((e) => e.lines.length === 1));
  assert.ok(single.events.some((e) => e.lines[0].endsWith("…")));
  assert.ok(
    single.events.every((e) => measure(e.lines[0], 13) <= e.width - 16),
  );
  const fullHeight = single.events[0].height;
  view.layout.compact = true;
  assert.equal(
    layout(history, view, measure, 600).events[0].height,
    fullHeight - 20,
  );
  const doc = new JSDOM(renderSvg(history, view, measure, 600), {
    contentType: "image/svg+xml",
  }).window.document;
  assert.equal(
    doc.querySelectorAll('[data-event] text[font-size="10"]').length,
    0,
  );
  assert.match(
    doc.querySelector("[data-event] title").textContent,
    /A full label/,
  );
  view.layout.multiline = true;
  assert.ok(
    layout(history, view, measure, 600).events.some((e) => e.lines.length > 1),
  );
  view.layout.padding = 100;
  const padded = layout(history, view, measure, 600);
  for (const lane of padded.lanes) {
    const events = padded.events
      .filter((e) => e.x === lane.x)
      .sort((a, b) => a.y - b.y);
    assert.ok(
      events
        .slice(1)
        .every((e, i) => e.y - events[i].y - events[i].height >= 100),
    );
  }
  view.layout.padding = 0;
  assert.ok(layout(history, view, measure, 600).height < padded.height);
});

test("zero event spacing removes all added gap on a branch despite legacy circle spacing", () => {
  const { view, history } = widthFixture();
  history.lanes = history.lanes.slice(0, 1);
  history.links = [];
  view.branches = [view.root];
  view.layout.spacing = 220;
  view.layout.padding = 0;
  view.layout.multiline = false;
  for (const compact of [true, false]) {
    view.layout.compact = compact;
    const events = layout(history, view, measure, 1000).events.sort(
      (a, b) => a.y - b.y,
    );
    for (let i = 1; i < events.length; i++)
      assert.equal(events[i].y - events[i - 1].y - events[i - 1].height, 0);
    view.layout.padding = 17;
    const padded = layout(history, view, measure, 1000).events.sort(
      (a, b) => a.y - b.y,
    );
    for (let i = 1; i < padded.length; i++)
      assert.equal(padded[i].y - padded[i - 1].y - padded[i - 1].height, 17);
    view.layout.padding = 0;
  }
});
