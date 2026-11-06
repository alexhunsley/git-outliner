import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture, fixtureGit as g } from "../scripts/fixture.ts";
import { inspect, readHistory } from "../server/git.ts";
import { rewriteMessages } from "../server/rewrite.ts";
import { ViewStore } from "../server/store.ts";
const bundle = buildSync({
  entryPoints: ["src/main.ts"],
  bundle: true,
  write: false,
  format: "iife",
  loader: { ".css": "empty" },
}).outputFiles[0].text;
async function browser(store, session, storageUnavailable = false) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://127.0.0.1:4317",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  if (session !== undefined)
    w.localStorage.setItem("git-outliner.session.v1", session);
  if (storageUnavailable)
    Object.defineProperty(w, "localStorage", {
      value: {
        getItem() {
          throw new Error("Blocked");
        },
        setItem() {
          throw new Error("Blocked");
        },
      },
    });
  const downloads = [];
  let pending = 0;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  w.structuredClone = structuredClone;
  w.confirm = () => true;
  w.Blob = Blob;
  w.URL.createObjectURL = (blob) => {
    downloads.push(blob);
    return "blob:test";
  };
  w.URL.revokeObjectURL = () => {};
  w.HTMLAnchorElement.prototype.click = function () {};
  w.fetch = async (url, init = {}) => {
    pending++;
    try {
      const body = init.body ? JSON.parse(init.body) : undefined;
      let value;
      if (url === "/api/repository") value = await inspect(body.path);
      else if (url === "/api/rewrite-preview")
        value = {
          message: (await rewriteMessages([body.message], body.rules))[0],
        };
      else if (url === "/api/history")
        value = await readHistory(body.path, body.view);
      else if (url === "/api/views" && init.method === "POST")
        value = await store.save(body);
      else if (url.startsWith("/api/views/")) {
        await store.delete(url.split("/").at(-1));
        value = { ok: true };
      } else value = await store.list();
      return new Response(JSON.stringify(value));
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 400,
      });
    } finally {
      pending--;
    }
  };
  w.eval(bundle);
  const settle = async () => {
    for (let i = 0; i < 300; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (
        !pending &&
        !w.document.querySelector(".status").textContent.includes("Reading")
      )
        return;
    }
    throw new Error("UI did not settle");
  };
  const find = (selector) => {
    const el = w.document.querySelector(selector);
    assert.ok(el, selector);
    return el;
  };
  const click = async (selector) => {
    find(selector).click();
    await settle();
  };
  const change = async (selector, value) => {
    const el = find(selector);
    if (el.type === "checkbox") el.checked = value;
    else el.value = value;
    el.dispatchEvent(new w.Event("change", { bubbles: true }));
    await settle();
  };
  const input = (selector, value) => {
    const el = find(selector);
    el.value = value;
    el.dispatchEvent(new w.Event("input", { bubbles: true }));
  };
  await settle();
  return { dom, w, find, click, change, input, settle, downloads };
}
test("DOM workflow: select lanes, toggle, save, reload, reconcile, import/export and manage views", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-ui-")),
    path = join(dir, "repo");
  let b, restarted;
  try {
    const commits = await createFixture(path),
      store = new ViewStore(join(dir, "views"));
    b = await browser(store);
    b.input("#path", path);
    await b.click('[data-action="open"]');
    assert.equal(b.find("h1").textContent, "Untitled view");
    await b.change('[data-branch="refs/heads/staging"]', true);
    await b.change('[data-branch="refs/heads/release/1.0"]', true);
    assert.match(b.find(".toolbar").textContent, /3 lanes · 5 visible merges/);
    await b.change(`[data-event="${commits.staging}"]`, false);
    assert.match(b.find(".toolbar").textContent, /4 visible merges/);
    assert.doesNotMatch(b.find("#diagram").textContent, /Shared:/);
    assert.doesNotMatch(b.find("#events").textContent, /Shared:/);
    b.input("#name", "Release review");
    await b.click('[data-action="save"]');
    assert.equal((await store.list())[0].name, "Release review");
    b.input("#search", "CTR-301");
    assert.equal(b.w.document.querySelectorAll("#events .event").length, 1);
    await b.change("#display-mode", "all");
    assert.match(b.find(".toolbar").textContent, /visible commits/);
    b.input("#filter-patterns", "REPORTING\nkeyboard navigation");
    await b.click('[data-action="filter"]');
    assert.equal(
      b.w.document.querySelectorAll('#diagram circle[stroke-width="3"]').length,
      2,
    );
    assert.match(b.find("#diagram").textContent, /newest → oldest/);
    await b.click('[data-action="save"]');
    const filteredView = (await store.list())[0];
    assert.deepEqual(filteredView.display, {
      mode: "all",
      patterns: "REPORTING\nkeyboard navigation",
    });
    b.input("#filter-patterns", "");
    await b.click('[data-action="filter"]');
    await b.change("#display-mode", "merges");
    await b.click('[data-action="save"]');
    await b.click('[data-action="json"]');
    const exported = JSON.parse(await b.downloads.at(-1).text());
    assert.equal(exported.visibility.overrides[commits.staging], false);
    restarted = await browser(new ViewStore(join(dir, "views")));
    await restarted.change("#saved", exported.id);
    await restarted.click('[data-action="load"]');
    assert.match(
      restarted.find(".toolbar").textContent,
      /3 lanes · 4 visible merges/,
    );
    g(path, "switch", "-c", "new-work");
    g(path, "commit", "--allow-empty", "-m", "new work");
    g(path, "switch", "main");
    g(path, "merge", "--no-ff", "new-work", "-m", "CTR-999 A new merge");
    await restarted.click('[data-action="svg"]');
    assert.match(await restarted.downloads.at(-1).text(), /CTR-999/);
    assert.match(restarted.find(".toolbar").textContent, /5 visible merges/);
    g(path, "branch", "-m", "staging", "renamed-staging");
    await restarted.click('[data-action="refresh"]');
    assert.match(
      restarted.find(".warnings").textContent,
      /Missing local branch/,
    );
    const warningButton = restarted.find("[data-remap]"),
      index = warningButton.dataset.remap;
    await restarted.change(`#remap-${index}`, "refs/heads/renamed-staging");
    await restarted.click(`[data-remap="${index}"]`);
    assert.match(restarted.find(".toolbar").textContent, /3 lanes/);
    assert.doesNotMatch(
      restarted.find(".warnings").textContent,
      /Missing local branch/,
    );
    await restarted.click('[data-action="duplicate"]');
    assert.equal((await store.list()).length, 2);
    await restarted.click('[data-action="delete"]');
    assert.equal((await store.list()).length, 1);
    await restarted.click('[data-action="import"]');
    const file = restarted.find("#import-file");
    Object.defineProperty(file, "files", {
      value: [{ size: 100, text: async () => JSON.stringify(exported) }],
    });
    file.dispatchEvent(new restarted.w.Event("change", { bubbles: true }));
    await restarted.settle();
    assert.equal(restarted.find("h1").textContent, "Release review");
    assert.match(
      restarted.find(".warnings").textContent,
      /Missing local branch/,
    );
    await restarted.click('[data-action="save"]');
    assert.equal((await store.list()).length, 2);
    assert.equal(restarted.w.document.querySelector(".error"), null);
  } finally {
    b?.dom.window.close();
    restarted?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewrite editor previews, validates, applies and persists rules with merge marker exports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-rewrite-ui-")),
    path = join(dir, "repo");
  let b, reloaded;
  const waitPreview = async (browser, pattern) => {
    for (let i = 0; i < 400; i++) {
      if (pattern.test(browser.find("#rewrite-output").textContent)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      "Preview did not update: " + browser.find("#rewrite-output").textContent,
    );
  };
  try {
    await createFixture(path);
    g(path, "switch", "-c", "rewrite-source");
    g(path, "commit", "--allow-empty", "-m", "work");
    g(path, "switch", "main");
    g(
      path,
      "merge",
      "--no-ff",
      "rewrite-source",
      "-m",
      "Merged PR 2556: XYZ123 Fix a bug",
    );
    const store = new ViewStore(join(dir, "views"));
    b = await browser(store);
    b.input("#path", path);
    await b.click('[data-action="open"]');
    await b.click('[data-action="add-rewrite"]');
    await waitPreview(b, /^XYZ123: Fix a bug$/);
    b.input("#rewrite-pattern-0", "[");
    await waitPreview(b, /Invalid rewrite/);
    assert.ok(b.find("#rewrite-output").classList.contains("error"));
    assert.equal(
      b.w.document.querySelector('[data-action="apply-rewrites"]'),
      null,
    );
    b.input(
      "#rewrite-pattern-0",
      String.raw`^Merged PR \d+:\s+([A-Z]+\d+)\s+(.+)$`,
    );
    await waitPreview(b, /^XYZ123: Fix a bug$/);
    assert.ok(
      ![...b.w.document.querySelectorAll("#diagram text")].some(
        (el) => el.textContent === "XYZ123: Fix a bug",
      ),
    );
    const initialSession = b.w.localStorage.getItem("git-outliner.session.v1");
    b.dom.window.close();
    b = await browser(store, initialSession);
    assert.equal(b.find("#rewrites-enabled").checked, true);
    await b.change("#rewrites-enabled", false);
    assert.ok(
      [...b.w.document.querySelectorAll("#diagram text")].some(
        (el) => el.textContent === "Merged PR 2556: XYZ123 Fix a bug",
      ),
    );
    assert.equal(
      JSON.parse(b.w.localStorage.getItem("git-outliner.session.v1")).view
        .rewritesEnabled,
      false,
    );
    await b.change("#rewrites-enabled", true);
    assert.ok(
      [...b.w.document.querySelectorAll("#diagram text")].some(
        (el) => el.textContent === "XYZ123: Fix a bug",
      ),
    );
    assert.match(
      b.find('#diagram [data-kind="merge"] title').textContent,
      /Merge/,
    );
    await b.change("#display-mode", "all");
    assert.equal(
      b.find('#diagram [data-kind="merge"] circle').getAttribute("r"),
      b.find('#diagram [data-kind="commit"] circle').getAttribute("r"),
    );
    assert.equal(
      b.find('#diagram [data-kind="merge"] text[aria-label="Merge"]')
        .textContent,
      "M",
    );
    await b.click('[data-action="save"]');
    const saved = (await store.list())[0];
    assert.equal(saved.rewrites[0].replacement, "$1: $2");
    await b.click('[data-action="svg"]');
    const svg = await b.downloads.at(-1).text();
    assert.match(svg, /XYZ123: Fix a bug/);
    assert.match(svg, /aria-label="Merge">M/);
    reloaded = await browser(store);
    await reloaded.change("#saved", saved.id);
    await reloaded.click('[data-action="load"]');
    assert.equal(reloaded.find("#rewrite-replacement-0").value, "$1: $2");
    assert.ok(
      [...reloaded.w.document.querySelectorAll("#diagram text")].some(
        (el) => el.textContent === "XYZ123: Fix a bug",
      ),
    );
    await reloaded.click('[data-rule-remove="0"]');
    assert.ok(
      [...reloaded.w.document.querySelectorAll("#diagram text")].some(
        (el) => el.textContent === "XYZ123: Fix a bug",
      ),
    );
    const removedSession = reloaded.w.localStorage.getItem(
      "git-outliner.session.v1",
    );
    reloaded.dom.window.close();
    reloaded = await browser(store, removedSession);
    assert.match(reloaded.find("#diagram").textContent, /Merged PR 2556/);
  } finally {
    b?.dom.window.close();
    reloaded?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("browser autosaves applied settings and drafts, restores live repository, and exports/imports without zoom or pan", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-session-ui-")),
    path = join(dir, "repo");
  let b, resumed, imported, missing;
  const key = "git-outliner.session.v1";
  try {
    const commits = await createFixture(path),
      store = new ViewStore(join(dir, "views"));
    b = await browser(store);
    b.input("#path", path);
    await b.click('[data-action="open"]');
    await b.change('[data-branch="refs/heads/staging"]', true);
    await b.change(`[data-event="${commits.main}"]`, false);
    await b.change("#display-mode", "all");
    await b.change("#show-metadata", false);
    await b.change("#single-line", true);
    await b.change("#spacing", "80");
    await b.change("#width", "400");
    b.input("#filter-patterns", "CTR-100\nCTR-201");
    await b.click('[data-action="filter"]');
    await b.click('[data-action="add-rewrite"]');
    b.input("#rewrite-pattern-0", "["); // An unapplied, invalid draft must survive.
    b.input("#rewrite-replacement-0", "$1 updated");
    b.input("#rewrite-sample", "Preview sample");
    b.input("#name", "Unsaved session");
    b.input("#filter-patterns", "Unapplied filter\nsecond line");
    b.input("#pattern", "[");
    b.input("#search", "foundation");
    const panel = b.find('[data-panel="presentation"]');
    panel.open = true;
    panel.dispatchEvent(new b.w.Event("toggle"));
    await b.click('[data-action="plus"]');
    const viewport = b.find("#viewport");
    viewport.scrollTop = 200;
    viewport.scrollLeft = 100;
    b.w.dispatchEvent(new b.w.Event("pagehide"));
    const raw = b.w.localStorage.getItem(key),
      snapshot = JSON.parse(raw);
    assert.equal(snapshot.repositoryPath, await realpath(path));
    assert.equal(snapshot.view.name, "Unsaved session");
    assert.equal(snapshot.view.visibility.overrides[commits.main], false);
    assert.equal(snapshot.ui.drafts.filter, "Unapplied filter\nsecond line");
    assert.equal(snapshot.ui.drafts.ticketPattern, "[");
    assert.equal(snapshot.ui.drafts.rewrites[0].pattern, "[");
    assert.doesNotMatch(
      raw,
      /"(?:scale|zoom|pan|scrollTop|scrollLeft|commits|events)"/,
    );
    // Live history changes while the page is closed; configuration must not freeze it.
    g(path, "switch", "-c", "session-new");
    g(path, "commit", "--allow-empty", "-m", "work");
    g(path, "switch", "main");
    g(path, "merge", "--no-ff", "session-new", "-m", "CTR-100 A new merge");
    const added = g(path, "rev-parse", "HEAD");
    resumed = await browser(store, raw);
    assert.equal(resumed.find("#path").value, snapshot.repositoryPath);
    assert.equal(resumed.find("#name").value, "Unsaved session");
    assert.equal(
      resumed.find("#filter-patterns").value,
      snapshot.ui.drafts.filter,
    );
    assert.equal(resumed.find("#pattern").value, "[");
    assert.equal(resumed.find("#rewrite-pattern-0").value, "[");
    assert.equal(resumed.find("#rewrite-replacement-0").value, "$1 updated");
    assert.equal(resumed.find("#rewrite-sample").value, "Preview sample");
    assert.equal(resumed.find("#search").value, "foundation");
    assert.equal(resumed.find("#show-metadata").checked, false);
    assert.equal(resumed.find("#single-line").checked, true);
    assert.equal(resumed.find("#spacing").value, "80");
    assert.equal(resumed.find('[data-panel="presentation"]').open, true);
    assert.equal(resumed.find("#zoom-label").textContent, "100%");
    assert.equal(resumed.find("#viewport").scrollTop, 0);
    assert.ok(
      resumed.w.document.querySelector(`#diagram [data-event="${added}"]`),
    );
    assert.equal((await store.list()).length, 0); // Autosave does not create named files.
    await resumed.click('[data-action="export-settings"]');
    const exported = await resumed.downloads.at(-1).text();
    assert.deepEqual(JSON.parse(exported), snapshot);
    imported = await browser(store);
    await imported.click('[data-action="import-settings"]');
    const file = imported.find("#settings-file");
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [{ size: exported.length, text: async () => exported }],
    });
    file.dispatchEvent(new imported.w.Event("change", { bubbles: true }));
    await imported.settle();
    assert.equal(
      imported.find("#filter-patterns").value,
      snapshot.ui.drafts.filter,
    );
    assert.equal(imported.find("#path").value, snapshot.repositoryPath);
    assert.equal(
      JSON.parse(imported.w.localStorage.getItem(key)).view.name,
      "Unsaved session",
    );
    const before = imported.w.localStorage.getItem(key);
    Object.defineProperty(imported.find("#settings-file"), "files", {
      configurable: true,
      value: [{ size: 2, text: async () => "{}" }],
    });
    imported
      .find("#settings-file")
      .dispatchEvent(new imported.w.Event("change", { bubbles: true }));
    await imported.settle();
    assert.equal(imported.w.localStorage.getItem(key), before);
    assert.ok(imported.w.document.querySelector(".error"));
    missing = await browser(
      store,
      JSON.stringify({ ...snapshot, repositoryPath: path + "/unavailable" }),
    );
    assert.equal(missing.w.document.querySelector("#diagram"), null);
    assert.equal(
      JSON.parse(missing.w.localStorage.getItem(key)).view.name,
      "Unsaved session",
    );
    assert.ok(missing.w.document.querySelector(".error"));
    await missing.click('[data-action="open"]');
    assert.equal(missing.find("#name").value, "Unsaved session");
    assert.equal(missing.find("#rewrite-pattern-0").value, "[");
  } finally {
    b?.dom.window.close();
    resumed?.dom.window.close();
    imported?.dom.window.close();
    missing?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("broken or unavailable browser storage leaves the app usable and warns visibly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-storage-ui-"));
  let corrupt, blocked;
  try {
    const store = new ViewStore(join(dir, "views"));
    corrupt = await browser(store, "{broken");
    assert.match(
      corrupt.find("#storage-status").textContent,
      /could not be read/,
    );
    assert.equal(
      corrupt.w.localStorage.getItem("git-outliner.session.v1"),
      "{broken",
    );
    blocked = await browser(store, undefined, true);
    assert.match(
      blocked.find("#storage-status").textContent,
      /could not be read/,
    );
    blocked.input("#path", "/some/repository");
    await blocked.click('[data-action="export-settings"]');
    assert.equal(
      JSON.parse(await blocked.downloads.at(-1).text()).ui.drafts
        .repositoryPath,
      "/some/repository",
    );
  } finally {
    corrupt?.dom.window.close();
    blocked?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("window resize rewraps a single lane while zoom and SVG export retain layout width", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-width-ui-")),
    path = join(dir, "repo");
  let b;
  try {
    await createFixture(path);
    b = await browser(new ViewStore(join(dir, "views")));
    const canvasStyle = b.w.document.createElement("style");
    canvasStyle.textContent = "#viewport { padding: 24px; }";
    b.w.document.head.appendChild(canvasStyle);
    let viewportWidth = 1000;
    Object.defineProperty(b.w.HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return this.id === "viewport" ? viewportWidth : 0;
      },
    });
    const waitWidth = async (expected) => {
      for (let i = 0; i < 400; i++) {
        const svg = b.w.document.querySelector("#diagram svg");
        if (svg?.getAttribute("width") === String(expected)) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("Reflow failed");
    };
    b.input("#path", path);
    await b.click('[data-action="open"]');
    await waitWidth(952);
    const svgBefore = b.find("#diagram svg").outerHTML;
    await b.click('[data-action="plus"]');
    assert.equal(b.find("#diagram svg").outerHTML, svgBefore);
    viewportWidth = 600;
    b.w.dispatchEvent(new b.w.Event("resize"));
    await waitWidth(552);
    assert.equal(b.find("#zoom-label").textContent, "120%");
    // A short viewport must not make Fit shrink the diagram to its height.
    Object.defineProperty(b.w.HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.id === "viewport" ? 40 : 0;
      },
    });
    await b.click('[data-action="fit"]');
    assert.equal(b.find("#zoom-label").textContent, "100%");
    assert.equal(parseFloat(b.find("#diagram").style.width), 552);
    assert.ok(parseFloat(b.find("#diagram").style.height) > 40);

    const screen = new JSDOM(b.find("#diagram svg").outerHTML, {
      contentType: "image/svg+xml",
    }).window.document;
    await b.click('[data-action="svg"]');
    const exported = new JSDOM(await b.downloads.at(-1).text(), {
      contentType: "image/svg+xml",
    }).window.document;
    assert.equal(exported.documentElement.getAttribute("width"), "552");
    assert.deepEqual(
      [...exported.querySelectorAll("[data-event] tspan")].map(
        (n) => n.textContent,
      ),
      [...screen.querySelectorAll("[data-event] tspan")].map(
        (n) => n.textContent,
      ),
    );
  } finally {
    b?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("version badges force ordinary nodes through diagram filters and exclusions and export as SVG", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-version-ui-")),
    path = join(dir, "repo");
  let b;
  try {
    await createFixture(path);
    g(path, "commit", "--allow-empty", "-m", "Set release version");
    const sha = g(path, "rev-parse", "HEAD");
    g(path, "tag", "v6.2.18", sha);
    b = await browser(new ViewStore(join(dir, "views")));
    b.input("#path", path);
    await b.click('[data-action="open"]');
    b.input("#filter-patterns", "not present in any message");
    await b.click('[data-action="filter"]');
    await b.click('[data-action="none"]');
    const event = b.find(`#diagram [data-event="${sha}"]`),
      badge = event.querySelector("[data-version]");
    assert.equal(badge.getAttribute("data-version"), "6.2.18");
    assert.equal(badge.querySelector("text").textContent, "6.2.18");
    const rect = badge.querySelector("rect"),
      circle = event.querySelector("circle");
    assert.equal(rect.getAttribute("fill"), "#dff3dc");
    assert.ok(Number(rect.getAttribute("rx")) > 0);
    assert.ok(Number(rect.getAttribute("x")) >= 0);
    assert.ok(
      Number(rect.getAttribute("x")) + Number(rect.getAttribute("width")) <
        Number(circle.getAttribute("cx")),
    );
    const check = b.find(`#events [data-event="${sha}"]`);
    assert.equal(check.checked, true);
    assert.equal(check.disabled, true);
    assert.equal(
      b.w.document.querySelectorAll("#diagram [data-event]").length,
      1,
    );
    await b.click('[data-action="svg"]');
    assert.match(await b.downloads.at(-1).text(), /data-version="6.2.18"/);
  } finally {
    b?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("node context menu copies SHA and edits multiline notes persisted in views and browser settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-notes-ui-")),
    path = join(dir, "repo");
  let b;
  try {
    const commits = await createFixture(path),
      store = new ViewStore(join(dir, "views"));
    b = await browser(store);
    let copied = "";
    Object.defineProperty(b.w.navigator, "clipboard", {
      value: {
        writeText: async (text) => {
          copied = text;
        },
      },
    });
    b.input("#path", path);
    await b.click('[data-action="open"]');
    const context = (selector) => {
      b.find(selector).dispatchEvent(
        new b.w.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 200,
          clientY: 200,
        }),
      );
    };
    context(`#diagram [data-event="${commits.main}"] circle`);
    assert.equal(b.w.document.querySelectorAll(".node-menu button").length, 4);
    await b.click(".node-menu [data-copy]");
    assert.equal(copied, commits.main);
    context(`#diagram [data-event="${commits.main}"] circle`);
    assert.deepEqual(
      [...b.w.document.querySelectorAll(".node-menu button")].map(
        (el) => el.textContent,
      ),
      ["Copy SHA", "Copy commit message", "Copy all", "Edit note"],
    );
    await b.click(".node-menu [data-copy-message]");
    const message = g(path, "show", "-s", "--format=%B", commits.main);
    assert.equal(copied, message);
    context(`#diagram [data-event="${commits.main}"] circle`);
    await b.click(".node-menu [data-copy-all]");
    assert.equal(copied, `${commits.main}\n${message}\n`);

    context(`#diagram [data-event="${commits.main}"] text[font-size="13"]`);
    await b.click(".node-menu [data-note]");
    const note = '\nFirst note line\n\nSecond line <script> & "quotes"\n';
    b.input("#node-note", note);
    await b.click('.note-dialog button[type="submit"]');
    context(`#diagram [data-event="${commits.main}"] circle`);
    await b.click(".node-menu [data-copy-all]");
    assert.equal(copied, [commits.main, message, note].join("\n"));
    const displayed = b.find(
      `#diagram [data-event="${commits.main}"] text[data-note]`,
    );
    assert.equal(displayed.getAttribute("font-size"), "11");
    assert.equal(displayed.getAttribute("fill"), "#78817d");
    assert.ok(displayed.querySelectorAll("tspan").length >= 3);
    assert.equal(b.w.document.querySelector("#diagram script"), null);
    assert.equal(
      JSON.parse(b.w.localStorage.getItem("git-outliner.session.v1")).view
        .notes[commits.main],
      note,
    );
    await b.click('[data-action="save"]');
    assert.equal((await store.list())[0].notes[commits.main], note);
    await b.click('[data-action="json"]');
    assert.equal(
      JSON.parse(await b.downloads.at(-1).text()).notes[commits.main],
      note,
    );
    await b.click('[data-action="svg"]');
    assert.match(await b.downloads.at(-1).text(), /data-note=/);
    await b.change("#show-notes", false);
    assert.equal(b.w.document.querySelector("#diagram text[data-note]"), null);
    const raw = b.w.localStorage.getItem("git-outliner.session.v1");
    b.dom.window.close();
    b = await browser(store, raw);
    assert.equal(b.find("#show-notes").checked, false);
    await b.change("#show-notes", true);
    assert.ok(b.w.document.querySelector("#diagram text[data-note]"));
    context(`#diagram [data-event="${commits.main}"] circle`);
    await b.click(".node-menu [data-note]");
    assert.equal(b.find("#node-note").value, note);
    b.input("#node-note", "cancelled change");
    await b.click(".note-dialog [data-cancel]");
    context(`#diagram [data-event="${commits.main}"] circle`);
    await b.click(".node-menu [data-note]");
    assert.equal(b.find("#node-note").value, note);
    await b.click(".note-dialog [data-delete-note]");
    assert.equal(b.w.document.querySelector(".note-dialog"), null);
    assert.equal(b.w.document.querySelector("#diagram text[data-note]"), null);
    assert.equal(
      JSON.parse(b.w.localStorage.getItem("git-outliner.session.v1")).view
        .notes[commits.main],
      undefined,
    );
  } finally {
    b?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ghost view option persists and exports filtered items faintly without changing exclusions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "outliner-ghost-ui-")),
    path = join(dir, "repo");
  let b;
  try {
    const commits = await createFixture(path),
      store = new ViewStore(join(dir, "views"));
    b = await browser(store);
    b.input("#path", path);
    await b.click('[data-action="open"]');
    await b.change(`[data-event="${commits.main}"]`, false);
    b.input("#filter-patterns", "no match in this history");
    await b.click('[data-action="filter"]');
    assert.equal(
      b.w.document.querySelectorAll("#diagram [data-event]").length,
      0,
    );
    assert.equal(b.w.document.querySelector("#policy"), null);
    assert.equal(b.find("#ghost-filtered").closest("details"), null);
    assert.equal(
      b.find("#ghost-filtered").closest("section"),
      b.find("#filter-patterns").closest("section"),
    );
    await b.change("#ghost-filtered", true);
    assert.ok(
      b.w.document.querySelectorAll("#diagram [data-event]").length > 0,
    );
    assert.ok(
      [...b.w.document.querySelectorAll("#diagram [data-event]")].every(
        (node) => node.getAttribute("opacity") === "0.4",
      ),
    );
    await b.click('[data-action="save"]');
    assert.equal((await store.list())[0].layout.ghostFiltered, true);
    await b.click('[data-action="svg"]');
    assert.match(await b.downloads.at(-1).text(), /opacity="0.4"/);
    const raw = b.w.localStorage.getItem("git-outliner.session.v1");
    b.dom.window.close();
    b = await browser(store, raw);
    assert.equal(b.find("#ghost-filtered").checked, true);
    assert.equal(
      JSON.parse(raw).view.visibility.overrides[commits.main],
      false,
    );
    await b.change("#ghost-filtered", false);
    assert.equal(
      b.w.document.querySelectorAll("#diagram [data-event]").length,
      0,
    );
  } finally {
    b?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
