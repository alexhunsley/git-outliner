import {
  candidates,
  visible,
  type History,
  type TunedView,
  type Commit,
} from "./model.ts";
export interface Diagram {
  width: number;
  height: number;
  lanes: {
    ref: string;
    x: number;
    start: number;
    end: number;
    root: boolean;
  }[];
  events: { commit: Commit; x: number; y: number }[];
  links: { x1: number; y1: number; x2: number; y2: number; base: string }[];
}
export function layout(history: History, view: TunedView): Diagram {
  const shown = history.lanes.flatMap((l) =>
    candidates(history, l, view).filter((c) => visible(view, c.sha)),
  );
  const needed = new Set([
    ...shown.map((c) => c.sha),
    ...history.links.map((l) => l.base),
  ]);
  const ordered = history.order.filter((s) => needed.has(s)).reverse();
  const spacing = Math.max(view.layout.compact ? 48 : 72, view.layout.spacing);
  const height = Math.max(360, 200 + ordered.length * spacing);
  const y = new Map(ordered.map((s, i) => [s, 115 + i * spacing]));
  const lanes = history.lanes.map((l, i) => ({
    ref: l.ref,
    x: 64 + i * view.layout.laneWidth,
    start: 88,
    end:
      l.ref === view.root
        ? height - 32
        : Math.max(
            88,
            (y.get(
              history.links.find((link) => link.branch === l.ref)?.base || "",
            ) ?? 115) - 32,
          ),
    root: l.ref === view.root,
  }));
  return {
    width: Math.max(480, lanes.length * view.layout.laneWidth + 70),
    height,
    lanes,
    events: history.lanes.flatMap((l) =>
      candidates(history, l, view)
        .filter((c) => visible(view, c.sha))
        .map((commit) => ({
          commit,
          x: lanes.find((lane) => lane.ref === l.ref)!.x,
          y: y.get(commit.sha)!,
        })),
    ),
    links: history.links.flatMap((link) => {
      const parent = lanes.find((l) => l.ref === link.parent),
        child = lanes.find((l) => l.ref === link.branch);
      return parent && child
        ? [
            {
              x1: parent.x,
              x2: child.x,
              y1: y.get(link.base) ?? 88,
              y2: child.end,
              base: link.base,
            },
          ]
        : [];
    }),
  };
}
export function escapeXml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
}
const colors = [
  "#176c65",
  "#5a5ec8",
  "#b45e35",
  "#9a457b",
  "#4775a9",
  "#8a721b",
];
export function renderSvg(history: History, view: TunedView): string {
  const d = layout(history, view),
    e = escapeXml;
  const color = (x: number) =>
    colors[d.lanes.findIndex((l) => l.x === x) % colors.length];
  const trim = (text: string, length: number) =>
    text.length > length ? text.slice(0, length - 1) + "…" : text;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="${e(view.name)}"><title>${e(view.name)}</title><desc>Newest to oldest, top to bottom. Dashed branch connections indicate inferred common first-parent ancestors. Shared merges belong to the first selected owning lane. ${e(history.warnings.map((w) => w.message).join(" "))}</desc><rect width="100%" height="100%" fill="#fcfbf7"/><g font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" fill="#253c3c"><text x="24" y="24" font-size="16" font-weight="700">${e(view.name)}</text><text x="24" y="43" fill="#637979">Git Outliner · newest → oldest ↓ · dashed links: inferred ancestry${history.unresolved.length ? " · unresolved selections (see warnings)" : ""}</text>
  ${d.lanes.map((l) => `<g><text x="${l.x - 12}" y="69" font-size="13" font-weight="700" fill="${color(l.x)}"><title>${e(l.ref)}</title>${e(trim(l.ref.replace("refs/heads/", ""), Math.floor((view.layout.laneWidth - 24) / 8)))}${l.root ? " · ROOT" : ""}</text><path d="M${l.x},${l.start} V${l.end}" stroke="${color(l.x)}" stroke-width="${l.root ? 3 : 2}" fill="none"/></g>`).join("")}
  ${d.links.map((l) => `<g><title>Inferred common ancestor ${l.base}; historical fork direction is unknown</title><path d="M${l.x1},${l.y1} C${l.x1},${l.y2} ${l.x2},${l.y1} ${l.x2},${l.y2}" fill="none" stroke="#9caeaa" stroke-dasharray="5 5"/><circle cx="${l.x1}" cy="${l.y1}" r="3" fill="#9caeaa"/><text x="${l.x2 + 10}" y="${l.y2 + 18}" fill="#6c7e7a" font-size="10">inferred · ${l.base.slice(0, 7)}</text></g>`).join("")}
  ${d.events
    .map(({ commit: c, x, y }) => {
      const size = Math.floor((view.layout.laneWidth - 50) / 7);
      return `<g><title>${e(c.sha + "\n" + c.body)}</title><circle cx="${x}" cy="${y}" r="6" fill="#fcfbf7" stroke="${color(x)}" stroke-width="3"/><rect x="${x + 14}" y="${y - 18}" width="${view.layout.laneWidth - 38}" height="${view.layout.compact ? 32 : 61}" rx="6" fill="#fcfbf7"/><text x="${x + 22}" y="${y - 1}" font-size="13" font-weight="650">${e(trim(c.tickets.join(", ") || c.subject || c.sha.slice(0, 8), size))}</text>${view.layout.compact ? "" : `<text x="${x + 22}" y="${y + 18}" fill="#536a66">${e(trim(c.subject, size))}</text><text x="${x + 22}" y="${y + 34}" font-size="10" fill="#748780">${new Date(c.timestamp * 1000).toISOString().slice(0, 10)} · ${c.sha.slice(0, 8)}</text>`}</g>`;
    })
    .join("")}
  </g></svg>`;
}
