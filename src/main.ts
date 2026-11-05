import "./style.css";
import {
  newView,
  ViewSchema,
  visible,
  sameRepository,
  type Repository,
  type History,
  type TunedView,
} from "./model.ts";
import { renderSvg } from "./layout.ts";
const app = document.querySelector<HTMLDivElement>("#root")!;
let repo: Repository | undefined,
  view: TunedView | undefined,
  history: History | undefined;
let saved: TunedView[] = [],
  dirty = false,
  busy = false,
  error = "",
  notice = "",
  query = "",
  scale = 1;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const label = (s: string) => s.replace(/^refs\/heads\//, "");
async function api<T>(
  url: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function discard() {
  return !dirty || confirm("Discard unsaved view changes?");
}
function touch() {
  dirty = true;
  notice = "";
}
function options(selected = "") {
  return (repo?.branches || [])
    .map(
      (b) =>
        `<option value="${esc(b.ref)}" ${selected === b.ref ? "selected" : ""}>${esc(label(b.ref))}</option>`,
    )
    .join("");
}
function draw() {
  const focused = document.activeElement as HTMLInputElement | null;
  const focusId = focused?.id,
    selection = focused?.selectionStart;
  const viewport = document.querySelector("#viewport");
  const scroll = [viewport?.scrollLeft || 0, viewport?.scrollTop || 0];
  const sideScroll = document.querySelector("aside")?.scrollTop || 0;
  const count =
    history?.lanes.reduce(
      (n, l) => n + l.events.filter((c) => view && visible(view, c.sha)).length,
      0,
    ) || 0;
  const svg = history && view ? renderSvg(history, view) : "";
  app.innerHTML = `<header><div class="brand">◈ <span>Git Outliner</span></div><span class="tag">LOCAL / READ ONLY</span><div class="repo-open"><label class="sr" for="path">Repository path</label><input id="path" placeholder="/absolute/path/to/repository" value="${esc(repo?.path || "")}"><button data-action="open" ${busy ? "disabled" : ""}>Open repository</button></div></header>
  <div class="status" role="status" aria-live="polite">${busy ? "Reading live Git history…" : error ? `<span class="error">${esc(error)}</span>` : esc(notice || (repo ? repo.path : "Choose a local repository to begin. Your Git state is never modified."))}</div>
  <main><aside><fieldset ${busy ? "disabled" : ""}><section><div class="eyebrow">01 / TUNED VIEW</div><label for="saved">Saved views</label><select id="saved"><option value="">Choose a saved view…</option>${saved.map((v) => `<option value="${v.id}">${esc(v.name)} · ${esc(v.repository.pathHint.split("/").pop() || "")}</option>`).join("")}</select><div class="row"><button data-action="load">Load</button><button data-action="new" ${!repo ? "disabled" : ""}>New</button><button data-action="import">Import JSON</button></div>
  ${view ? `<label for="name">View name ${dirty ? '<span class="muted">· unsaved</span>' : ""}</label><input id="name" maxlength="120" value="${esc(view.name)}"><div class="row"><button class="primary" data-action="save">Save</button><button data-action="duplicate">Duplicate</button><button data-action="delete">Delete</button></div><button class="text-button" data-action="json">Export view JSON ↗</button>` : ""}</section>
  ${
    view && repo
      ? `<section><div class="eyebrow">02 / BRANCHES</div><label for="root">Diagram root</label><select id="root">${!repo.branches.some((b) => b.ref === view!.root) ? `<option value="${esc(view.root)}">Missing: ${esc(label(view.root))}</option>` : ""}${options(view.root)}</select><p class="hint">Only local branches. Dashed connections indicate inferred common ancestry.</p><div class="branch-list">${repo.branches
          .filter((b) => b.ref !== view!.root)
          .map(
            (b) =>
              `<label class="check"><input type="checkbox" data-branch="${esc(b.ref)}" ${view!.branches.includes(b.ref) ? "checked" : ""}><span>${esc(label(b.ref))}</span></label>`,
          )
          .join("")}</div></section>
  <section><div class="eyebrow">03 / MERGE EVENTS</div><label class="sr" for="search">Search merge events</label><input id="search" type="search" placeholder="Search tickets, subjects, SHA…" value="${esc(query)}"><div class="row"><button data-action="all">All</button><button data-action="none">None</button><button data-action="defaults">Reset overrides</button></div><p class="hint">Controls apply to all discovered events, including those hidden by search.</p><div id="events">${eventList()}</div></section>
  <section><details><summary>Parsing & presentation</summary><label for="pattern">Ticket regex</label><input id="pattern" value="${esc(view.tickets.pattern)}"><button data-action="pattern">Apply regex</button><label for="policy">New merges default to</label><select id="policy"><option value="include" ${view.visibility.default === "include" ? "selected" : ""}>Included</option><option value="exclude" ${view.visibility.default === "exclude" ? "selected" : ""}>Excluded</option></select><label for="spacing">Event spacing</label><input id="spacing" type="range" min="72" max="220" step="1" value="${view.layout.spacing}"><label for="width">Lane width</label><input id="width" type="range" min="240" max="600" step="10" value="${view.layout.laneWidth}"><label class="check"><input id="compact" type="checkbox" ${view.layout.compact ? "checked" : ""}>Compact labels</label></details></section>`
      : ""
  }</fieldset></aside>
  <article><div class="toolbar"><div><div class="eyebrow">LIVE REPOSITORY DIAGRAM</div><h1>${esc(view?.name || "History, with a little clarity.")}</h1><span class="muted">${history ? `${history.lanes.length} lanes · ${count} visible merges · oldest to newest ↓` : "Curate branches and merges into a reusable view."}</span></div><div class="row"><button data-action="refresh" ${!view || busy ? "disabled" : ""}>↻ Refresh / regenerate</button><button data-action="svg" ${!history || busy ? "disabled" : ""}>Export SVG ↗</button></div></div>
  ${history && view ? `<div class="warnings">${warningList()}</div><div class="canvas-controls"><button data-action="minus" aria-label="Zoom out">−</button><span id="zoom-label">${Math.round(scale * 100)}%</span><button data-action="plus" aria-label="Zoom in">+</button><button data-action="fit">Fit to view</button><span class="hint">Drag to pan · scroll to explore · hover labels for full messages</span></div><div id="viewport" tabindex="0" aria-label="Scrollable diagram"><div id="diagram" style="width:${getSvgSize(svg, "width") * scale}px;height:${getSvgSize(svg, "height") * scale}px"><div style="transform:scale(${scale});transform-origin:top left">${svg}</div></div></div>` : `<div class="empty"><div class="empty-symbol">⑂</div><h2>Your repository. Your story.</h2><p>Open a local Git repository, choose a root and descendant branches,<br>then tune the merges you want to show.</p><p class="hint">Saved rules follow your live history. Export clean, vector SVGs.</p></div>`}</article></main><input id="import-file" type="file" accept=".json,application/json" hidden>`;
  const nextViewport = document.querySelector("#viewport");
  if (nextViewport) {
    nextViewport.scrollLeft = scroll[0];
    nextViewport.scrollTop = scroll[1];
  }
  document.querySelector("aside")!.scrollTop = sideScroll;
  if (focusId) {
    const input = document.getElementById(focusId) as HTMLInputElement | null;
    input?.focus();
    if (selection != null && input && ["text", "search"].includes(input.type))
      input.setSelectionRange(selection, selection);
  }
  wirePan();
}
function getSvgSize(svg: string, attr: string) {
  return Number(svg.match(new RegExp(`${attr}="(\\d+)"`))?.[1] || 500);
}
function eventList() {
  if (!history || !view)
    return '<p class="hint">Select branches to discover merges.</p>';
  return history.lanes
    .map((l) => {
      const events = l.events.filter((c) =>
        `${c.body} ${c.sha} ${c.tickets.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
      return `<details open class="event-group"><summary>${esc(label(l.ref))} <span class="muted">${events.length}</span></summary><div class="row"><button data-group="${esc(l.ref)}" data-set="true">All</button><button data-group="${esc(l.ref)}" data-set="false">None</button></div>${events.length ? events.map((c) => `<div class="event"><label class="check"><input type="checkbox" data-event="${c.sha}" ${visible(view!, c.sha) ? "checked" : ""}><span><strong>${esc(c.tickets.join(", ") || c.subject || c.sha.slice(0, 8))}</strong><span class="event-subject" title="${esc(c.body)}">${esc(c.subject)}</span><small>${new Date(c.timestamp * 1000).toISOString().slice(0, 10)} · ${c.sha.slice(0, 8)}</small></span></label>${c.sha in view!.visibility.overrides ? `<button class="reset" data-reset="${c.sha}" title="Use default visibility">Reset to default</button>` : ""}</div>`).join("") : '<p class="hint">No matching merges in this branch segment.</p>'}</details>`;
    })
    .join("");
}
function warningList() {
  if (!history || !view || !history.warnings.length) return "";
  return `<details ${history.unresolved.length || history.warnings.some((w) => w.kind === "merge") ? "open" : ""}><summary>${history.warnings.length} reconciliation / ancestry notices${history.unresolved.length ? ` · ${history.unresolved.length} unresolved branches` : ""}</summary>${history.warnings.map((w, i) => `<div class="warning"><p>${esc(w.message)}</p>${w.ref && history!.unresolved.includes(w.ref) ? `<select aria-label="Replacement local branch" id="remap-${i}">${options()}</select><button data-remap="${i}">Reassign</button>${w.ref !== view!.root ? `<button data-remove="${esc(w.ref)}">Remove selection</button>` : ""}` : ""}${w.sha ? `<button data-reset="${w.sha}">Reset override</button><select id="merge-remap-${i}" aria-label="Replacement merge"><option value="">Select a merge explicitly…</option>${history!.lanes.flatMap((l) => l.events.map((c) => `<option value="${c.sha}">${esc(label(l.ref))} · ${c.sha.slice(0, 8)} · ${esc(c.subject)}</option>`)).join("")}</select><button data-merge-remap="${i}">Move override</button>` : ""}</div>`).join("")}</details>`;
}
async function refresh() {
  if (!repo || !view) return;
  history = undefined; // No stale graph when reconciliation fails.
  history = await api<History>("/api/history", { path: repo.path, view });
  repo = history.repository;
}
async function run(work: () => Promise<void>) {
  if (busy) return;
  busy = true;
  error = "";
  draw();
  try {
    await work();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    draw();
  }
}
async function change(work: () => void) {
  await run(async () => {
    work();
    touch();
    draw();
    await refresh();
  });
}
app.addEventListener("click", (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!button || button.disabled) return;
  const d = button.dataset;
  if (d.reset && view) {
    void change(() => {
      delete view!.visibility.overrides[d.reset!];
    });
    return;
  }
  if (d.group && view && history) {
    void change(() => {
      history!.lanes
        .find((l) => l.ref === d.group)!
        .events.forEach(
          (c) => (view!.visibility.overrides[c.sha] = d.set === "true"),
        );
    });
    return;
  }
  if (d.remove) {
    void change(() => {
      view!.branches = view!.branches.filter((r) => r !== d.remove);
    });
    return;
  }
  if (d.remap) {
    const w = history!.warnings[Number(d.remap)],
      replacement = (
        document.getElementById(`remap-${d.remap}`) as HTMLSelectElement
      ).value;
    void change(() => {
      view!.branches = [
        ...new Set(view!.branches.map((r) => (r === w.ref ? replacement : r))),
      ];
      if (view!.root === w.ref) view!.root = replacement;
    });
    return;
  }
  if (d.mergeRemap) {
    const w = history!.warnings[Number(d.mergeRemap)],
      replacement = (
        document.getElementById(
          `merge-remap-${d.mergeRemap}`,
        ) as HTMLSelectElement
      ).value;
    if (
      replacement &&
      confirm(`Move visibility override from ${w.sha} to ${replacement}?`)
    )
      void change(() => {
        view!.visibility.overrides[replacement] =
          view!.visibility.overrides[w.sha!];
        delete view!.visibility.overrides[w.sha!];
      });
    return;
  }
  const action = d.action;
  if (action === "open") {
    const path = (document.querySelector("#path") as HTMLInputElement).value;
    if (discard())
      void run(async () => {
        const next = await api<Repository>("/api/repository", { path });
        repo = next;
        view = newView(next);
        history = undefined;
        dirty = true;
        await refresh();
      });
  }
  if (action === "load") {
    const id = (document.querySelector("#saved") as HTMLSelectElement).value;
    const selected = saved.find((v) => v.id === id);
    if (selected && discard())
      void run(async () => {
        history = undefined;
        const next = await api<Repository>("/api/repository", {
          path:
            repo && sameRepository(selected.repository, repo.identity)
              ? repo.path
              : selected.repository.pathHint,
        });
        repo = next;
        view = structuredClone(selected);
        dirty = false;
        await refresh();
      });
  }
  if (action === "new" && repo && discard())
    void run(async () => {
      view = newView(repo!);
      dirty = true;
      await refresh();
    });
  if (action === "save" && view)
    void run(async () => {
      await api("/api/views", ViewSchema.parse(view));
      saved = await api("/api/views");
      dirty = false;
      notice = "View saved locally.";
    });
  if (action === "duplicate" && view)
    void run(async () => {
      view = {
        ...structuredClone(view!),
        id: crypto.randomUUID(),
        name: `${view!.name.slice(0, 110)} (copy)`,
      };
      await api("/api/views", view);
      saved = await api("/api/views");
      dirty = false;
      await refresh();
    });
  if (
    action === "delete" &&
    view &&
    confirm(`Delete saved view “${view.name}”?`)
  )
    void run(async () => {
      if (saved.some((v) => v.id === view!.id))
        await api(`/api/views/${view!.id}`, undefined, "DELETE");
      saved = await api("/api/views");
      view = undefined;
      history = undefined;
      dirty = false;
    });
  if (action === "import" && discard())
    document.querySelector<HTMLInputElement>("#import-file")!.click();
  if (action === "json" && view) {
    try {
      download(
        `${view.name}.json`,
        JSON.stringify(ViewSchema.parse(view), null, 2),
        "application/json",
      );
    } catch (e) {
      error = String(e);
      draw();
    }
  }
  if (action === "svg" && view)
    void run(async () => {
      await refresh();
      if (history)
        download(
          `${view!.name}.svg`,
          renderSvg(history, view!),
          "image/svg+xml",
        );
    });
  if (action === "refresh") void run(refresh);
  if (action === "pattern") {
    const pattern = (document.querySelector("#pattern") as HTMLInputElement)
      .value;
    void change(() => {
      new RegExp(pattern, "g");
      view!.tickets.pattern = pattern;
    });
  }
  if (["all", "none", "defaults"].includes(action || "") && view)
    void change(() => {
      if (action === "defaults") view!.visibility.overrides = {};
      else
        history?.lanes.forEach((l) =>
          l.events.forEach(
            (c) => (view!.visibility.overrides[c.sha] = action === "all"),
          ),
        );
    });
  if (action === "plus" || action === "minus") {
    scale = Math.min(
      3,
      Math.max(0.1, scale * (action === "plus" ? 1.2 : 1 / 1.2)),
    );
    draw();
  }
  if (action === "fit" && history && view) {
    const vp = document.querySelector("#viewport")!;
    const svg = renderSvg(history, view);
    scale = Math.min(
      1.5,
      (vp.clientWidth - 32) / getSvgSize(svg, "width"),
      (vp.clientHeight - 32) / getSvgSize(svg, "height"),
    );
    scale = Math.max(0.05, scale);
    draw();
    const next = document.querySelector("#viewport")!;
    next.scrollLeft = 0;
    next.scrollTop = 0;
  }
});
app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "import-file" && input.files?.[0]) {
    const file = input.files[0];
    void run(async () => {
      if (file.size > 2 * 1024 * 1024)
        throw new Error("View file exceeds 2 MB.");
      const imported = ViewSchema.parse(JSON.parse(await file.text()));
      const next =
        repo && sameRepository(imported.repository, repo.identity)
          ? repo
          : await api<Repository>("/api/repository", {
              path: imported.repository.pathHint,
            });
      if (!sameRepository(imported.repository, next.identity))
        throw new Error(
          "View belongs to a different repository. Open the matching local repository first.",
        );
      repo = next;
      view = { ...imported, id: crypto.randomUUID() };
      history = undefined;
      dirty = true;
      await refresh();
      notice = "Imported as a new view. Save to keep it across restarts.";
    });
    return;
  }
  if (!view) return;
  if (input.dataset.branch)
    void change(() => {
      view!.branches = input.checked
        ? [...view!.branches, input.dataset.branch!]
        : view!.branches.filter((r) => r !== input.dataset.branch);
    });
  if (input.dataset.event)
    void change(() => {
      view!.visibility.overrides[input.dataset.event!] = input.checked;
    });
  if (input.id === "root")
    void change(() => {
      view!.root = input.value;
      view!.branches = [...new Set([input.value, ...view!.branches])];
    });

  if (input.id === "policy")
    void change(() => {
      view!.visibility.default = input.value as "include" | "exclude";
    });
  if (input.id === "spacing")
    void change(() => {
      view!.layout.spacing = Number(input.value);
    });
  if (input.id === "width")
    void change(() => {
      view!.layout.laneWidth = Number(input.value);
    });
  if (input.id === "compact")
    void change(() => {
      view!.layout.compact = input.checked;
    });
});
app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "name" && view) {
    view.name = input.value;
    touch();
    document.querySelector("h1")!.textContent = input.value;
  }
  if (input.id === "search") {
    query = input.value;
    document.querySelector("#events")!.innerHTML = eventList();
  }
});
app.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.target as HTMLElement).id === "path")
    document.querySelector<HTMLButtonElement>('[data-action="open"]')!.click();
});
function wirePan() {
  const vp = document.querySelector<HTMLElement>("#viewport");
  if (!vp) return;
  let start: { x: number; y: number; left: number; top: number } | undefined;
  vp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    start = {
      x: e.clientX,
      y: e.clientY,
      left: vp.scrollLeft,
      top: vp.scrollTop,
    };
    vp.setPointerCapture(e.pointerId);
  });
  vp.addEventListener("pointermove", (e) => {
    if (start) {
      vp.scrollLeft = start.left - e.clientX + start.x;
      vp.scrollTop = start.top - e.clientY + start.y;
    }
  });
  vp.addEventListener("pointerup", () => (start = undefined));
  vp.addEventListener("pointercancel", () => (start = undefined));
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});
draw();
void run(async () => {
  saved = await api("/api/views");
});
