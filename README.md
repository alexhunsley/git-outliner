# Git Outliner

A local, read-only Git history visualiser. Choose one root and any number of local descendant branches, curate individual merges, and export a standalone SVG. Named tuned views persist selection rules and reapply them to current history.

The interface uses **HTML, CSS and TypeScript with native DOM APIs**. Vite serves and builds the frontend; a Node/Express backend reads Git. There is no React, authentication, cloud service, ticket-service integration or external font dependency.

## Run

Requires Node.js 24 (see `.node-version`), npm and Git on PATH.

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:4317**. The server binds to loopback and rejects other Host headers and cross-origin requests. Source changes require a browser refresh; a second development WebSocket listener is disabled. Set `PORT` to change the HTTP port.

For a production build:

```sh
npm run build
npm start
```

## Try the demo

```sh
npm run demo
```

The script creates `.demo/` and prints its absolute path. It refuses to overwrite an existing directory. Open that path in the app. Select `main` as the root, then `staging` and `release/1.0`. Expect three lanes and five merge events: two on main, one unique to staging, and two unique to release. The fixture includes duplicate ticket IDs, multiple tickets in a body, punctuation, and a ticket-less merge. Its ephemeral source branches are deleted.

## Use

1. Enter the absolute path to a local working-tree repository. Bare repositories are currently unsupported.
2. Set the diagram root and check additional local branches. The root need not be the repository's initial branch, or have a tip that is an ancestor of descendant tips.
3. Choose **All commits** or **Merges & branching points only**. The latter hides ordinary single-parent commits but keeps selected-lane fork points. Use **Filter diagram by text** and **Apply filter** to show only matching commit markers: enter one literal pattern per line (any line may match, case insensitive). Messages, tickets and SHAs are searched; blank lines are ignored and an empty box clears the filter. Structural branch connections stay visible for context. Both settings are saved with the view.
4. Search the branch-grouped merge checklist by ticket, SHA or message. Check/uncheck individual merges, use global or branch all/none, or reset overrides. Search filters the checklist only; bulk actions cover candidates in the current display mode and diagram filter, including those hidden by checklist search.
5. Adjust ticket regex, default visibility, event spacing, lane width and compact labels. Drag to pan, scroll to explore, zoom or fit the diagram. Hover SVG labels for full commit messages and SHAs. Subjects appear once and wrap in full within the current lane width. Labels and branch headings grow to fit their text; compact mode hides date/SHA metadata but still wraps the complete subject.
6. Name and save the view. Create, duplicate, rename or delete views from the sidebar. JSON import creates a new unsaved view ID to avoid overwriting an existing saved view. Save it to retain it across restarts.
7. Refresh/regenerate to reread Git. Export SVG also rereads Git before rendering. Export JSON contains current rules, including unsaved edits; it contains no history graph. Unsaved changes prompt before switching views; closing the tab retains them in browser storage.

## Automatic browser settings

The page automatically saves the current session to local storage (`git-outliner.session.v1`) as settings change and when the page closes. On the next visit it restores the last opened **local repository path**, rereads current Git history, and reapplies the current view without needing to save or load a named view.

This includes unsaved view changes, selected branches and root, commit visibility overrides, filters, ticket parsing, rewrite rules, layout preferences, checklist search, the selected saved-view menu item, open/collapsed panels, the rewrite preview sample, and unapplied filter/regex/rewrite drafts. Invalid or incomplete regex drafts are preserved as text without applying them. **Zoom and pan are deliberately not stored**; each visit starts at 100% with the diagram at its origin.

**Export settings** and **Import settings** transfer the same session as a versioned JSON file. This is separate from named **Save/Load view** and **Import/Export view JSON**: named views remain repository-bound configurations in the app's files, while browser settings also include transient controls and unfinished edits. Import validates the settings and rereads the repository before replacing the current session. No history graph or SVG is stored in local storage or settings JSON. Settings imports are limited to 2 MB.

The settings envelope is `{ format: "git-outliner-settings", version: 1, repositoryPath, view, dirty, ui: { query, selectedView, expanded, drafts } }`; `src/session.ts` defines the validated schema. Drafts contain the repository input, unapplied filter and ticket regex, rewrite rules, whether rule edits are pending, and the preview sample. `view` contains the applied v1 tuned-view configuration (or null before opening a repository). An unfinished view name is allowed in browser settings; named-view saves still require a nonempty name.

Browser storage belongs to the current origin (host and port). Changing the port or clearing browser data starts a separate session; use settings export/import to transfer it. If a repository is unavailable at startup, its settings are retained and a read error is shown; reopen the matching repository to resume. Malformed/unsupported stored settings are reported and retained until you open a repository or import valid settings. Storage failures are reported without preventing manual use or settings export. A successful browser autosave allows closing the tab without a named-view save prompt; explicit switches to other views still ask before discarding unsaved edits.

## Message rewrites and markers

Under **Message rewrites**, add ordered regex rules with a **Match regex** and **Replace with** template. Parentheses capture text; `$1`, `$2`, etc. insert those captures. For example:

```text
Match:        ^Merged PR \d+:\s+([A-Z]+\d+)\s+(.+)$
Replace with: $1: $2

Merged PR 2556: XYZ123 Fix a bug → XYZ123: Fix a bug
```

The editable sample provides a live preview. Move rules up/down to change their order; each replaces its first match in the current subject, then passes the result to the next rule. Unmatched subjects stay unchanged. No slash delimiters or regex flags are needed. Invalid expressions display an error. **Apply rewrites** regenerates labels; **Save** also applies pending rule edits. JSON export includes pending rule edits. Rules persist with the tuned view and survive JSON import/export; older views default to no rules.

Rewriting changes presentation only: the diagram, checklist and SVG use rewritten subjects, while hover details retain original messages. Diagram filtering, checklist search and ticket extraction use original Git data. Git commits are never edited. Rewrites execute in a worker with a two-second deadline, including previews.

Every commit marker has the same circle size. A plain circle is an ordinary commit; an **M inside the circle** denotes a merge (two or more parents, including octopus merges). These remain vector shapes and text in SVG exports. Small ancestry junction dots are structural fork indicators.

## History, ownership and ancestry

Extraction uses `git log --first-parent` with NUL-separated fields, retains all first-parent commits for ancestry, and selects commits with two or more parents as merge events (including octopus merges). Each event retains its SHA, parents, timestamp, full message and extracted tickets. The default regex is `\b[A-Z][A-Z0-9]+-\d+\b`; repeated tickets within one message are deduplicated. Different merge SHAs with the same ticket remain independent. Ticket-less merges use subject/SHA labels. Squash merges, rebased changes and cherry-picks with one parent are not classified as merges; they appear in All commits mode if on a selected first-parent segment.

**Ownership rule:** process the root first, then descendants in selection order (the order stored in `branches`). The first lane whose first-parent history contains a commit owns it. Shared history is therefore shown once, for both ordinary commits and merges. Descendant lanes contain only unclaimed commits. An identical-history descendant can have an empty segment. To change descendant ownership priority, deselect/reselect branches, or reorder `branches` in exported JSON. Hiding events never changes ownership or the underlying graph.

A displayed descendant must share a commit on its first-parent lineage with the root's first-parent lineage. For each descendant, the connection uses its nearest common first-parent ancestor with an already displayed lane. A closer shared ancestor with an earlier selected descendant takes priority over a more distant root ancestor. This supports nested descendants without requiring root-tip ancestry.

**Every branch connection is dashed and explicitly inferred.** Shared Git ancestry cannot recover historical branch creation, original named-branch ownership or fork direction. The user-designated root supplies visual direction, not a claim about branch creation. A related branch whose relationship requires traversing second parents only is conservatively withheld with a warning. Unrelated histories are also withheld. The app never infers forks from branch names or draws lanes for unselected source branches. No cross-lane merge arrows are currently drawn.

Commit rows follow Git’s newest-first topological ordering of current selected tips, rather than timestamp sorting. The timeline runs **newest at the top, oldest at the bottom**: descendants appear above their ancestors even with clock skew. Descendant lanes extend upward from their older inferred fork points. Non-visible events are omitted from layout; the commit graph still determines ordering. Inferred ancestors get layout rows even when they have no visible merge marker. SVG generation is deterministic for the same extracted history and view settings. Measured, wrapped labels determine row heights to prevent collisions; the event-spacing preference remains a minimum. Lane widths and global rows remain fixed in this first layout stage.

## Tuned views and JSON v1

Views are stored as individual JSON files under `~/.git-outliner/views/`. Override the directory with `GIT_OUTLINER_DATA_DIR` (choose a directory outside your repositories). Saves use a temporary file and atomic rename. Configuration files are separate from repository data; saving never invokes a Git mutation. Invalid saved files produce an error rather than silently disappearing.

`src/model.ts` defines the strict, validated v1 schema. Unknown fields and unsupported versions are rejected. The exported shape is:

```text
{
  version: 1,
  id: UUID,
  name: nonempty string (max 120),
  repository: {
    roots: [full root-commit SHAs],
    fingerprint: SHA-256 of sorted roots joined by newline,
    pathHint: absolute local path
  },
  root: "refs/heads/main",
  branches: ["refs/heads/main", "refs/heads/staging", ...],
  visibility: {
    default: "include" | "exclude",
    overrides: { "<full commit SHA>": true | false, ... }
  },
  rewrites: [{ pattern: regex source, replacement: "$1: $2" }, ...],
  tickets: { pattern: JavaScript regex source (no slash delimiters or flags) },
  display: { mode: "merges" | "all", patterns: multiline literal text },
  layout: { spacing: integer 48..220, laneWidth: integer 240..600, compact: boolean }
}
```

`rewrites` defaults to an empty array, with a maximum of 20 rules (pattern up to 500 characters, replacement up to 2,000). Patterns must be valid JavaScript regular expressions.

`display` defaults to `{ mode: "merges", patterns: "" }` when absent, so existing v1 saved views remain compatible. The filter intersects explicit visibility rules; it does not erase overrides or remove ancestry links.

`branches` contains 1–64 unique local refs and must contain `root`. IDs are UUIDs; event identifiers are full SHA-1 or SHA-256 Git object IDs, never tickets or list positions. `true` means explicitly included, `false` explicitly excluded; absence means follow the default policy. Global reset clears all explicit overrides, including unresolved ones; individual reset removes just one override. New discovered merges follow the saved default (initially include).

Repository identity uses root commit hashes reachable from local branches, not the path alone. The fingerprint is checked against the saved roots and those roots must be present in the current repository. Additional roots are allowed, so adding an orphan branch does not invalidate a saved view. A clone with the same root history is considered the same repository. Rewriting/removing an identity root or deepening a shallow clone can require a new view. The path is only a hint: to import/load a view moved from another machine, first open its matching local repository. Otherwise the app tries the saved path. Wrong repository identity is an actionable error, never an automatic rebinding.

## Reconciliation

Every load, history refresh, selection change, presentation regeneration and SVG export resolves local refs and rereads Git. History is never persisted in view JSON.

- A missing branch remains configured and is listed as unresolved. Reassign it explicitly using the warning controls, or remove a missing descendant. A missing root must be reassigned; dependent lanes are withheld until then.
- An ancestry relationship that cannot be established gets a warning and no lane. Choose another root/branch, or remove the selection. Inferred relationships always have notices; these are collapsible when there are no unresolved selections.
- A commit override whose SHA is absent from selected first-parent histories is retained and reported. It is reapplied if that exact SHA returns. Reset it, or use the explicit commit selection and confirmation to move it to another SHA. Tickets never trigger automatic remapping.
- New merges follow the default policy; exclusions survive a refresh or app restart.
- If a history read fails, the app clears the displayed graph rather than exporting stale repository data. Shallow histories receive an incompleteness notice.

## Safety and limits

Git commands use argument arrays and validated refs resolved to commit hashes. Application reads use only `rev-parse`, `for-each-ref`, `rev-list` and `log`; optional Git locks and replacement objects are disabled. No checkout, fetch, reset, index write or repository configuration change is performed. Fixture scripts and tests deliberately write only newly generated demo/test repositories.

Git subprocesses have a 30-second timeout and 64 MB output limit per command. Oversized histories fail explicitly instead of silently truncating. Ticket expressions execute in a worker with a two-second deadline so a pathological regex cannot block the local server. JSON requests/files are limited to 2 MB. There is no arbitrary branch count hardcoded into the renderer, but views are limited to 64 refs to bound work. Large histories can be slow: first-parent extraction currently runs per branch and SVG rows are not virtualised. The UI rereads after each selection change; there is no background filesystem watcher. PNG export and remote-tracking refs are not included in this iteration.

## Verify and structure

```sh
npm test
npm run build
```

Tests generate isolated repositories in the system temp directory and cover ticket parsing, NUL-delimited extraction, shared-history ownership, nested inferred ancestry, visibility, deterministic vector SVG, live merges, disappearing refs/SHAs, schema validation, repository identity, persistence and Git state preservation. A jsdom interaction test exercises the native DOM UI against the real extraction and persistence modules, including save/reload, branch reassignment and JSON/SVG export; it does not replace visual testing in a browser.

- `server/git.ts`: safe Git reads, current repository identity and reconciliation.
- `server/store.ts`: validated, atomic tuned-view persistence.
- `server/index.ts`: loopback HTTP API and Vite/static hosting.
- `src/session.ts`: validated browser session settings and local-storage persistence.
- `src/model.ts`: v1 schema, ticket parser and visibility rules.
- `src/rewrite.ts`, `server/rewrite.ts`: ordered capture replacements and bounded worker execution.
- `src/layout.ts`: deterministic layout model and standalone SVG rendering.
- `src/main.ts`, `src/style.css`: native DOM interface and styling.
- `scripts/fixture.ts`, `scripts/demo.ts`: reproducible demo repository generator.
