# Project-Root Environment Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make machine-local pipeline `env_files` available to worktree jobs and their `until.check` commands.

**Architecture:** Keep `buildStepEnv` unchanged and pass the run's immutable `projectRoot` as its env-file lookup base from both runner call sites. Verify the behavior through a real worktree whose ignored env file exists only in the source project.

**Tech Stack:** TypeScript, Node test runner, Git worktrees, Stepcast local release script.

---

### Task 1: Reproduce worktree environment lookup

**Files:**
- Modify: `test/until-env.test.ts`

- [ ] **Step 1: Write the failing integration test**

Add `gitInit` and `gitCommit` to the helper imports, then create a project with
`workspace: { mode: worktree }`, `env_files: [.machine.env]`, a normal command
step, and an `until.check` command that both require `FROM_MACHINE=root`. Track
`.gitignore` before committing, then create the ignored `.machine.env` only in
the source project.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
npm run build:node && node --test --test-name-pattern='env_files из корня проекта' dist/test/until-env.test.js
```

Expected: the job fails because the current runner resolves `.machine.env`
inside the isolated worktree.

### Task 2: Use projectRoot for environment files

**Files:**
- Modify: `src/core/run/runner.ts:1360-1375`
- Modify: `src/core/run/runner.ts:3160-3185`

- [ ] **Step 1: Change both environment builders**

In `jobEnv` and `stepEnv`, change only the `buildStepEnv` lookup base:

```ts
cwd: context.projectRoot,
```

- [ ] **Step 2: Run the focused test**

Run the Task 1 command again. Expected: PASS.

- [ ] **Step 3: Run the Stepcast checks**

Run:

```bash
npm run check
```

Expected: all type checks, lint checks, backend tests, and UI tests pass.

### Task 3: Publish and resume

**Files:**
- No tracked file changes.

- [ ] **Step 1: Publish an isolated local release**

Build from a clean implementation worktree so unrelated changes in the main
checkout are not included:

```bash
./scripts/release-local.sh
```

Expected: `~/.stepcast/releases/current` points to the new release.

- [ ] **Step 2: Restart the Stepcast UI**

```bash
stepcast down && stepcast up
```

Expected: `http://127.0.0.1:7717` responds successfully.

- [ ] **Step 3: Resume the failed lane**

```bash
stepcast resume 4ea967 --from implement-a
```

Expected: the Gradle check sees `ANDROID_HOME`; `implement-a` proceeds beyond
the previous “SDK location not found” failure and the run continues through
review, verification, and merge according to their outcomes.
