import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { wrapText } from "../src/text.ts";
import { newView } from "../src/model.ts";
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
  const events = [...d.events].sort((a, b) => a.y - b.y);
  assert.ok(
    events
      .slice(1)
      .every((e, i) => e.y - 14 > events[i].y - 14 + events[i].height),
  );
});
