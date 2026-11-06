import {
  wrapText,
  elideText,
  fallbackMeasure,
  SVG_FONT,
  type MeasureText,
} from "./text.ts";
import {
  candidates,
  commitLabel,
  visible,
  type History,
  type TunedView,
  type Commit,
} from "./model.ts";
export interface Diagram {
  width: number;
  height: number;
  titleLines: string[];
  legendLines: string[];
  headingY: number;
  lanes: {
    headingLines: string[];
    ref: string;
    x: number;
    start: number;
    end: number;
    root: boolean;
  }[];
  events: {
    commit: Commit;
    x: number;
    y: number;
    lines: string[];
    height: number;
    width: number;
  }[];
  paths: { ref: string; x: number; y1: number; y2: number; refs: string[] }[];
  links: {
    tip?: boolean;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    base: string;
  }[];
}
export function layout(
  history: History,
  view: TunedView,
  measure: MeasureText = fallbackMeasure,
  availableWidth?: number,
): Diagram {
  const shown = history.lanes.flatMap((l) =>
    candidates(history, l, view).filter((c) => visible(view, c.sha)),
  );
  const needed = new Set([
    ...shown.map((c) => c.sha),
    ...history.links.map((l) => l.base),
    ...(history.graph?.segments.flatMap((s) => [
      s.commits[0].sha,
      s.commits.at(-1)!.sha,
    ]) || []),
  ]);
  const ordered = history.order.filter((s) => needed.has(s)).reverse();
  const width = Math.max(
    history.lanes.length > 1
      ? history.lanes.length * view.layout.laneWidth + 70
      : 240,
    availableWidth && Number.isFinite(availableWidth) ? availableWidth : 480,
  );
  const positions = new Map(ordered.map((sha, i) => [sha, i]));
  const laneX = (i: number) => 64 + i * view.layout.laneWidth;
  const laneEnd = (ref: string) =>
    ref === view.root
      ? Infinity
      : (positions.get(
          history.links.find((link) => link.branch === ref)?.base || "",
        ) ?? Infinity);
  const labelRight = (laneIndex: number, sha: string) => {
    const row = positions.get(sha)!;
    let right = width - 24;
    for (let i = laneIndex + 1; i < history.lanes.length; i++) {
      if (laneEnd(history.lanes[i].ref) >= row)
        right = Math.min(right, laneX(i) - 24);
    }
    // Connections occupy their ancestor row even when an intervening lane has ended.
    for (const link of history.links) {
      if (positions.get(link.base) !== row) continue;
      const left = Math.min(
        laneX(history.lanes.findIndex((l) => l.ref === link.parent)),
        laneX(history.lanes.findIndex((l) => l.ref === link.branch)),
      );
      if (left > laneX(laneIndex)) right = Math.min(right, left - 24);
    }
    return right;
  };
  const titleLines = wrapText(view.name, width - 48, measure, 16, 700);
  const legendLines = wrapText(
    `Git Outliner · newest → oldest ↓ · ○ commit · Ⓜ merge · ${history.graph ? "links: commit forks" : "dashed links: inferred ancestry"}` +
      (history.unresolved.length
        ? " · unresolved selections (see warnings)"
        : ""),
    width - 48,
    measure,
    10,
    400,
  );
  const headingY = 24 + titleLines.length * 22 + legendLines.length * 15;
  const headings = history.lanes.map((l, i) =>
    wrapText(
      l.ref.replace("refs/heads/", "") + (l.ref === view.root ? " · ROOT" : ""),
      i === history.lanes.length - 1
        ? width - laneX(i) - 12
        : view.layout.laneWidth - 24,
      measure,
      13,
      700,
    ),
  );
  const start =
    headingY + Math.max(1, ...headings.map((lines) => lines.length)) * 18 + 10;
  const labels = new Map(
    history.lanes.flatMap((lane, i) =>
      candidates(history, lane, view)
        .filter((c) => visible(view, c.sha))
        .map((commit) => {
          const labelWidth = labelRight(i, commit.sha) - laneX(i) - 14;
          const lines = view.layout.multiline
            ? wrapText(commitLabel(commit, view), labelWidth - 16, measure)
            : [elideText(commitLabel(commit, view), labelWidth - 16, measure)];
          return [
            commit.sha,
            {
              lines,
              width: labelWidth,
              height: lines.length * 18 + 16 + (view.layout.compact ? 0 : 20),
            },
          ] as const;
        }),
    ),
  );
  const segmentOwner = (refs: string[]) =>
    refs.includes(view.root) ? view.root : refs[0];
  // Sweep newest first. Only horizontally overlapping geometry consumes label height.
  type Box = {
    lane?: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  let placed: Box[] = [];
  const previousOnLane = new Map<number, { y: number; bottom: number }>();
  const owner = new Map(
    history.lanes.flatMap((lane, i) =>
      lane.commits.map((commit) => [commit.sha, i] as const),
    ),
  );
  let previousY = start + 9;
  let bottom = start;
  const y = new Map<string, number>();
  for (const sha of ordered) {
    // Future geometry starts no higher than 40 units above its circle.
    placed = placed.filter(
      (box) => box.bottom + 8 > previousY + 18 - 40 - view.layout.padding,
    );
    const lane = owner.get(sha);
    const label = labels.get(sha);
    const boxes: Box[] = [];
    if (label && lane !== undefined)
      boxes.push({
        lane,
        left: laneX(lane) - 8,
        right: laneX(lane) + 14 + label.width,
        top: -14,
        bottom: label.height - 14,
      });
    for (const link of history.links.filter((link) => link.base === sha)) {
      const parent = laneX(
        history.lanes.findIndex((l) => l.ref === link.parent),
      );
      const child = laneX(
        history.lanes.findIndex((l) => l.ref === link.branch),
      );
      boxes.push({
        left: Math.min(parent, child) - 8,
        right: Math.max(
          parent + 8,
          child + 18 + measure(`inferred · ${sha.slice(0, 7)}`, 10, 400),
        ),
        top: -40,
        bottom: 8,
      });
    }
    let nextY = Math.max(
      previousY + 18,
      start + 8 - Math.min(0, ...boxes.map((box) => box.top)),
    );
    if (label && lane !== undefined && previousOnLane.has(lane))
      nextY = Math.max(
        nextY,
        previousOnLane.get(lane)!.bottom + view.layout.padding + 14,
      );
    for (const box of boxes) {
      for (const prior of placed) {
        if (box.left < prior.right && prior.left < box.right)
          nextY = Math.max(
            nextY,
            prior.bottom +
              (label &&
              lane !== undefined &&
              prior.lane === lane &&
              box.lane === lane
                ? view.layout.padding
                : 8) -
              box.top,
          );
      }
    }
    y.set(sha, nextY);
    previousY = nextY;
    if (label && lane !== undefined)
      previousOnLane.set(lane, { y: nextY, bottom: nextY + label.height - 14 });
    for (const box of boxes) {
      placed.push({ ...box, top: box.top + nextY, bottom: box.bottom + nextY });
      bottom = Math.max(bottom, box.bottom + nextY);
    }
  }
  const height = Math.max(360, bottom + 64);
  const lanes = history.lanes.map((l, i) => ({
    headingLines: headings[i],
    ref: l.ref,
    x: 64 + i * view.layout.laneWidth,
    start,
    end:
      l.ref === view.root ||
      !history.links.some((link) => link.branch === l.ref)
        ? height - 32
        : Math.max(
            start,
            (y.get(
              history.links.find((link) => link.branch === l.ref)?.base || "",
            ) ?? start + 27) - 32,
          ),
    root: l.ref === view.root,
  }));
  return {
    width,
    titleLines,
    legendLines,
    headingY,
    height,
    lanes,
    paths: [
      ...(history.graph?.segments || []).map((segment) => {
        const ref = segmentOwner(segment.refs),
          lane = lanes.find((l) => l.ref === ref)!;
        const parent = history.graph!.segments.find(
          (s) => s.id === segment.parent,
        );
        const tip = history.graph!.tips.some(
          (t) => t.ref === ref && t.sha === segment.commits[0].sha,
        );
        const oldest = segment.commits.at(-1)!;
        return {
          ref,
          x: lane.x,
          y1: tip ? start : y.get(segment.commits[0].sha)!,
          y2: parent
            ? segmentOwner(parent.refs) === ref
              ? y.get(oldest.parents[0])!
              : lane.end
            : height - 32,
          refs: segment.refs,
        };
      }),
      ...history.links
        .filter((link) => link.tip)
        .map((link) => {
          const lane = lanes.find((l) => l.ref === link.branch)!;
          return {
            ref: link.branch,
            x: lane.x,
            y1: start,
            y2: lane.end,
            refs: [link.branch],
          };
        }),
    ],
    events: history.lanes.flatMap((l) =>
      candidates(history, l, view)
        .filter((c) => visible(view, c.sha))
        .map((commit) => ({
          commit,
          x: lanes.find((lane) => lane.ref === l.ref)!.x,
          y: y.get(commit.sha)!,
          ...labels.get(commit.sha)!,
        })),
    ),
    links: history.links.flatMap((link) => {
      const parent = lanes.find((l) => l.ref === link.parent),
        child = lanes.find((l) => l.ref === link.branch);
      return parent && child
        ? [
            {
              tip: link.tip,
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
export function renderSvg(
  history: History,
  view: TunedView,
  measure: MeasureText = fallbackMeasure,
  availableWidth?: number,
): string {
  const d = layout(history, view, measure, availableWidth),
    e = escapeXml;
  const color = (x: number) =>
    colors[d.lanes.findIndex((l) => l.x === x) % colors.length];
  const textLines = (lines: string[], x: number, y: number, step: number) =>
    lines
      .map(
        (line, i) => `<tspan x="${x}" y="${y + i * step}">${e(line)}</tspan>`,
      )
      .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${d.width}" height="${d.height}" viewBox="0 0 ${d.width} ${d.height}" role="img" aria-label="${e(view.name)}"><title>${e(view.name)}</title><desc>Newest to oldest, top to bottom. Plain circles represent commits; same-size circles with M represent merges. ${history.graph ? "Connections identify verified shared commits or ref tips." : "Dashed branch connections indicate inferred common first-parent ancestors."} Shared history is derived from commits; lane columns do not claim historical named-branch ownership. ${e(history.warnings.map((w) => w.message).join(" "))}</desc><rect width="100%" height="100%" fill="#fcfbf7"/><g font-family="${SVG_FONT}" font-size="12" fill="#253c3c"><text x="24" y="24" font-size="16" font-weight="700">${textLines(d.titleLines, 24, 24, 22)}</text><text x="24" y="43" font-size="10" fill="#637979">${textLines(d.legendLines, 24, 24 + d.titleLines.length * 22, 15)}</text>
  ${d.lanes.map((l) => `<g><text x="${l.x - 12}" y="${d.headingY}" font-size="13" font-weight="700" fill="${color(l.x)}"><title>${e(l.ref)}</title>${textLines(l.headingLines, l.x - 12, d.headingY, 18)}</text>${history.graph ? "" : `<path d="M${l.x},${l.start} V${l.end}" stroke="${color(l.x)}" stroke-width="${l.root ? 3 : 2}" fill="none"/>`}</g>`).join("")}
  ${d.paths.map((path) => `<path d="M${path.x},${path.y1} V${path.y2}" stroke="${path.refs.length > 1 ? "#87938f" : color(path.x)}" stroke-width="${path.ref === view.root ? 3 : 2}" fill="none"><title>${e(path.refs.length > 1 ? "History segment: " + path.refs.join(", ") : "Segment ending at " + path.ref)}</title></path>`).join("")}

  ${d.links.map((l) => `<g><title>${history.graph ? (l.tip ? "Ref tip at shared commit" : "Verified shared commit fork") : "Inferred common ancestor"} ${l.base}; no historical named-branch ownership is claimed</title><path d="M${l.x1},${l.y1} V${l.y1 - 24} C${l.x1},${l.y2} ${l.x2},${l.y1 - 24} ${l.x2},${l.y2}" fill="none" stroke="#9caeaa" stroke-dasharray="5 5"/><circle cx="${l.x1}" cy="${l.y1}" r="3" fill="#9caeaa"/><text x="${l.x2 + 10}" y="${l.y2 + 18}" fill="#6c7e7a" font-size="10">${history.graph ? (l.tip ? "tip" : "fork") : "inferred"} · ${l.base.slice(0, 7)}</text></g>`).join("")}
  ${d.events
    .map(({ commit: c, x, y, lines, height, width }) => {
      const eventColor = color(x);
      return `<g data-event="${c.sha}" data-kind="${c.parents.length > 1 ? "merge" : "commit"}"><title>${e((c.parents.length > 1 ? "Merge" : "Commit") + "\n" + c.sha + "\n" + c.body)}</title><circle cx="${x}" cy="${y}" r="6" fill="#fcfbf7" stroke="${eventColor}" stroke-width="3"/>${c.parents.length > 1 ? `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="7" font-weight="800" fill="${eventColor}" aria-label="Merge">M</text>` : ""}<rect x="${x + 14}" y="${y - 14}" width="${width}" height="${height}" rx="6" fill="#fcfbf7"/><text x="${x + 22}" y="${y - 1}" font-size="13" font-weight="650">${textLines(lines, x + 22, y + 4, 18)}</text>${view.layout.compact ? "" : `<text x="${x + 22}" y="${y + lines.length * 18 + 6}" font-size="10" fill="#748780">${new Date(c.timestamp * 1000).toISOString().slice(0, 10)} · ${c.sha.slice(0, 8)}</text>`}</g>`;
    })
    .join("")}
  </g></svg>`;
}
