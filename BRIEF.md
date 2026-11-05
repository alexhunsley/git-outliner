# Brief: Local Git Merge & Ticket Visualiser

## Goal
Build a local, read-only web application that turns real Git repository history into a curated, presentation-quality **SVG diagram**. Users choose exactly one diagram root branch and any number of descendant branches to display, then individually include or exclude merge events. The result is a **saved, repository-bound tuned view**: a reusable set of selections and presentation rules applied to freshly read Git history each time, not a detached snapshot of a diagram. Ticket identifiers (e.g. `CTR-123`) come from merge commit messages. The diagram shows only the selected branches as persistent lanes; other branches must not appear as lanes.

## Core workflow
1. Open a local Git repository (path supplied by user; no remote service required).
2. List available branches. Require the user to designate exactly one selected branch as the diagram root, then select any number of additional branches as descendants. The root is the logical root of the visualisation, not necessarily the repository’s initial commit.
3. Read the selected branches' Git histories and identify merge commits on their first-parent histories. Extract commit SHA, parent SHAs, timestamp, subject/body, and ticket IDs using a configurable regex (default `\b[A-Z][A-Z0-9]+-\d+\b`).
4. Show a searchable, branch-grouped checklist of merge events with ticket ID(s), subject, date and short SHA. Each merge can be included or excluded independently. Provide select all/none and per-branch controls.
5. Render the selected branches as vertical lanes (history flows top-to-bottom), with included merge events/tickets as horizontally readable labelled markers on their destination lanes. Hide all unselected branches, including branches that contributed to selected merges. Only draw cross-lane connections when they represent verified ancestry between selected branches and are useful to the diagram.
6. Save the tuned view locally and support importing/exporting it as JSON. Reapply it to the live repository history whenever the view is opened, refreshed, or the diagram is regenerated.
7. Export the diagram as standalone SVG (and optionally PNG). SVG labels should remain vector text.

## Persistent tuned views and reconciliation (essential)
- A **tuned view** is a named, editable configuration **bound to a specific Git repository**, not a saved SVG, frozen list of commits, or manually authored graph. Users can create, rename, duplicate, save, load, delete, import and export tuned views. Persist them locally across app restarts (e.g. in app-managed local storage/files); never require committing anything to the repository or modifying Git state.
- JSON export/import must use a documented, versioned schema. Store the root branch ref, selected branch refs, merge visibility overrides, ticket parsing settings and any diagram/layout preferences. Use stable Git commit SHAs as merge-event identifiers (not list indices, dates or ticket IDs). Include repository identity metadata sufficient to detect accidental application to the wrong repo; do not rely solely on an absolute local path, which may differ across machines.
- **Git is always re-read.** On every load/refresh/regeneration, resolve the configured branch refs and re-extract the actual current history, then apply the saved configuration as an overlay. New matching merges should appear automatically by default unless the view's explicit policy says otherwise. Previously excluded merge SHAs remain excluded if they still exist in the relevant history. The exported JSON is a set of rules and overrides, not a serialized copy of the Git graph.
- Use a clear default visibility policy (suggested: include all discovered merges unless explicitly excluded). Preserve explicit overrides, even if the corresponding commit is temporarily absent, so they can be reapplied if it returns. Allow users to reset individual overrides to the default.
- **Reconcile changes transparently:** if a configured branch is renamed, deleted or no longer reachable; a merge SHA disappears because of a rebase/force-push; or the selected root/descendant relationship changes, show an actionable warning and identify unresolved selections. Do not silently remap a missing SHA to another merge merely because it has the same ticket ID, and do not fabricate branch ancestry. Offer explicit reassignment/remapping controls when appropriate.
- Keep repository data and view configuration separate in code. The SVG is a deterministic rendering of **current Git history + saved tuned view**. Saving or importing a view must never change commits, refs, working-tree files or the index.

## Diagram requirements
- Vertical timeline: history flows top-to-bottom, selected branch lanes run vertically, and ticket/merge labels read horizontally without rotation. Provide clear visual hierarchy, adjustable spacing, zoom/pan, and a fit-to-view action.
- Support arbitrary numbers of selected branches, not a fixed two-lane layout. One selected branch is always the designated root; every other displayed branch must be a Git-ancestry-supported descendant of that root (directly or through another displayed branch). Validate this relationship and explain when it cannot be established rather than drawing a fictitious fork.
- Lay out the designated root as the visual origin, with descendant lanes branching from their actual or defensibly inferred divergence points. Show divergence/branch-off relationships **only when supported by Git ancestry**. Never infer a fork point from branch names. Where the exact historical branch creation point cannot be recovered, indicate an inferred common ancestor or omit the branch-off connection rather than presenting it as certain.
- Events must remain in historically valid order. Hiding an event affects only the presentation, never the underlying Git graph.
- Multiple merges can reference the same ticket; treat them as distinct events keyed by SHA.
- Allow ticket-less merge commits; show their subject or short SHA.
- No lanes for ephemeral feature, hotfix, or other unselected branches.
- Keep the layout legible when branches have many merges; allow compact labels or collision avoidance.

## Data and correctness
- Git repository is the source of truth; no Jira, GitHub, or other API is required.
- Use `git log --first-parent --merges` per selected branch as an initial extraction method, plus parent/ancestry queries for topology. Account for merges, rebases, cherry-picks, deleted branches, and histories where a branch's original fork point cannot be proven.
- Branch names are movable refs, not persistent historical identities. Avoid falsely attributing shared first-parent commits to a branch when its history overlaps with another selected branch; define and document a consistent ownership/segment rule.
- Handle unusual commit messages, special characters in branch names, and large repositories safely. Invoke Git with argument arrays, not shell interpolation.
- Never run Git commands that modify repository state.

## Suggested implementation
- Local web UI: React + TypeScript + Vite.
- Local backend: Node.js + TypeScript, spawning read-only Git commands with validated repository paths and safe arguments.
- SVG rendered from a deterministic layout model (e.g. custom SVG/React, optionally using a layout library if it materially improves label placement).
- No authentication or cloud deployment needed. Bind the local server to `127.0.0.1` by default.
- Keep extraction, event selection, graph layout, and SVG rendering as separate modules.

## Deliverables
- Working app with startup instructions (`npm install`, `npm run dev` or equivalent).
- Unit tests for ticket parsing, merge extraction, branch ancestry/overlap, event visibility, JSON schema validation, persistence and reconciliation.
- Integration tests using generated temporary Git repositories with multiple branches and merges.
- README documenting assumptions, known limitations, tuned-view JSON schema/import/export, reconciliation behaviour and SVG export.
- A representative demo repository or fixture that makes it easy to verify the diagram.

## Acceptance criteria
- Selecting a root and two or more descendants shows exactly those selected branches as lanes, with the designated root visually identifiable.
- Each selected branch displays its merge commits with extracted `CTR-123`-style ticket labels.
- Toggling one merge immediately adds/removes its marker without changing other events or Git history.
- Unselected source branches never appear as lanes.
- Divergence links are accurate or explicitly qualified when the historical fork point is unknowable.
- Exported SVG matches the current selection, is readable in a browser and vector editor, and works offline.
- A saved tuned view survives restarting the app; its exported JSON can be imported to restore the same branch and merge-selection rules against the same repository.
- After a new merge is added to a selected branch, reopening or refreshing a tuned view reads the updated Git history and shows the new merge according to the default visibility policy, while retaining existing exclusions.
- After a merge is rewritten or a selected branch disappears, the app reports unresolved references instead of silently showing stale data or incorrectly matching events by ticket number.
- The view JSON does not need to contain a full Git commit graph, and importing/exporting it never modifies the repository.

## Product decisions
- Confirmed: vertical timeline (top-to-bottom) with horizontal, readable ticket labels.
- Confirmed: one user-designated branch is the diagram root; all other displayed branches descend from it. Show ancestry-backed branch-off connections and clearly qualify any fork point that cannot be established from Git history.
- Implementation note: a current branch tip being a descendant of the root tip is not required; validate ancestry relative to the root branch’s historical lineage/common ancestor. Git cannot always prove which named branch a historical commit belonged to, so ambiguous lineage must be surfaced, not guessed.

- Confirmed: tuned views must persist locally, be importable/exportable as JSON, and be reconciled against fresh Git history on every regeneration; they must never become detached diagram snapshots.
