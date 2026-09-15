# Resolve Pipeline Environment Files from the Project Root

## Problem

Relative `env_files` are currently resolved from the active job workspace.
For a job running in `worktree` mode, that directory is an isolated checkout.
Machine-local files such as `.stepcast/local.env` are intentionally untracked,
so they are absent from the checkout even though the pipeline declares them.

The `self-improve` pipeline therefore loses `ANDROID_HOME` during its Gradle
`until.check`. The agent step succeeds, but every check fails with “SDK location
not found” until the loop exhausts its iterations.

## Design

Relative entries in pipeline `env_files` will resolve from the run's
`projectRoot`. Absolute entries keep their existing meaning. The same base is
used when building the environment for a normal step and for a job-level
`until.check`.

Only file lookup changes. The environment layering order, `env_deny`, backend
variables, step variables, and injected `STEPCAST_*` variables remain as they
are.

## Alternatives Rejected

- Copying machine environment files into each worktree duplicates secrets and
  turns local configuration into workspace state.
- Persisting parsed environment values in the run manifest risks writing
  secrets to disk and expands the change beyond path resolution.

## Verification

An integration test will create a project root containing an untracked env
file and execute a worktree job whose `until.check` reads its variable. The
test must prove that the value comes from the project root even though the env
file is absent from the job workspace. Existing environment precedence and
filtering tests must remain green.

After the fix is released locally, run `4ea967` will be resumed from
`implement-a`; its existing lane workspace and Codex changes must be reused.
