# Agent usage and continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Stepcast stop agent work at an accurate token budget and continue long implementations in fresh, compact sessions instead of allowing one session to grow until it exhausts the subscription.

**Architecture:** Claude stream usage is a per-message delta, while the terminal `result` is the authoritative cumulative total. Normalize both forms in the adapter, accumulate deltas once per Claude message id in `agentStep`, and keep the existing `UsageAccumulator` interface cumulative. Then add an opt-in continuation policy: Stepcast checkpoints a running agent after a bounded number of unique model turns, starts a fresh session in the same workspace, and supplies a deterministic baton derived from the worktree and task checklist. Context trimming is a pipeline-level profile, not a global loss of context.

**Tech Stack:** TypeScript, Node.js `node:test`, Zod pipeline/config schemas, Claude Code `stream-json`, YAML pipeline files.

---

## Scope and delivery order

1. Correct streaming usage and prove that a running process is aborted before its natural completion.
2. Reduce the self-improve implementation context without withholding files from the agent.
3. Add opt-in session continuation. This depends on (1), because its per-session token guard must use trustworthy usage.

Do not alter the repository's existing unfinished `budget-wait-on-exceed` change while executing this plan. Keep this work in a separate OpenSpec change and worktree.

### Task 1: Represent usage semantics and combined assistant events

**Files:**
- Modify: `src/core/backend/types.ts`
- Modify: `src/core/backend/claude.ts`
- Modify: `src/core/backend/fake.ts`
- Test: `test/backend.test.ts`

- [ ] **Step 1: Add failing adapter tests for an assistant message that contains both thinking and a tool call.**

  Construct two JSON records with the same `message.id`; the first has a `thinking` block and the second a `tool_use` block. Both carry identical usage. Assert that parsing preserves the Read tool and exposes one delta usage record identified by that message id. Add a second test for `type: result` asserting `usageMode === 'cumulative'`.

  ```ts
  assert.equal(event.kind, 'assistant');
  assert.equal(event.messageId, 'msg-1');
  assert.equal(event.tool?.name, 'Read');
  assert.equal(event.usageMode, 'delta');
  ```

- [ ] **Step 2: Run the focused test and verify the current failure.**

  Run: `node --test dist/test/backend.test.js`

  Expected: the test cannot observe usage and tool data together, because the current adapter returns `tool_use` before looking at usage.

- [ ] **Step 3: Replace mutually-exclusive `tool_use` / `usage` stream events with one assistant event.**

  In `src/core/backend/types.ts`, replace the separate transient events with a single shape that can contain every fact emitted on one assistant message:

  ```ts
  | {
      readonly kind: 'assistant';
      readonly messageId?: string;
      readonly tool?: { readonly name: string; readonly input: unknown };
      readonly usage?: Partial<Usage>;
      readonly usageMode: 'delta';
    }
  ```

  Keep `result` separate and add `usageMode: 'cumulative'` when it has usage. In `claude.ts`, read `message.id`, `firstToolUse(message)`, and `readUsage(message.usage)` before returning the single event; never discard usage just because the content has a tool. Update the fake adapter and its line helpers to emit the same shape.

- [ ] **Step 4: Rebuild and run the focused adapter tests.**

  Run: `npm run build && node --test dist/test/backend.test.js`

  Expected: PASS.

- [ ] **Step 5: Commit the isolated adapter contract.**

  ```bash
  git add src/core/backend/types.ts src/core/backend/claude.ts src/core/backend/fake.ts test/backend.test.ts
  git commit -m "fix: preserve Claude streaming usage with tool events"
  ```

### Task 2: Accumulate stream deltas exactly once and enforce the budget during a process

**Files:**
- Modify: `src/core/exec/agentStep.ts`
- Modify: `src/core/backend/types.ts`
- Modify: `test/backend.test.ts`
- Modify: `test/budget.test.ts`

- [ ] **Step 1: Add a failing execution test for duplicated stream records.**

  Feed `executeAgentStep` two assistant events with `messageId: 'same-turn'`, each reporting 60 tokens, followed by a second unique event reporting 60 tokens. Capture `onUsage`. Assert the last reported attempt total is 120, not 60 or 180.

  ```ts
  assert.deepEqual(reported, [60, 120]);
  assert.equal(result.last?.usage.tokens_in, 120);
  ```

- [ ] **Step 2: Add a failing runner test for early termination.**

  Add a fake backend that emits a unique 60-token assistant event, remains alive for several seconds, and records whether its process was aborted. Give the step a 50-token budget. Assert `runPipeline()` returns `budget_exceeded` promptly and the fake's natural completion callback was not reached.

- [ ] **Step 3: Run both tests and verify the failure.**

  Run: `npm run build && node --test dist/test/backend.test.js dist/test/budget.test.js`

  Expected: duplicate messages are overwritten rather than added, and the long fake process reaches its natural completion.

- [ ] **Step 4: Implement an explicit usage reducer in `agentStep.ts`.**

  Maintain `const seenUsageMessageIds = new Set<string>()` and an attempt-total `Usage`. For an assistant event:

  ```ts
  if (event.tool !== undefined) observeTool(event.tool);
  if (event.usage !== undefined && (event.messageId === undefined || !seenUsageMessageIds.has(event.messageId))) {
    if (event.messageId !== undefined) seenUsageMessageIds.add(event.messageId);
    usage = sumUsage(usage, completeDelta(event.usage, adapter.name, resolvedModel));
    options.onUsage?.(usage);
  }
  ```

  `completeDelta` must preserve unknown fields as `null` rather than inventing zeroes. For a terminal result, reconcile to its cumulative total with a helper that replaces only reported counters; do not add the final total to already accumulated deltas. Continue recording the resulting cumulative attempt total through `UsageAccumulator.record()`.

- [ ] **Step 5: Run the focused tests and then the repository check.**

  Run: `npm run check`

  Expected: all checks pass; the early-termination test finishes substantially before the fake's natural timeout.

- [ ] **Step 6: Commit accurate accounting and interruption.**

  ```bash
  git add src/core/exec/agentStep.ts src/core/backend/types.ts test/backend.test.ts test/budget.test.ts
  git commit -m "fix: enforce budgets from Claude stream usage"
  ```

### Task 3: Make budget telemetry inspectable while a run is active

**Files:**
- Modify: `src/core/journal/schema.ts`
- Modify: `src/core/run/runner.ts`
- Modify: `src/cli/status.ts`
- Modify: `test/journal.test.ts`
- Modify: `test/budget.test.ts`
- Modify: `test/ui-overview.test.ts`

- [ ] **Step 1: Add failing tests for an in-progress usage snapshot.**

  While a fake backend is paused after reporting 40 tokens, read `status.json`. Assert it exposes the current billable total and per-job/step total before the attempt exits.

- [ ] **Step 2: Implement a `usage` snapshot in `RunStatusSchema`.**

  Add an optional status field that uses the same token dimensions as `usage.json` but is explicitly marked live. Write it whenever `onUsage` updates the accumulator; keep `usage.json` as the final immutable report.

  ```ts
  status.usage = { billable_tokens: usage.runTokens(), updated_at: new Date().toISOString() };
  ```

  Extend `stepcast status` and the overview only to display the snapshot when present; they must remain compatible with old run directories that lack it.

- [ ] **Step 3: Verify status, journal, and UI tests.**

  Run: `npm run build && node --test dist/test/journal.test.js dist/test/budget.test.js dist/test/ui-overview.test.js`

  Expected: PASS.

- [ ] **Step 4: Commit the observability slice.**

  ```bash
  git add src/core/journal/schema.ts src/core/run/runner.ts src/cli/status.ts test/journal.test.ts test/budget.test.ts test/ui-overview.test.ts
  git commit -m "feat: show live run usage"
  ```

### Task 4: Apply a narrow context profile to self-improve

**Files:**
- Modify: `.stepcast/pipelines/self-improve.yml`
- Modify: `.stepcast/jobs/implement.yml`
- Modify: `.stepcast/prompts/implement.md`
- Test: `test/iteration-context.test.ts`

- [ ] **Step 1: Add a lint/expansion test that inspects the resolved implement job.**

  Expand the pipeline with a sample change and assert that `implement.contextUpstream` is exactly `['plan']`, while all task/spec files remain available by path rather than being removed.

- [ ] **Step 2: Set the self-improve profile.**

  In `implement.yml`, set:

  ```yaml
  context_upstream: [plan]
  context_max_tokens: 8k
  ```

  Change the spec glob entries to explicit `mode: reference`. In `self-improve.yml`, change the broad `docs/status.md` pipeline context to `mode: reference`; retain the short inline policy text. Update `implement.md` to require the agent to read `tasks.md` first and only the spec files relevant to its current unchecked task.

- [ ] **Step 3: Verify the context report and pipeline lint.**

  Run: `npm run build && node dist/src/bin.js lint .stepcast/pipelines/self-improve.yml`

  Run one dry expansion/test fixture and assert the resulting `context.json` shows `plan.json` inline, not `propose.json`, and spec files as references.

- [ ] **Step 4: Commit the pipeline-only optimization.**

  ```bash
  git add .stepcast/pipelines/self-improve.yml .stepcast/jobs/implement.yml .stepcast/prompts/implement.md test/iteration-context.test.ts
  git commit -m "perf: trim self-improve implementation context"
  ```

### Task 5: Add an opt-in fresh-session continuation policy

**Files:**
- Modify: `src/core/pipeline/schema.ts`
- Modify: `src/core/pipeline/model.ts`
- Modify: `src/core/pipeline/expand.ts`
- Modify: `src/core/exec/agentStep.ts`
- Modify: `src/core/run/runner.ts`
- Modify: `src/core/journal/schema.ts`
- Modify: `src/core/run/stepKey.ts`
- Modify: `test/backend.test.ts`
- Modify: `test/budget.test.ts`
- Modify: `test/journal.test.ts`

- [ ] **Step 1: Add failing schema and runner tests for continuation.**

  Define this step-level syntax:

  ```yaml
  continuation:
    max_turns: 60
  ```

  Test that an invalid `max_turns: 0` is rejected; then use a fake backend that emits 61 distinct assistant message ids. Assert there are two backend invocations, their session ids differ, the second does not use `--resume`, and the job succeeds without consuming an additional `attempts.max` attempt.

- [ ] **Step 2: Add the typed pipeline model.**

  Add `Continuation { maxTurns: number }` to `AgentStep` and make it optional. Include it in the resolved lockfile and step key so changing the policy invalidates reuse. Do not enable it by default.

- [ ] **Step 3: Persist a deterministic baton before restarting.**

  On the threshold, stop the current agent through the step-local `AbortController`, then write `checkpoint.json` beside the step log with:

  ```json
  {
    "continuation": 1,
    "changed_paths": ["src/core/run/runner.ts"],
    "task_file": "openspec/changes/<slug>/tasks.md",
    "usage": { "billable_tokens": 123456 }
  }
  ```

  Obtain `changed_paths` from the existing tree-diff helper and task completion from the file itself; do not ask the interrupted model to summarize. Add `step.checkpointed` to the journal schema with continuation number and usage.

- [ ] **Step 4: Restart with a new session and compact prompt.**

  Extend `SessionRegistry` with `rotate(alias)`. On a checkpoint, rotate the session, clear `contextSent` for that alias, and run the same step again without incrementing `attempts`. The continuation prompt must inline only `checkpoint.json`, the plan output, and the short original prompt; task/spec files are referenced by path. It must explicitly instruct the new agent to inspect the worktree and continue unchecked tasks rather than reverting prior changes.

- [ ] **Step 5: Verify behaviour under a budget and cancellation.**

  Add tests for: the global budget remains cumulative over both sessions; cancellation during the second session remains `canceled`; `usage.json` aggregates both sessions; and a checkpointed step leaves no false `failed` attempt record. Run:

  ```bash
  npm run build && node --test dist/test/backend.test.js dist/test/budget.test.js dist/test/journal.test.js
  ```

- [ ] **Step 6: Commit continuation support.**

  ```bash
  git add src/core/pipeline/schema.ts src/core/pipeline/model.ts src/core/pipeline/expand.ts src/core/exec/agentStep.ts src/core/run/runner.ts src/core/journal/schema.ts src/core/run/stepKey.ts test/backend.test.ts test/budget.test.ts test/journal.test.ts
  git commit -m "feat: continue long agent steps in fresh sessions"
  ```

### Task 6: Enable, document, and measure the self-improve policy

**Files:**
- Modify: `.stepcast/jobs/implement.yml`
- Modify: `docs/pipeline-format.md`
- Modify: `docs/run-layout.md`
- Modify: `docs/status.md`
- Test: `test/lint.test.ts`

- [ ] **Step 1: Enable continuation only for `implement`.**

  Add:

  ```yaml
  continuation:
    max_turns: 60
  ```

  Do not enable it for review or fix-review until a measured run demonstrates that their sessions reach a comparable length.

- [ ] **Step 2: Document the guarantees and limits.**

  Document that continuation preserves the workspace and run-level budget, starts a new backend session, does not consume `attempts`, and may repeat repository reading. In run-layout, document `checkpoint.json` and `step.checkpointed`. In status, mark live usage and continuation as implemented.

- [ ] **Step 3: Run the full suite and a controlled smoke run.**

  Run: `npm run check`

  Then run a fake-backed fixture with 61 turns. Verify from its journal that two sessions were created, one checkpoint was written, and total usage equals the sum of both sessions.

- [ ] **Step 4: Commit enablement and documentation.**

  ```bash
  git add .stepcast/jobs/implement.yml docs/pipeline-format.md docs/run-layout.md docs/status.md test/lint.test.ts
  git commit -m "feat: bound self-improve agent sessions"
  ```

## Acceptance criteria

- An assistant message containing usage and `tool_use` no longer loses either fact.
- Duplicate Claude stream records with the same `message.id` are charged once; terminal totals reconcile rather than double-count.
- A process that exceeds a token budget is interrupted during the process, not only after Claude emits its terminal result.
- The next self-improve implement prompt excludes `propose.json`, keeps specs accessible by reference, and has a measured smaller inline context.
- With `continuation.max_turns`, a long implementation continues in a fresh session in the same workspace, preserves the global budget, and leaves an inspectable checkpoint.
- `npm run check` passes after every committed slice.
