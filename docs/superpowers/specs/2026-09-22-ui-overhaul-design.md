# Stepcast UI overhaul — design

Date: 2026-09-22. OpenSpec change: `openspec/changes/ui-overhaul`.

## Goal

Make the daemon UI (`stepcast up`, port 7717) presentable and understandable:
English throughout, shadcn-style components everywhere, no orphan screens,
no ghost projects from throwaway test runs, and a widget catalog that lets a
user add a widget to a project from the browser.

## Decisions (agreed with the user)

1. One OpenSpec change, one branch of work, no backlog items.
2. Translation scope: everything the browser shows. That is `ui/src`,
   screen titles in `src/parts/ui/screens/*/declaration.ts` (the sidebar is
   built from them), and daemon messages that reach the page through
   `/api/*` responses or the event stream (`error`, `hint`, `reason`,
   `sourceNote`, status labels). CLI output, code comments, docs and
   OpenSpec history stay Russian.
3. `/steps` is removed entirely: route, screen row, `/api/steps`, page,
   browser tests, daemon tests. The module `src/parts/ui/steps.ts` stays
   because the pipelines view reuses `paramViews` and `uses:` resolution.
4. Widget catalog is bundled: `src/builtin/widgets/*.tsx`.
5. Ghost projects are cleaned automatically by the daemon.

## Components (`@stepcast/ui`)

Existing: Button, Card, Table, Dialog, Tabs, Select, Input. Added, same
style (Radix where a primitive exists, CSS variables, no Tailwind):

| Component | Basis | Used by |
|---|---|---|
| `Badge` (`default`, `secondary`, `outline`, `destructive`, `success`, `running`) | plain span | statuses, layers, tiers |
| `Label` | `<label>` | forms on Agents, Settings, Routes |
| `Separator` | `<div role=separator>` | sidebar groups, page sections |
| `Alert` (`default`, `destructive`, `warning`) with `AlertTitle`, `AlertDescription` | plain div, `role=alert` | build errors, API failures |
| `Switch` | `<button role=switch>` | boolean settings |
| `Combobox` | own input + listbox, no Radix | model fields on Agents |
| `PageHeader` (`title`, `description`, `actions`) | plain | every screen |
| `EmptyState` (`title`, `description`, `action`) | plain | every list that can be empty |

No new dependencies: `Switch` is a `<button role="switch">`, `Combobox` is an
`<input role="combobox">` with its own listbox, tooltips are `title`
attributes. The shared-module table gains the new names and its version
becomes 2 (`SHARED_MODULE_TABLE_VERSION`).

`Combobox` contract: `value`, `options: {value,label,description?}[]`,
`onChange`, `placeholder`, `allowCustom` (typed text not in the list is
emitted as-is and rendered as a "custom" row), `searchPlaceholder`,
`emptyText`. Keyboard: arrows, Enter, Escape. Filtering is case-insensitive
substring on `value` and `label`.

## Shell

Sidebar keeps the routes-driven nav but renders groups. Routes gain an
optional `nav.group` string; built-in routes declare:

- `work`: Runs, Pipelines, Board, Backlog
- `extend`: Widgets, Routes, Proposals, Decisions
- `system`: Usage, Cleanup, Agents, Settings

Routes without a group render after the groups under no heading. Group
labels are capitalised keys (`Work`, `Extend`, `System`). Live-connection
indicator stays in the sidebar footer. Build-error bars use `Alert`.

## Screens

Every page gets `PageHeader` with a one-sentence description and uses
Card/Table/Badge/Button/Input/Select from `@stepcast/ui` instead of raw
elements and bespoke classes. Bespoke CSS in `ui/src/styles.css` is
reduced to layout (shell, content width), page-specific pieces (job graph,
diff view, board columns) and utility classes (`mono`, `dim`, `small`).

### Runs (`/`), Run detail, Pipelines, Backlog, Board, Usage, Decisions, Routes, Settings, Cleanup

Translated and restyled; behaviour unchanged except:

- Runs filter "all projects" lists project labels as the last path
  segment with the full path in the option title; unknown-path projects
  show `<key> (path unknown)`.
- Routes screen shows the built-in layer as `bundled` with no absolute
  path; home and project layers keep their paths.
- Cleanup shows a note that the daemon forgets projects whose directory no
  longer exists automatically at start-up (their run directories and usage
  records are removed). No manual "Forget" button: with automatic pruning
  there is nothing left to forget by hand.

### Widgets (`/widgets`)

Two sections.

**Catalog** — one card per file in `src/builtin/widgets/`. The card shows
the widget id, its description (first block comment of the file, first
paragraph), a live preview rendered by `WidgetHost` from the bundled
source (served at `/widgets/builtin/<id>.js?v=…`), and an "Add to project"
button. A `Select` of known projects (path exists) picks the target and the button
calls `POST /api/widgets/install` with `{ projectKey, id }`. The daemon
copies the file to `<project>/.stepcast/widgets/<id>.tsx`; it refuses with
409 when the target exists and 404 for unknown project or widget. Success
is reflected by the event stream (the installed widget appears in
"Installed").

Bundled widgets shipped: `clock` (moved from `examples/widgets/clock.tsx`,
examples keeps a copy), `projects` (known projects with last run), `active-runs`
(runs in `running` status), `usage-today` (cost and tokens for the current
day). All use only `@stepcast/ui`, `@stepcast/slots`, `react`.

**Installed** — per project (path exists, at least one widget), the
current cards: id, live render, stale-import notice, "Migrate" action.

### Agents (`/agents`)

Same data flow. The model fields become `Combobox` with `allowCustom`,
options from `GET /api/models`; a typed value not in the list is shown as a
`custom` badge instead of the old "off list" line. The list header shows
the discovery status in English. Codex keeps `unsupported`: its `--help`
names no models, so a probe would only turn “unsupported” into “unparsed”.
Instead the options of every Combobox include the names already saved in
configuration (default model and tiers), so a configured Codex model is
selectable, not only typed. The "reload models"
button stays.

### Proposals (`/proposals`)

- Header explains the entity: "Changes an agent proposed to this project's
  `.stepcast/` files. Nothing is written until you accept." with the CLI
  hint `stepcast propose <target> --from <file>`.
- Projects without proposals are not rendered; when no project has any,
  an `EmptyState` says so.
- Project heading is the last path segment, full path in a muted line.
- Tabs `Pending` / `Resolved`; resolved rows are a compact table (target,
  decision, time). Pending cards keep the diff and `Accept` / `Reject`.

## Ghost projects

`projects.json` gets an entry for every run, including runs from tests and
throwaway eval roots under `/var/folders`. New daemon-side rule:

- `listProjects` keeps returning everything (journal reader stays honest).
- New `pruneOrphanProjects(runsRoot)` in `src/parts/pipeline/run/cleanup.ts`:
  for each project with a known path that does not exist on disk, call
  `dropProjectEntry` (removes the index entry and the run directory) after
  removing the project's usage records.
  Projects with unknown path are left alone: the reader cannot prove they
  are dead.
- The daemon calls it once at start-up (`createUiServer`); the forgotten
  paths are logged once. Usage-store records of the pruned projects are
  removed too, otherwise the overview would resurrect the project from them.
- Runs, Pipelines, Proposals and Widgets views skip projects whose path
  does not exist, so a project deleted while the daemon runs disappears
  before the next prune.

## Error handling

- API failures render an `Alert` with the daemon's message.
- `POST /api/widgets/install` errors are shown inline in the card.
- The screen error boundary text becomes "This screen crashed: …".

## Testing

- `ui/test`: existing tests updated for English strings; new tests for
  `Combobox` (filter, custom value, keyboard), widget catalog install flow
  (mocked fetch), proposals empty state and project grouping, sidebar groups.
- `test/`: `pruneOrphanProjects` (drops missing-path project, keeps
  unknown-path and existing), `POST /api/widgets/install` (copies file,
  409 on duplicate, 404 on unknown), builtin widgets are listed and
  compile, codex model parsing from a fixture help text, routes schema
  accepts `nav.group`, `/api/steps` and `screen-steps` are gone.
- `npm run check` green.

## Docs

`docs/widgets.md` (catalog, install endpoint, bundled widgets),
`docs/routes.md` (`nav.group`), `docs/proposals.md` (screen description),
`docs/run-layout.md` or `docs/config.md` (orphan pruning), README screen
list if present.

## Non-goals

- i18n framework or language switching. Strings are English literals.
- Translating CLI output, comments, docs.
- Widget marketplace beyond the bundled folder.
- Editing or creating widgets in the browser.
