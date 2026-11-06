import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveGraph } from "../server/graph.ts";
import type { Commit } from "../src/model.ts";
const node = (key: string, parents: string[] = []): Commit => ({
  sha: key.repeat(40),
  parents: parents.map((p) => p.repeat(40)),
  timestamp: 0,
  subject: key,
  body: key,
  tickets: [],
});
test("segment derivation preserves selected merge edges and shared forks without named-branch parents", () => {
  const a = node("a"),
    b = node("b", ["a"]),
    m = node("c", ["a", "b"]);
  const histories = new Map([
    ["refs/heads/A", [m, a]],
    ["refs/heads/B", [b, a]],
  ]);
  const graph = deriveGraph(histories);
  assert.equal(graph.segments.length, 3);
  const shared = graph.segments.find((s) => s.refs.length === 2)!;
  assert.deepEqual(shared.refs, ["refs/heads/A", "refs/heads/B"]);
  assert.equal(graph.segments.filter((s) => s.parent === shared.id).length, 2);
  assert.ok(
    graph.edges.some(
      (e) => e.parent === b.sha && e.child === m.sha && !e.firstParent,
    ),
  );
  assert.ok(
    graph.edges.every((edge) =>
      [a, b, m].some(
        (c) => c.sha === edge.child && c.parents.includes(edge.parent),
      ),
    ),
  );
  assert.deepEqual(deriveGraph(new Map([...histories].reverse())), graph);
  const modified = new Map([
    ["refs/heads/A", [{ ...m, timestamp: -100 }, a]],
    ["refs/heads/B", [{ ...b, timestamp: 100 }, a]],
  ]);
  assert.deepEqual(deriveGraph(modified).edges, graph.edges);
});
test("identical tips share one graph path while retaining every tip ref", () => {
  const a = node("a"),
    b = node("b", ["a"]),
    c = node("c", ["b"]);
  const graph = deriveGraph(
    new Map([
      ["refs/heads/B", [c, b, a]],
      ["refs/heads/C", [c, b, a]],
    ]),
  );
  assert.equal(graph.segments.length, 1);
  assert.equal(graph.segments[0].commits.length, 3);
  assert.deepEqual(graph.segments[0].refs, ["refs/heads/B", "refs/heads/C"]);
  assert.equal(graph.tips.length, 2);
});
