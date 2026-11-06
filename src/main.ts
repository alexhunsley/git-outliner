import "./style.css";
import {
  candidates,
  commitLabel,
  newView,
  ViewSchema,
  eventVisible,
  sameRepository,
  type Repository,
  type History,
  type TunedView,
} from "./model.ts";
import { RewriteRulesSchema, type RewriteRule } from "./rewrite.ts";
import {
  SettingsSchema,
  readSettings,
  writeSettings,
  type Settings,
} from "./session.ts";
import { renderSvg as renderMeasuredSvg } from "./layout.ts";
import { browserMeasure } from "./text.ts";
const measureText = browserMeasure();
let diagramWidth: number | undefined;
function usableWidth() {
  const element = document.querySelector<HTMLElement>("#viewport");
  if (!element || !element.clientWidth) return undefined;
  const style = getComputedStyle(element);
  return Math.floor(
    element.clientWidth -
      parseFloat(style.paddingLeft || "0") -
      parseFloat(style.paddingRight || "0"),
  );
}
const renderSvg = (history: History, view: TunedView) =>
  renderMeasuredSvg(history, view, measureText, diagramWidth);

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
let draftViewId = "",
  rewriteDraft: RewriteRule[] = [],
  rewritePending = false;
let rewriteSample = "Merged PR 2556: XYZ123 Fix a bug",
  previewOutput = rewriteSample,
  previewError = "";
let previewSequence = 0,
  previewTimer: ReturnType<typeof setTimeout> | undefined;
let openedPath = "",
  storageError = "",
  storageReadBlocked = false;
let drafts: Settings["ui"]["drafts"] = {
  repositoryPath: "",
  filter: "",
  ticketPattern: "",
  rewrites: [],
  rewritePending: false,
  rewriteSample,
};
let expanded: Record<string, boolean> = {},
  selectedView = "",
  controlsViewId = "";
function syncViewControls() {
  if (controlsViewId === (view?.id || "")) return;
  controlsViewId = view?.id || "";
  drafts.filter = view?.display.patterns || "";
  drafts.ticketPattern = view?.tickets.pattern || "";
}
function captureControls() {
  const value = (id: string, fallback: string) =>
    (document.getElementById(id) as HTMLInputElement | null)?.value ?? fallback;
  drafts.repositoryPath = value("path", drafts.repositoryPath);
  drafts.filter = value("filter-patterns", drafts.filter);
  drafts.ticketPattern = value("pattern", drafts.ticketPattern);
  selectedView = value("saved", selectedView);
}
function settingsSnapshot(): Settings {
  return SettingsSchema.parse({
    format: "git-outliner-settings",
    version: 1,
    repositoryPath: repo?.path || openedPath,
    view: view || null,
    dirty,
    ui: {
      query,
      selectedView,
      expanded,
      drafts: {
        ...drafts,
        rewrites: rewriteDraft,
        rewritePending,
        rewriteSample,
      },
    },
  });
}
function persistSession() {
  if (storageReadBlocked) return;
  try {
    writeSettings(window.localStorage, settingsSnapshot());
    storageError = "";
  } catch {
    storageError =
      "Browser settings could not be saved. Local storage may be unavailable or full; use Export settings.";
  }
  const el = document.querySelector("#storage-status");
  if (el) el.textContent = storageError;
}
function setSettings(settings: Settings) {
  storageReadBlocked = false;
  storageError = "";
  openedPath = settings.repositoryPath;
  view = settings.view || undefined;
  repo = undefined;
  history = undefined;
  dirty = settings.dirty;
  query = settings.ui.query;
  selectedView = settings.ui.selectedView;
  expanded = { ...settings.ui.expanded };
  drafts = structuredClone(settings.ui.drafts);
  rewriteDraft = structuredClone(drafts.rewrites);
  rewritePending = drafts.rewritePending;
  if (view && rewritePending) {
    const latest = RewriteRulesSchema.safeParse(rewriteDraft);
    if (latest.success) {
      view.rewrites = latest.data;
      rewritePending = false;
    } else
      notice =
        "Rule edits were not applied: correct the invalid regex and reload. Previous valid rules are retained.";
  }
  rewriteSample = drafts.rewriteSample;
  draftViewId = controlsViewId = view?.id || "";
  previewOutput = rewriteSample;
  previewError = "";
  ++previewSequence;
  scale = 1;
  if (rewriteDraft.length) schedulePreview();
}
function rewritePanel() {
  if (!view) return "";
  if (draftViewId !== view.id) {
    draftViewId = view.id;
    rewriteDraft = structuredClone(view.rewrites);
    rewritePending = false;
    previewError = "";
    previewOutput = rewriteSample;
    ++previewSequence;
    if (rewriteDraft.length) schedulePreview();
  }
  return `<section><div class="eyebrow">04 / MESSAGE REWRITES</div><p class="hint">Rules run top to bottom on the subject. Parentheses capture text; $1, $2 insert it. First match per rule; unmatched messages stay unchanged. Filtering uses original messages.</p>
  ${rewriteDraft.map((rule, i) => `<div class="rewrite-rule"><label for="rewrite-pattern-${i}">Match regex · rule ${i + 1}</label><input id="rewrite-pattern-${i}" data-rule-pattern="${i}" value="${esc(rule.pattern)}" maxlength="500" spellcheck="false"><label for="rewrite-replacement-${i}">Replace with</label><input id="rewrite-replacement-${i}" data-rule-replacement="${i}" value="${esc(rule.replacement)}" maxlength="2000" spellcheck="false"><div class="row"><button data-rule-up="${i}" ${i === 0 ? "disabled" : ""}>↑ Move up</button><button data-rule-down="${i}" ${i === rewriteDraft.length - 1 ? "disabled" : ""}>↓ Move down</button><button data-rule-remove="${i}">Remove</button></div></div>`).join("")}
  <div class="row"><button data-action="add-rewrite" ${rewriteDraft.length >= 20 ? "disabled" : ""}>Add rule</button><label class="check"><input id="rewrites-enabled" type="checkbox" ${view.rewritesEnabled ? "checked" : ""}>Apply renaming rules</label></div><p class="hint">Reload the page after editing rules to apply your changes.</p><label for="rewrite-sample">Live preview · original subject</label><textarea id="rewrite-sample" maxlength="10000" rows="3">${esc(rewriteSample)}</textarea><label for="rewrite-output">Rewritten label</label><output id="rewrite-output" aria-live="polite" class="${previewError ? "error" : ""}">${esc(previewError || previewOutput)}</output></section>`;
}
function schedulePreview() {
  const sequence = ++previewSequence;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const render = () => {
      const el = document.querySelector("#rewrite-output");
      if (el) {
        el.textContent = previewError || previewOutput;
        el.classList.toggle("error", !!previewError);
      }
    };
    previewError = "";
    const rules = RewriteRulesSchema.safeParse(rewriteDraft);
    if (!rules.success) {
      previewError = rules.error.issues[0].message;
      render();
      return;
    }
    previewOutput = "Previewing…";
    render();
    try {
      const result = await api<{ message: string }>("/api/rewrite-preview", {
        message: rewriteSample,
        rules: rules.data,
      });
      if (sequence !== previewSequence) return;
      previewOutput = result.message;
    } catch (e) {
      if (sequence !== previewSequence) return;
      previewError = e instanceof Error ? e.message : String(e);
    }
    render();
  }, 200);
}
function viewForSave() {
  return ViewSchema.parse({
    ...view,
    rewrites: rewritePending
      ? RewriteRulesSchema.parse(rewriteDraft)
      : view!.rewrites,
  });
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
  closeNodeMenu();
  const focused = document.activeElement as HTMLInputElement | null;
  const focusId = focused?.id,
    selection = focused?.selectionStart;
  const viewport = document.querySelector("#viewport");
  const scroll = [viewport?.scrollLeft || 0, viewport?.scrollTop || 0];
  const sideScroll = document.querySelector("aside")?.scrollTop || 0;
  syncViewControls();
  const count =
    history?.lanes.reduce(
      (n, l) =>
        n +
        (view
          ? candidates(history!, l, view).filter((c) => eventVisible(view!, c))
              .length
          : 0),
      0,
    ) || 0;
  const svg = history && view ? renderSvg(history, view) : "";
  app.innerHTML = `<header><div class="brand">◈ <span>Git Outliner</span></div><span class="tag">LOCAL / READ ONLY</span><div class="repo-open"><label class="sr" for="path">Repository path</label><input id="path" placeholder="/absolute/path/to/repository" value="${esc(drafts.repositoryPath)}"><button data-action="open" ${busy ? "disabled" : ""}>Open repository</button></div></header>
  <div class="status" role="status" aria-live="polite">${busy ? "Reading live Git history…" : error ? `<span class="error">${esc(error)}</span>` : esc(notice || (repo ? repo.path : "Choose a local repository to begin. Your Git state is never modified."))}</div>
  <main><aside><fieldset ${busy ? "disabled" : ""}><section><div class="eyebrow">01 / TUNED VIEW</div><label for="saved">Saved views</label><select id="saved"><option value="">Choose a saved view…</option>${saved.map((v) => `<option value="${v.id}">${esc(v.name)} · ${esc(v.repository.pathHint.split("/").pop() || "")}</option>`).join("")}</select><div class="row"><button data-action="load">Load</button><button data-action="new" ${!repo ? "disabled" : ""}>New</button><button data-action="import">Import view JSON</button></div><div class="row"><button data-action="export-settings">Export settings</button><button data-action="import-settings">Import settings</button></div><p id="storage-status" class="hint" role="status">${esc(storageError)}</p>
  ${view ? `<label for="name">View name ${dirty ? '<span class="muted">· unsaved</span>' : ""}</label><input id="name" maxlength="120" value="${esc(view.name)}"><div class="row"><button class="primary" data-action="save">Save</button><button data-action="duplicate">Duplicate</button><button data-action="delete">Delete</button></div><button class="text-button" data-action="json">Export view JSON ↗</button>` : ""}</section>
  ${
    view && repo
      ? `<section><div class="eyebrow">02 / BRANCHES</div><label for="root">Diagram root</label><select id="root">${!repo.branches.some((b) => b.ref === view!.root) ? `<option value="${esc(view.root)}">Missing: ${esc(label(view.root))}</option>` : ""}${options(view.root)}</select><p class="hint">Only local branches. Forks are derived from commit ancestry.</p><div class="branch-list">${repo.branches
          .filter((b) => b.ref !== view!.root)
          .map(
            (b) =>
              `<label class="check"><input type="checkbox" data-branch="${esc(b.ref)}" ${view!.branches.includes(b.ref) ? "checked" : ""}><span>${esc(label(b.ref))}</span></label>`,
          )
          .join("")}</div></section>
  <section><div class="eyebrow">03 / COMMITS & MERGES</div><label for="display-mode">Show</label><select id="display-mode"><option value="merges" ${view.display.mode === "merges" ? "selected" : ""}>Merges & branching points only</option><option value="all" ${view.display.mode === "all" ? "selected" : ""}>All commits</option></select><label for="filter-patterns">Filter diagram by text</label><textarea id="filter-patterns" rows="4" maxlength="10000" placeholder="CTR-123&#10;fix login">${esc(drafts.filter)}</textarea><p class="hint">One literal pattern per line. Matches any line, ignoring case, in the message, tickets or SHA. Blank shows all. Branch connections remain for context.</p><button data-action="filter">Apply filter</button><label class="sr" for="search">Search checklist</label><input id="search" type="search" placeholder="Search tickets, subjects, SHA…" value="${esc(query)}"><div class="row"><button data-action="all">All</button><button data-action="none">None</button><button data-action="defaults">Reset overrides</button></div><p class="hint">Controls apply to all discovered events, in this display mode and text filter, including those hidden by checklist search.</p><div id="events">${eventList()}</div></section>
  ${rewritePanel()}
  <section><details data-panel="presentation"><summary>Parsing & presentation</summary><label for="pattern">Ticket regex</label><input id="pattern" value="${esc(drafts.ticketPattern)}"><button data-action="pattern">Apply regex</button><label for="policy">New commits / merges default to</label><select id="policy"><option value="include" ${view.visibility.default === "include" ? "selected" : ""}>Included</option><option value="exclude" ${view.visibility.default === "exclude" ? "selected" : ""}>Excluded</option></select><label for="spacing">Event spacing: ${view.layout.padding}px</label><input id="spacing" type="range" min="0" max="120" step="1" value="${view.layout.padding}"><p class="hint">Vertical gap between labels in a branch. Zero adds no gap; connections and intervening events may still require room.</p><label for="width">Lane width</label><input id="width" type="range" min="240" max="600" step="10" value="${view.layout.laneWidth}"><label class="check"><input id="single-line" type="checkbox" ${!view.layout.multiline ? "checked" : ""}>Single line commit msg</label><label class="check"><input id="show-metadata" type="checkbox" ${!view.layout.compact ? "checked" : ""}>Show date + hash</label><label class="check"><input id="show-notes" type="checkbox" ${view.layout.showNotes ? "checked" : ""}>Show notes</label></details></section>`
      : ""
  }</fieldset></aside>
  <article><div class="toolbar"><div><div class="eyebrow">LIVE REPOSITORY DIAGRAM</div><h1>${esc(view?.name || "History, with a little clarity.")}</h1><span class="muted">${history ? `${history.lanes.length} lanes · ${count} visible ${view?.display.mode === "all" ? "commits" : "merges / branch points"} · newest to oldest ↓` : "Curate branches and merges into a reusable view."}</span></div><div class="row"><button data-action="refresh" ${!view || busy ? "disabled" : ""}>↻ Refresh / regenerate</button><button data-action="svg" ${!history || busy ? "disabled" : ""}>Export SVG ↗</button></div></div>
  ${history && view ? `<div class="warnings">${warningList()}</div><div class="canvas-controls"><button data-action="minus" aria-label="Zoom out">−</button><span id="zoom-label">${Math.round(scale * 100)}%</span><button data-action="plus" aria-label="Zoom in">+</button><button data-action="fit">Fit width</button><span class="hint">Drag to pan · scroll to explore · hover labels for full messages</span></div><div id="viewport" tabindex="0" aria-label="Scrollable diagram"><div id="diagram" style="width:${getSvgSize(svg, "width") * scale}px;height:${getSvgSize(svg, "height") * scale}px"><div style="transform:scale(${scale});transform-origin:top left">${svg}</div></div></div>` : `<div class="empty"><div class="empty-symbol">⑂</div><h2>Your repository. Your story.</h2><p>Open a local Git repository, choose a root and descendant branches,<br>then tune the merges you want to show.</p><p class="hint">Saved rules follow your live history. Export clean, vector SVGs.</p></div>`}</article></main><input id="import-file" type="file" accept=".json,application/json" hidden><input id="settings-file" type="file" accept=".json,application/json" hidden>`;
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
  const savedSelect = document.querySelector<HTMLSelectElement>("#saved");
  if (savedSelect) savedSelect.value = selectedView;
  wirePanels();
  wirePan();
  persistSession();
  observeViewport();
}
let resizeObserver: ResizeObserver | undefined;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReflow() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const width = usableWidth();
    if (!width || width === diagramWidth || !history || !view) return;
    diagramWidth = width;
    captureControls();
    draw();
  }, 100);
}
function observeViewport() {
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver ||= new ResizeObserver(scheduleReflow);
    resizeObserver.disconnect();
    const viewport = document.querySelector("#viewport");
    if (viewport) resizeObserver.observe(viewport);
  }
  scheduleReflow();
}
window.addEventListener("resize", scheduleReflow);
const wiredPanels = new WeakSet<HTMLDetailsElement>();
function wirePanels() {
  document
    .querySelectorAll<HTMLDetailsElement>("details[data-panel]")
    .forEach((panel) => {
      if (wiredPanels.has(panel)) return;
      wiredPanels.add(panel);
      const key = panel.dataset.panel!;
      if (key in expanded) panel.open = expanded[key];
      panel.addEventListener("toggle", () => {
        if (panel.isConnected) {
          expanded[key] = panel.open;
          persistSession();
        }
      });
    });
}
function getSvgSize(svg: string, attr: string) {
  return Number(svg.match(new RegExp(`${attr}="(\\d+)"`))?.[1] || 500);
}
function eventList() {
  if (!history || !view)
    return '<p class="hint">Select branches to discover commits and merges.</p>';
  return history.lanes
    .map((l) => {
      const events = candidates(history!, l, view!).filter((c) =>
        `${c.body} ${c.sha} ${c.tickets.join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
      return `<details open class="event-group" data-panel="${esc(l.ref)}"><summary>${esc(label(l.ref))} <span class="muted">${events.length}</span></summary><div class="row"><button data-group="${esc(l.ref)}" data-set="true">All</button><button data-group="${esc(l.ref)}" data-set="false">None</button></div>${events.length ? events.map((c) => `<div class="event"><label class="check"><input type="checkbox" data-event="${c.sha}" ${eventVisible(view!, c) ? "checked" : ""} ${c.versions?.length ? 'disabled title="Version-tagged commits are always shown"' : ""}><span><strong title="${esc(c.body)}">${esc(commitLabel(c, view!))}</strong><small>${new Date(c.timestamp * 1000).toISOString().slice(0, 10)} · ${c.sha.slice(0, 8)}</small></span></label>${c.sha in view!.visibility.overrides ? `<button class="reset" data-reset="${c.sha}" title="Use default visibility">Reset to default</button>` : ""}</div>`).join("") : '<p class="hint">No matching events in this branch segment.</p>'}</details>`;
    })
    .join("");
}
function warningList() {
  if (!history || !view || !history.warnings.length) return "";
  return `<details data-panel="warnings" ${history.unresolved.length || history.warnings.some((w) => w.kind === "merge") ? "open" : ""}><summary>${history.warnings.length} reconciliation / ancestry notices${history.unresolved.length ? ` · ${history.unresolved.length} unresolved branches` : ""}</summary>${history.warnings.map((w, i) => `<div class="warning"><p>${esc(w.message)}</p>${w.ref && history!.unresolved.includes(w.ref) ? `<select aria-label="Replacement local branch" id="remap-${i}">${options()}</select><button data-remap="${i}">Reassign</button>${w.ref !== view!.root ? `<button data-remove="${esc(w.ref)}">Remove selection</button>` : ""}` : ""}${w.sha ? `<button data-reset="${w.sha}">Reset override</button><select id="merge-remap-${i}" aria-label="Replacement commit"><option value="">Select a commit explicitly…</option>${history!.lanes.flatMap((l) => l.commits.map((c) => `<option value="${c.sha}">${esc(label(l.ref))} · ${c.sha.slice(0, 8)} · ${esc(c.subject)}</option>`)).join("")}</select><button data-merge-remap="${i}">Move override</button>` : ""}</div>`).join("")}</details>`;
}
async function refresh() {
  if (!view) return;
  if (!repo && openedPath)
    repo = await api<Repository>("/api/repository", { path: openedPath });
  if (!repo) return;
  openedPath = repo.path;
  history = undefined; // No stale graph when reconciliation fails.
  history = await api<History>("/api/history", {
    path: repo.path,
    view: { ...view, name: view.name.trim() || "Untitled view" },
  });
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
      candidates(
        history!,
        history!.lanes.find((l) => l.ref === d.group)!,
        view!,
      ).forEach((c) => (view!.visibility.overrides[c.sha] = d.set === "true"));
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
      view!.branchParents = Object.fromEntries(
        Object.entries(view!.branchParents).map(([child, parent]) => [
          child === w.ref ? replacement : child,
          parent === w.ref ? replacement : parent,
        ]),
      );
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
  for (const key of ["ruleUp", "ruleDown", "ruleRemove"] as const) {
    if (d[key] === undefined) continue;
    const i = Number(d[key]);
    if (key === "ruleRemove") rewriteDraft.splice(i, 1);
    else {
      const j = i + (key === "ruleUp" ? -1 : 1);
      [rewriteDraft[i], rewriteDraft[j]] = [rewriteDraft[j], rewriteDraft[i]];
    }
    rewritePending = true;
    touch();
    draw();
    schedulePreview();
    return;
  }
  const action = d.action;
  if (action === "export-settings") {
    captureControls();
    try {
      download(
        "git-outliner-settings.json",
        JSON.stringify(settingsSnapshot(), null, 2),
        "application/json",
      );
    } catch (e) {
      error = String(e);
      draw();
    }
    return;
  }
  if (action === "import-settings" && discard()) {
    document.querySelector<HTMLInputElement>("#settings-file")!.click();
    return;
  }
  if (action === "add-rewrite") {
    rewriteDraft.push({
      pattern: String.raw`^Merged PR \d+:\s+([A-Z]+\d+)\s+(.+)$`,
      replacement: "$1: $2",
    });
    rewritePending = true;
    touch();
    draw();
    schedulePreview();
  }
  if (action === "filter" && view) {
    const patterns = (
      document.querySelector("#filter-patterns") as HTMLTextAreaElement
    ).value;
    void change(() => {
      view!.display.patterns = patterns;
    });
  }
  if (action === "open") {
    const path = (document.querySelector("#path") as HTMLInputElement).value;
    if (discard())
      void run(async () => {
        const next = await api<Repository>("/api/repository", { path });
        const resume =
          !repo && view && sameRepository(view.repository, next.identity);
        repo = next;
        openedPath = next.path;
        drafts.repositoryPath = next.path;
        storageReadBlocked = false;
        if (!resume) view = newView(next);
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
        draftViewId = "";
        const next = await api<Repository>("/api/repository", {
          path:
            repo && sameRepository(selected.repository, repo.identity)
              ? repo.path
              : selected.repository.pathHint,
        });
        repo = next;
        openedPath = next.path;
        drafts.repositoryPath = next.path;
        storageReadBlocked = false;
        view = structuredClone(selected);
        controlsViewId = "";
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
      await api("/api/views", viewForSave());
      saved = await api("/api/views");
      dirty = false;
      notice = "View saved locally.";
    });
  if (action === "duplicate" && view)
    void run(async () => {
      view = {
        ...viewForSave(),
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
        JSON.stringify(
          ViewSchema.parse({
            ...view,
            rewrites: rewritePending
              ? RewriteRulesSchema.parse(rewriteDraft)
              : view.rewrites,
          }),
          null,
          2,
        ),
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
          candidates(history!, l, view!).forEach(
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
    const available = usableWidth();
    if (!available || available <= 0) return;
    scale = available / getSvgSize(renderSvg(history, view), "width");
    draw();
    const next = document.querySelector("#viewport")!;
    next.scrollLeft = 0;
    next.scrollTop = 0;
  }
});
app.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "settings-file" && input.files?.[0]) {
    const file = input.files[0];
    void run(async () => {
      if (file.size > 2 * 1024 * 1024)
        throw new Error("Settings file exceeds 2 MB.");
      const settings = SettingsSchema.parse(JSON.parse(await file.text()));
      let next: Repository | undefined, nextHistory: History | undefined;
      if (settings.repositoryPath && settings.view) {
        next = await api<Repository>("/api/repository", {
          path: settings.repositoryPath,
        });
        nextHistory = await api<History>("/api/history", {
          path: next.path,
          view: {
            ...settings.view,
            name: settings.view.name.trim() || "Untitled view",
          },
        });
      }
      setSettings(settings);
      repo = next;
      history = nextHistory;
      notice = "Settings imported and saved in this browser.";
    });
    return;
  }
  captureControls();
  persistSession();
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
      openedPath = next.path;
      drafts.repositoryPath = next.path;
      storageReadBlocked = false;
      view = { ...imported, id: crypto.randomUUID() };
      history = undefined;
      dirty = true;
      await refresh();
      notice = "Imported as a new view. Save to keep it across restarts.";
    });
    return;
  }
  if (!view) return;
  if (input.id === "display-mode")
    void change(() => {
      view!.display.mode = input.value as "merges" | "all";
    });
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
      view!.layout.padding = Number(input.value);
    });
  if (input.id === "width")
    void change(() => {
      view!.layout.laneWidth = Number(input.value);
    });
  if (input.id === "rewrites-enabled")
    void change(() => {
      view!.rewritesEnabled = input.checked;
    });
  if (input.id === "single-line")
    void change(() => {
      view!.layout.multiline = !input.checked;
    });
  if (input.id === "show-notes")
    void change(() => {
      view!.layout.showNotes = input.checked;
    });
  if (input.id === "show-metadata")
    void change(() => {
      view!.layout.compact = !input.checked;
    });
});
app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  captureControls();
  if (
    input.dataset.rulePattern !== undefined ||
    input.dataset.ruleReplacement !== undefined
  ) {
    const i = Number(
      input.dataset.rulePattern ?? input.dataset.ruleReplacement,
    );
    if (input.dataset.rulePattern !== undefined)
      rewriteDraft[i].pattern = input.value;
    else rewriteDraft[i].replacement = input.value;
    rewritePending = true;
    touch();
    schedulePreview();
  }
  if (input.id === "rewrite-sample") {
    rewriteSample = input.value;
    schedulePreview();
  }
  if (input.id === "name" && view) {
    view.name = input.value;
    touch();
    document.querySelector("h1")!.textContent = input.value;
  }
  if (input.id === "search") {
    query = input.value;
    document.querySelector("#events")!.innerHTML = eventList();
    wirePanels();
  }
  persistSession();
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
let nodeMenu: HTMLDivElement | undefined;
let contextNode: Element | undefined;
function closeNodeMenu() {
  nodeMenu?.remove();
  nodeMenu = undefined;
}
function editNote(sha: string) {
  if (!view) return;
  const dialog = document.createElement("dialog");
  dialog.className = "note-dialog";
  dialog.innerHTML = `<form><h2>Edit note</h2><p>${esc(sha)}</p><label for="node-note">Note</label><textarea id="node-note" rows="8" maxlength="20000"></textarea><div class="row"><button type="submit">Save note</button><button type="button" data-cancel>Cancel</button><button type="button" class="note-delete" data-delete-note>Delete note</button></div></form>`;
  const finish = () => {
    dialog.close();
    dialog.remove();
    (contextNode as HTMLElement | undefined)?.focus?.();
  };
  dialog.querySelector("[data-cancel]")!.addEventListener("click", finish);
  dialog.querySelector("[data-delete-note]")!.addEventListener("click", () => {
    finish();
    void change(() => {
      delete view!.notes[sha];
    });
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish();
  });
  dialog.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    const note = dialog.querySelector<HTMLTextAreaElement>("textarea")!.value;
    finish();
    void change(() => {
      if (note) view!.notes[sha] = note;
      else delete view!.notes[sha];
    });
  });
  dialog.querySelector<HTMLTextAreaElement>("textarea")!.value =
    view.notes[sha] || "";
  document.body.append(dialog);
  dialog.showModal();
  dialog.querySelector("textarea")!.focus();
}
async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText)
      await navigator.clipboard.writeText(text);
    else {
      const input = document.createElement("textarea");
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      try {
        if (!document.execCommand("copy"))
          throw new Error("Clipboard access was denied.");
      } finally {
        input.remove();
      }
    }
  } catch (e) {
    error = `Could not copy text: ${e instanceof Error ? e.message : String(e)}`;
    draw();
  }
}
function showNodeMenu(node: Element, x: number, y: number) {
  const sha = node.getAttribute("data-event");
  if (!sha || !view || busy) return;
  const commit = history?.lanes
    .flatMap((lane) => lane.commits)
    .find((commit) => commit.sha === sha);
  if (!commit) return;
  const message = commit.body || commit.subject;
  const all = [sha, message, view.notes[sha] || ""].join("\n");
  closeNodeMenu();
  contextNode = node;
  const menu = document.createElement("div");
  nodeMenu = menu;
  menu.className = "node-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = `<button role="menuitem" data-copy>Copy SHA</button><button role="menuitem" data-copy-message>Copy commit message</button><button role="menuitem" data-copy-all>Copy all</button><button role="menuitem" data-note>Edit note</button>`;
  document.body.append(menu);
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector("[data-copy]")!.addEventListener("click", () => {
    closeNodeMenu();
    void copyText(sha);
  });
  menu.querySelector("[data-copy-message]")!.addEventListener("click", () => {
    closeNodeMenu();
    void copyText(message);
  });
  menu.querySelector("[data-copy-all]")!.addEventListener("click", () => {
    closeNodeMenu();
    void copyText(all);
  });
  menu.querySelector("[data-note]")!.addEventListener("click", () => {
    closeNodeMenu();
    editNote(sha);
  });
  menu.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const buttons = [...menu.querySelectorAll("button")];
      const index = buttons.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      buttons[
        (index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) %
          buttons.length
      ].focus();
    }
  });
  menu.querySelector("button")!.focus();
}
app.addEventListener("contextmenu", (event) => {
  const node = (event.target as Element).closest("#diagram [data-event]");
  if (!node) return;
  event.preventDefault();
  showNodeMenu(node, event.clientX, event.clientY);
});
app.addEventListener("keydown", (event) => {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10"))
    return;
  const node = (event.target as Element).closest("#diagram [data-event]");
  if (node) {
    event.preventDefault();
    const rect = node.getBoundingClientRect();
    showNodeMenu(node, rect.left, rect.top);
  }
});
document.addEventListener("pointerdown", (event) => {
  if (nodeMenu && !nodeMenu.contains(event.target as Node)) closeNodeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && nodeMenu) {
    closeNodeMenu();
    (contextNode as HTMLElement | undefined)?.focus?.();
  }
});
document.addEventListener("scroll", closeNodeMenu, true);
window.addEventListener("resize", closeNodeMenu);

window.addEventListener("pagehide", () => {
  captureControls();
  persistSession();
});
window.addEventListener("beforeunload", (e) => {
  captureControls();
  persistSession();
  if (dirty && storageError) e.preventDefault();
});
try {
  const settings = readSettings(window.localStorage);
  if (settings) setSettings(settings);
} catch {
  storageReadBlocked = true;
  storageError =
    "Saved browser settings could not be read. Import settings or open a repository to continue.";
}
draw();
void run(async () => {
  try {
    saved = await api("/api/views");
  } finally {
    if (view && openedPath) await refresh();
  }
});
