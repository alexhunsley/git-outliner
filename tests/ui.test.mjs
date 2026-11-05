import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { buildSync } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
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
async function browser(store) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://127.0.0.1:4317",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const w = dom.window;
  const downloads = [];
  let pending = 0;
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
    assert.match(b.find("#diagram").innerHTML, /inferred/);
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
    await b.click('[data-action="apply-rewrites"]');
    assert.ok(b.w.document.querySelector(".error"));
    b.input(
      "#rewrite-pattern-0",
      String.raw`^Merged PR \d+:\s+([A-Z]+\d+)\s+(.+)$`,
    );
    await waitPreview(b, /^XYZ123: Fix a bug$/);
    await b.click('[data-action="apply-rewrites"]');
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
    await reloaded.click('[data-action="apply-rewrites"]');
    assert.match(reloaded.find("#diagram").textContent, /Merged PR 2556/);
  } finally {
    b?.dom.window.close();
    reloaded?.dom.window.close();
    await rm(dir, { recursive: true, force: true });
  }
});
