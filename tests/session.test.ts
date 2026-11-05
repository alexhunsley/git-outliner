import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SettingsSchema,
  SESSION_KEY,
  readSettings,
  writeSettings,
} from "../src/session.ts";
import { newView } from "../src/model.ts";
test("browser settings preserve incomplete drafts, reject unsupported data and contain no Git graph or navigation state", () => {
  const sha = "a".repeat(40);
  const view = newView({
    path: "/repo",
    identity: { roots: [sha], fingerprint: "b".repeat(64), pathHint: "/repo" },
    branches: [{ ref: "refs/heads/main", sha }],
  });
  view.name = "";
  const input = {
    format: "git-outliner-settings",
    version: 1,
    repositoryPath: "/repo",
    view,
    dirty: true,
    ui: {
      query: "search",
      selectedView: "",
      expanded: { presentation: true },
      drafts: {
        repositoryPath: "/repo",
        filter: "draft\nfilter",
        ticketPattern: "[",
        rewrites: [{ pattern: "[", replacement: "$1" }],
        rewritePending: true,
        rewriteSample: "sample",
      },
    },
  };
  const settings = SettingsSchema.parse(input);
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
  assert.equal(readSettings(storage), undefined);
  writeSettings(storage, settings);
  assert.deepEqual(readSettings(storage), settings);
  assert.doesNotMatch(
    entries.get(SESSION_KEY)!,
    /"(?:zoom|pan|scale|commits|events|scrollTop)"/,
  );
  assert.equal(
    SettingsSchema.safeParse({ ...input, version: 2 }).success,
    false,
  );
  assert.equal(
    SettingsSchema.safeParse({ ...input, zoom: 1.2 }).success,
    false,
  );
  assert.equal(
    SettingsSchema.safeParse({ ...input, view: { ...view, branches: [] } })
      .success,
    false,
  );
  storage.setItem(SESSION_KEY, "broken");
  assert.throws(() => readSettings(storage));
  assert.throws(
    () =>
      writeSettings(
        {
          setItem() {
            throw new Error("Quota");
          },
        },
        settings,
      ),
    /Quota/,
  );
});
