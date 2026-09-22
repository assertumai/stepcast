# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** English, shadcn-styled Stepcast UI with the `/steps` screen removed, a bundled widget catalog, model comboboxes on Agents, an understandable Proposals screen and automatic pruning of ghost projects.

**Architecture:** Server-side changes live in `src/parts/ui` (screen rows, API handlers) and `src/parts/pipeline/run/cleanup.ts` (pruning). Browser changes live in `ui/src` with new primitives in `ui/src/ui` (`@stepcast/ui`). Spec: `docs/superpowers/specs/2026-09-22-ui-overhaul-design.md`.

**Tech Stack:** TypeScript, React 19, Radix UI, Vite, Node test runner (`node --test`), esbuild for widgets.

Verification after every task: `npm run typecheck && npm run typecheck:ui && npm run lint`, and the task's tests. Before the final commit: `rm -rf dist && npm run check`.

---

### Task 1: Remove `/steps`

**Files:**
- Delete: `ui/src/pages/Steps.tsx`, `ui/src/screens/steps.tsx`, `src/parts/ui/screens/steps/{declaration,server}.ts`
- Modify: `ui/src/screens/index.ts`, `ui/src/api.ts` (drop `fetchSteps`/types if unused elsewhere), `src/parts/ui/rows.ts` (drop `stepsRow`), `src/builtin/routes.yml` (drop `screen-steps`, renumber orders), `ui/test/screens.test.tsx`, `test/ui-server.test.ts`, `test/ui-screens.test.ts`, `test/plugin-tree.test.ts` (baseline of rows), `docs/pipeline-format.md` (mention of the screen), `src/builtin/steps/README.md` if it names the screen.
- Keep: `src/parts/ui/steps.ts` (`buildSteps`, `paramViews` are used by pipelines view).

- [ ] Grep `screen-steps|/api/steps|fetchSteps|Steps\b` in `ui test src docs`; remove every reference.
- [ ] Add assertion in `test/ui-server.test.ts`: `GET /api/steps` returns 404 and `/api/screens` has no `screen-steps`.
- [ ] Build + tests green.

### Task 2: Prune ghost projects

**Files:**
- Modify: `src/parts/pipeline/run/cleanup.ts` — export `pruneOrphanProjects(runsRoot): string[]` using `listProjects` and `dropProjectEntry`.
- Modify: `src/parts/ui/daemon/server.ts` — call it in `createUiServer` before the watcher starts; log `forgot N orphaned project(s)`.
- Modify: `src/parts/ui/screens/cleanup/server.ts` — call it on `GET`; add to response `orphans: {key,path}[]` (empty after prune, kept for the UI note) and support `DELETE` with `{ projects: [key] }` for "Forget" on unknown-path projects? No: unknown-path projects stay untouched (spec). Forget button targets only `missing`-path projects, which prune already removed, so the UI section shows what was pruned this request: `pruned: string[]`.
- Modify: `src/parts/ui/runsView.ts`/`overview.ts`, `pipelines.ts`, `proposals.ts`, `widgets.ts` — skip projects with `path` set but missing on disk.
- Test: `test/run-cleanup.test.ts` (or new `test/prune-orphans.test.ts`): three projects (existing path, missing path, unknown path) → only missing is dropped, index rewritten, dir removed.

### Task 3: Routes `nav.group`

**Files:**
- Modify: `src/parts/ui/routesFile.ts` (`RouteNavSchema.group: z.string().min(1).optional()`, merge field `navGroup`, output `group`), `schema/` regeneration if routes schema is generated (`npm run schema`), `src/builtin/routes.yml` (groups `work`, `extend`, `system`), `docs/routes.md`.
- Test: `test/ui-routes-file.test.ts` (find the existing routes-file test) — group parsed and overridable by layer.

### Task 4: New `@stepcast/ui` primitives

**Files:**
- Create: `ui/src/ui/{badge,label,separator,alert,switch,tooltip,combobox,pageHeader,emptyState}.tsx` and `.css` siblings; export from `ui/src/ui/index.ts`.
- Modify: `package.json` devDependencies (`@radix-ui/react-popover`, `@radix-ui/react-switch`, `@radix-ui/react-tooltip`), `vite.config.ts` if Radix packages are listed for the shared bundle.
- Test: `ui/test/components.test.tsx` — Badge variants, Combobox filter/custom/keyboard, EmptyState renders action.

### Task 5: Shell in English with groups

**Files:**
- Modify: `ui/src/plugins/shell.tsx` (grouped nav, English labels, Alert for build errors), `ui/src/plugins/navItem.tsx`, `ui/src/styles.css` (sidebar group heading), `ui/test/shell.test.tsx`.

### Task 6: Translate daemon-visible strings

**Files:**
- Modify: `src/parts/ui/screens/*/declaration.ts` titles (Runs, Run, Pipelines, Decisions, Widgets, Backlog, Board, Usage, Cleanup, Agents, Settings, Routes, Proposals), and `error`/`hint`/`reason`/`sourceNote` strings in `src/parts/ui/**` that reach `/api/*` or the event stream. Update the corresponding `test/ui-*.test.ts` expectations.
- Method: grep Cyrillic in `src/parts/ui/**/*.ts` excluding comments; translate string literals that are sent to the browser.

### Task 7: Translate and restyle pages

One sub-task per page, each on `@stepcast/ui` with `PageHeader`:
Runs, RunDetail, Pipelines, Backlog, Scrum (Board), Usage, Decisions, Routes + RoutesEditor, Settings, Cleanup (+ orphan note), components (FileView, StepOutput, JobGraph), `widgetHost.tsx`, `main.tsx`, `services/styles.ts`. Update `ui/test/*.test.tsx` strings.

### Task 8: Widget catalog

**Files:**
- Create: `src/builtin/widgets/{clock,projects,active-runs,usage-today}.tsx`.
- Modify: `src/parts/ui/widgets.ts` — `listBuiltinWidgets(): {id, description}[]` (description = first paragraph of the leading block comment), `builtinWidgetFile(id)`; `src/parts/ui/daemon/server.ts` — serve `/widgets/builtin/<id>.js` through the same compiler; `src/parts/ui/screens/widgets/server.ts` — `GET /api/widgets/catalog`, `POST /api/widgets/install` `{projectKey,id}` → copies file, 409 if exists, 404 unknown.
- Modify: `ui/src/pages/Widgets.tsx` (Catalog + Installed), `ui/src/api.ts`, `ui/src/widgetHost.tsx` (accept `builtin` project key), `docs/widgets.md`, `examples/widgets/clock.tsx` stays.
- Test: `test/ui-widgets-catalog.test.ts` (list, compile each bundled widget, install copies, 409, 404); `ui/test/widgets.test.tsx` (catalog renders, install calls API).

### Task 9: Agents combobox + Codex models

**Files:**
- Modify: `ui/src/pages/Agents.tsx` (Combobox per tier, `custom` badge, English), `src/parts/backends/codex/adapter.ts` + `index.ts` (`codexModelDiscovery`: probe `codex --help`, parse quoted names near `--model`), `test/backend-codex*.test.ts` fixture help text, `ui/test/screens.test.tsx`.

### Task 10: Proposals

**Files:**
- Modify: `ui/src/pages/Proposals.tsx` (header, hide empty projects, Pending/Resolved tabs, project name from path), `ui/test/proposals.test.tsx`, `docs/proposals.md`.

### Task 11: Final

- `rm -rf dist && npm run check` green.
- Screenshots of `/`, `/widgets`, `/agents`, `/proposals`, `/cleanup` in the browser.
- OpenSpec `openspec/changes/ui-overhaul/{proposal,design,tasks}.md` with tasks checked.
- Commit.
