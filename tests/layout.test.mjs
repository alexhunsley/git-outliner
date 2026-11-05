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
