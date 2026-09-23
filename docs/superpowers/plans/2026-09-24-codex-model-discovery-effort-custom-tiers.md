# Codex Model Discovery, Effort, and Custom Tiers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stepcast discover the current Codex model catalog through `codex debug models`, configure inherited reasoning effort, and manage shared custom model tiers containing model/effort pairs.

**Architecture:** Extend the backend-neutral model-discovery contract with optional display and effort metadata, then let the Codex plugin parse the CLI catalog through the existing supervised probe path. Normalize legacy tier strings and new `{model, effort}` objects into one configuration type; resolve explicit effort independently while treating a tier as a model-effort bundle. Persist global settings through the existing YAML-preserving settings service and render the shared tier union in the Agents screen.

**Tech Stack:** TypeScript, Node test runner, Zod, React, YAML, Vite.

---

## File structure

- Create `src/parts/backends/codex/models.ts`: Codex catalog probe and pure JSON parser.
- Create `test/fixtures/models/codex-debug-models.json`: recorded, reduced real CLI output.
- Modify `src/parts/backends/codex/index.ts`: register Codex model discovery.
- Modify `src/parts/pipeline/backend/types.ts`: discovery metadata, effort invocation, optional effort capability.
- Modify `src/parts/pipeline/config/modelTiers.ts`: custom tier names and normalized tier selections.
- Modify `src/parts/pipeline/config/schema.ts`, `defaults.ts`, `resolve.ts`: raw effort/tier schemas and normalized configuration.
- Modify `src/parts/pipeline/document/schema.ts`, `model.ts`, `expand.ts`: effort fields, inheritance, selection, origins, and lock data.
- Modify `src/parts/backends/codex/adapter.ts` and `src/parts/backends/claude/adapter.ts`: translate effective effort to CLI argv.
- Modify `src/parts/pipeline/run/exec/agentStep.ts` and `src/parts/pipeline/run/runner.ts`: pass effort and reject unsupported backends.
- Modify `src/parts/ui/settings.ts`, `ui/src/api.ts`, `ui/src/pages/Agents.tsx`, and `ui/src/pages/agents.css`: settings contract and shared-tier UI.
- Modify focused tests in `test/codex-adapter.test.ts`, `test/backend.test.ts`, `test/model-tiers.test.ts`, `test/ui-server.test.ts`, and `ui/test/agents.test.tsx`.
- Modify `docs/config.md`, `docs/pipeline-format.md`, and `docs/plugins.md`.

### Task 1: Codex CLI model catalog

**Files:**
- Create: `src/parts/backends/codex/models.ts`
- Create: `test/fixtures/models/codex-debug-models.json`
- Modify: `src/parts/backends/codex/index.ts`
- Modify: `src/parts/pipeline/backend/types.ts`
- Test: `test/codex-adapter.test.ts`

- [ ] **Step 1: Write failing catalog parser and plugin-wiring tests**

Add tests that expect this public shape:

```ts
const models = codexModelDiscovery.parse({ stdout: fixture, stderr: '', exitCode: 0 });
assert.deepEqual(models[0], {
  name: 'gpt-6-astra',
  label: 'GPT-6-Astra',
  title: 'Frontier intelligence for the most demanding work.',
  defaultEffort: 'low',
  efforts: [{ name: 'low', description: 'Fast responses with lighter reasoning' }],
});
assert.deepEqual(codexModelDiscovery.probe(CONFIG).command, ['codex', 'debug', 'models']);
assert.equal(codexPlugin.backends?.codex?.models, codexModelDiscovery);
```

Cover hidden-entry filtering, priority ordering, duplicate slug removal, optional malformed metadata, and invalid JSON returning `[]`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build:node && node --test dist/test/codex-adapter.test.js`

Expected: FAIL because `codexModelDiscovery` and the richer model fields do not exist.

- [ ] **Step 3: Implement the backend-neutral metadata and Codex parser**

Add:

```ts
export interface BackendEffort {
  readonly name: string;
  readonly description?: string;
}

export interface BackendModel {
  readonly name: string;
  readonly label?: string;
  readonly title?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly BackendEffort[];
}
```

Implement `codexModelDiscovery` with argv `[config.command, 'debug', 'models']`, a pure defensive parser, `visibility === 'list'`, numeric-priority sorting, and stable de-duplication. Register it in the bundled Codex plugin.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build:node && node --test dist/test/codex-adapter.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parts/backends/codex src/parts/pipeline/backend/types.ts test/codex-adapter.test.ts test/fixtures/models/codex-debug-models.json
git commit -m "feat: discover Codex models through CLI"
```

### Task 2: Custom tier configuration and normalization

**Files:**
- Modify: `src/parts/pipeline/config/modelTiers.ts`
- Modify: `src/parts/pipeline/config/schema.ts`
- Modify: `src/parts/pipeline/config/resolve.ts`
- Test: `test/model-tiers.test.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write failing configuration tests**

Add cases for legacy and object forms:

```ts
model_tiers:
  balance: gpt-6-sol
  review:
    model: gpt-6-astra
    effort: high
```

Assert both resolve to:

```ts
{
  balance: { model: 'gpt-6-sol' },
  review: { model: 'gpt-6-astra', effort: 'high' },
}
```

Add failures for `Review`, `9fast`, whitespace-only effort, and an object without `model`. Assert `defaults.effort` resolves independently.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run build:node && node --test dist/test/model-tiers.test.js dist/test/config.test.js`

Expected: FAIL because tiers are a fixed enum of strings and defaults have no effort.

- [ ] **Step 3: Implement normalized tier types and schemas**

Replace the closed tier type with:

```ts
export const BUILTIN_MODEL_TIERS = ['max', 'deep', 'balance', 'fast', 'mini'] as const;
export type ModelTier = string;
export interface ModelTierSelection { readonly model: string; readonly effort?: string }
export type ModelTiers = Readonly<Record<string, ModelTierSelection>>;
```

Use a lowercase slug schema for tier keys, a union of `ModelNameSchema` and a strict `{model, effort?}` object for raw values, and normalize strings in `buildBackends`. Add optional `defaults.effort` to raw and resolved configuration.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run build:node && node --test dist/test/model-tiers.test.js dist/test/config.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parts/pipeline/config test/model-tiers.test.ts test/config.test.ts
git commit -m "feat: support custom model tier selections"
```

### Task 3: Effort inheritance and tier-bundle selection

**Files:**
- Modify: `src/parts/pipeline/document/schema.ts`
- Modify: `src/parts/pipeline/document/model.ts`
- Modify: `src/parts/pipeline/document/expand.ts`
- Modify: `src/parts/pipeline/document/lock.ts` if explicit serialization needs adjustment
- Test: `test/model-tiers.test.ts`

- [ ] **Step 1: Write failing resolution tests**

Cover these assertions:

```ts
assert.deepEqual(selection('model_tier: deep'), { model: 'gpt-6-astra', effort: 'max' });
assert.deepEqual(selection('model_tier: deep\nmodel: gpt-6-luna'), { model: 'gpt-6-luna', effort: undefined });
assert.deepEqual(selection('model_tier: deep\nmodel: gpt-6-luna\neffort: high'), { model: 'gpt-6-luna', effort: 'high' });
```

Also cover step/job/pipeline/settings inheritance, reusable-job overrides, custom tier parameters, unmapped-tier fallback, origin maps, and lock differences when effort differs.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build:node && node --test dist/test/model-tiers.test.js`

Expected: FAIL because document schemas and expanded agent steps do not carry effort.

- [ ] **Step 3: Implement selection**

Add `effort?: string` to every selection shape, `AgentStep`, and the default-resolution structure. Resolve:

```ts
const tierSelection = tier === undefined ? undefined : backend?.modelTiers?.[tier];
const explicitModel = raw.model ?? defaults.model;
const model = explicitModel ?? tierSelection?.model ?? backend?.defaultModel;
const effort = raw.effort ?? defaults.effort ??
  (explicitModel === undefined ? tierSelection?.effort : undefined);
```

Add an effort-origin map parallel to model origins and serialize the effective `effort` as part of the agent step.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build:node && node --test dist/test/model-tiers.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parts/pipeline/document test/model-tiers.test.ts
git commit -m "feat: inherit model reasoning effort"
```

### Task 4: Backend effort execution and capability gate

**Files:**
- Modify: `src/parts/pipeline/backend/types.ts`
- Modify: `src/parts/backends/codex/adapter.ts`
- Modify: `src/parts/backends/claude/adapter.ts`
- Modify: `src/parts/pipeline/backend/fake.ts`
- Modify: `src/parts/pipeline/run/exec/agentStep.ts`
- Modify: `src/parts/pipeline/run/runner.ts`
- Test: `test/codex-adapter.test.ts`
- Test: `test/backend.test.ts`

- [ ] **Step 1: Write failing adapter and preflight tests**

Assert Codex launch contains:

```ts
['-c', 'model_reasoning_effort="high"']
```

for new and resumed invocations, Claude contains `['--effort', 'high']`, and neither adds an argument when effort is absent. Add a fake backend with `capabilities.effort: false` and assert preflight names the backend and step.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm run build:node && node --test dist/test/codex-adapter.test.js dist/test/backend.test.js`

Expected: FAIL because invocation/capability types and CLI flags do not exist.

- [ ] **Step 3: Implement effort execution**

Add optional `effort?: boolean` to `BackendCapabilities` for source compatibility and `effort?: string` to `AgentInvocation`. Pass the expanded step effort from `agentStep.ts`. Claude and Codex declare support and translate the value. Add a `requireEffortSupport` preflight pass using `capabilities.effort === true`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm run build:node && node --test dist/test/codex-adapter.test.js dist/test/backend.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parts/pipeline/backend src/parts/pipeline/run src/parts/backends test/backend.test.ts test/codex-adapter.test.ts
git commit -m "feat: execute configured model effort"
```

### Task 5: Settings API for effort and shared tiers

**Files:**
- Modify: `src/parts/ui/settings.ts`
- Modify: `ui/src/api.ts`
- Test: `test/ui-server.test.ts`

- [ ] **Step 1: Write failing settings endpoint tests**

Assert `GET /api/settings` returns `effort`, normalized model/effort tier objects, and `modelTiers: ['max', 'deep', 'balance', 'fast', 'mini', 'review']`. Assert `PUT` writes shorthand without effort, object form with effort, nullable global effort, and atomic `removeModelTiers: ['review']`; built-in removal returns 400.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm run build:node && node --test --test-name-pattern="settings" dist/test/ui-server.test.js`

Expected: FAIL because the endpoint only reads string-valued fixed tiers.

- [ ] **Step 3: Implement the settings view and YAML-preserving patches**

Use:

```ts
interface TierPatch { readonly model: string | null; readonly effort?: string | null }
```

Return the shared ordered tier union. When writing, emit a scalar for `{model}` and a mapping for `{model, effort}`. Apply global custom-tier removal to every backend before schema validation and the existing atomic rename.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm run build:node && node --test --test-name-pattern="settings" dist/test/ui-server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parts/ui/settings.ts ui/src/api.ts test/ui-server.test.ts
git commit -m "feat: configure effort and shared tiers"
```

### Task 6: Agents screen

**Files:**
- Modify: `ui/src/pages/Agents.tsx`
- Modify: `ui/src/pages/agents.css`
- Modify: `ui/src/api.ts`
- Test: `ui/test/agents.test.tsx`

- [ ] **Step 1: Write failing UI helper and interaction tests**

Add pure-helper tests for model labels, descriptions, model-dependent effort options, built-in-first tier ordering, custom effort retention, and patch generation. Add rendered interaction coverage for Add tier, global Remove, incomplete draft validation, Save, and Discard.

- [ ] **Step 2: Build UI tests and verify RED**

Run: `npm run build:ui-test && node --test dist/ui-test/agents.test.js`

Expected: FAIL because the page renders a fixed list of model-only tier fields.

- [ ] **Step 3: Implement shared tier editing**

Represent drafts as:

```ts
type TierDraft = { model: string; effort: string };
type AgentDraft = { defaultModel: string; modelTiers: Record<string, TierDraft> };
```

Add the global default-effort field, a validated Add tier control, per-tier model and effort comboboxes in every backend card, and one global Remove action per custom tier. Preserve configured custom values and show discovered defaults as placeholders.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `npm run build:ui-test && node --test dist/ui-test/agents.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Agents.tsx ui/src/pages/agents.css ui/src/api.ts ui/test/agents.test.tsx
git commit -m "feat: manage shared model tiers in UI"
```

### Task 7: Documentation and full verification

**Files:**
- Modify: `docs/config.md`
- Modify: `docs/pipeline-format.md`
- Modify: `docs/plugins.md`
- Modify: `test/fixtures/models/README.md`

- [ ] **Step 1: Update user and plugin documentation**

Document `defaults.effort`, effort inheritance, tier object syntax, custom tier slugs, exact precedence, the Codex probe, optional discovery metadata, and the optional backend effort capability. Replace the old fixture note claiming Codex cannot enumerate models with the recorded `codex debug models` contract.

- [ ] **Step 2: Run focused suites**

Run:

```bash
npm run build:node
node --test dist/test/codex-adapter.test.js dist/test/backend.test.js dist/test/model-tiers.test.js dist/test/config.test.js dist/test/ui-server.test.js
npm run build:ui-test
node --test dist/ui-test/agents.test.js
```

Expected: PASS.

- [ ] **Step 3: Run the repository check**

Run: `npm run check`

Expected: PASS with no typecheck, lint, build, Node-test, or UI-test failures.

- [ ] **Step 4: Review the final diff against the design**

Confirm every requirement in `docs/superpowers/specs/2026-09-24-codex-model-discovery-effort-custom-tiers-design.md` is implemented, no generated source exceeds 900 lines, and `git diff --check` is clean.

- [ ] **Step 5: Commit**

```bash
git add docs test/fixtures/models/README.md
git commit -m "docs: describe model effort and custom tiers"
```
