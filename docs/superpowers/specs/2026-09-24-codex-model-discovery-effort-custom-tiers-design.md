# Codex Model Discovery, Effort, and Custom Tiers — Design

Date: 2026-09-24.

## Goal

Make Stepcast obtain the current Codex model catalog from the installed and
signed-in Codex CLI, carry each model's reasoning-effort metadata to the Agents
screen, and let pipelines select an effort independently at the settings,
pipeline, job, or step level. Model tiers become shared, extensible names whose
per-backend value is a model plus an optional effort.

The change must preserve existing configurations that map the five built-in
tiers directly to model-name strings.

## Observed CLI contract

The installed `codex-cli 0.156.1` exposes:

```text
codex debug models
```

The command writes one JSON document to stdout. Its `models` array currently
contains, among other fields:

- `slug`, the value accepted by `codex -m`;
- `display_name` and `description`;
- `visibility`, with user-selectable models marked `list`;
- `priority`, which defines display order;
- `default_reasoning_level`;
- `supported_reasoning_levels`, whose elements contain `effort` and
  `description`.

The command refreshes the account-aware catalog unless `--bundled` is passed.
Stepcast will not pass `--bundled`: the explicit Reload models action is meant
to ask the CLI for the current catalog, not only the catalog shipped with its
binary.

Codex documents `model_reasoning_effort` as the CLI configuration key. The
backend will pass an effective effort as an invocation-local override:

```text
-c model_reasoning_effort="high"
```

Claude Code already exposes `--effort <level>`; the Claude backend will use
that flag for the same engine-level field.

## Model discovery

The Codex plugin declares a normal `ModelDiscovery` contribution. Its probe is
the argv-only launch specification `[command, "debug", "models"]`; execution,
environment filtering, timeout, error capture, daemon-lifetime cache, and
`refresh=1` bypass remain owned by the existing discovery engine.

`BackendModel` gains optional, backend-neutral metadata:

```ts
interface BackendEffort {
  readonly name: string;
  readonly description?: string;
}

interface BackendModel {
  readonly name: string;
  /** Optional human-readable label; `name` remains the persisted value. */
  readonly label?: string;
  /** Existing explanatory text shown beside the option. */
  readonly title?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly BackendEffort[];
}
```

The Codex parser:

1. parses stdout as one JSON object;
2. requires a `models` array;
3. keeps only entries with a non-empty `slug` and `visibility === "list"`;
4. sorts entries by numeric `priority`, then by slug for a stable tie-break;
5. maps well-formed optional metadata and ignores unknown fields;
6. de-duplicates repeated slugs, keeping the first sorted entry.

A successful JSON document with no selectable model produces an empty parsed
list and therefore the discovery engine's existing `unparsed` result. A
non-zero exit, including an older Codex version without `debug models`, remains
`failed` with bounded CLI output. The UI consequently explains the actual CLI
failure and still permits a custom model name.

Hidden and internal models are not offered. Stepcast does not read
`~/.codex/models_cache.json` and does not call the OpenAI API itself.

## Configuration model

### Effort

`effort` is an optional, trimmed, non-empty string. It is intentionally not a
closed enum: supported values are model- and backend-dependent, and the CLI
catalog can evolve independently of Stepcast. The UI offers catalog values and
marks an unlisted value as custom, following the existing model-field pattern.

The field is accepted wherever `agent`, `model`, and `model_tier` are accepted:

- global `defaults.effort`;
- pipeline `defaults.effort` and root `effort`;
- a job definition and an overriding `uses` site;
- an agent step.

It inherits independently through `step -> job -> pipeline -> settings`.

### Tier entries

The five built-in names remain `max`, `deep`, `balance`, `fast`, and `mini`.
Custom names use the portable slug pattern `^[a-z][a-z0-9_-]*$` and must not
duplicate a built-in name by case variation.

Each `backends.<name>.model_tiers` value accepts two forms:

```yaml
backends:
  codex:
    model_tiers:
      # Existing shorthand; no explicit effort.
      balance: gpt-6-sol

      # New form.
      deep:
        model: gpt-6-astra
        effort: max
```

The object form is strict, requires `model`, and permits optional `effort`.
An effort without a model is invalid because an effort entry belongs to the
tier's model selection. Resolution normalizes both forms to:

```ts
interface ModelTierSelection {
  readonly model: string;
  readonly effort?: string;
}

type ModelTiers = Readonly<Record<string, ModelTierSelection>>;
```

Reading an old string entry does not rewrite its YAML. The settings writer
uses the string shorthand while effort is empty and the object form while
effort is set, keeping uncomplicated files uncomplicated.

### Shared tier list

Tier names are global semantic roles. The effective list is the five built-in
names followed by the lexically sorted union of custom keys from every
backend's `model_tiers` map.

A tier may be mapped for one backend and absent for another. Selecting it with
the latter backend falls back to that backend's default model and therefore to
that model's own default effort. This preserves the existing fallback behavior
and allows a custom tier to be introduced incrementally across agents.

No second tier registry is stored. It would duplicate the keys already present
in backend maps and create an invalid state in which a registered tier had no
selection anywhere. In the UI, a newly added custom tier remains draft-only
until at least one backend receives a model mapping.

## Selection semantics

Model selection keeps its current precedence:

1. inherited explicit `model`;
2. the selected backend's entry for inherited `model_tier`;
3. the selected backend's `default_model`.

Effort is selected as follows:

1. inherited explicit `effort`;
2. the tier entry's effort, but only when the effective model came from that
   same tier entry;
3. no Stepcast value, allowing the selected model and CLI to apply their
   default.

An explicit model therefore overrides the tier as one model-effort bundle. It
does not retain the tier's effort. If there is no explicit inherited effort,
the explicit model uses its own default.

Examples:

```yaml
# deep resolves to gpt-6-astra/max.
model_tier: deep

# gpt-6-luna uses its model default; deep/max is completely overridden.
model_tier: deep
model: gpt-6-luna

# Explicit effort is independent and wins.
model_tier: deep
model: gpt-6-luna
effort: high
```

Catalog metadata is advisory. Expansion does not require a discovered model
or reject an effort absent from a cached catalog: custom models, offline
operation, and newer CLI versions must continue to work. A CLI remains the
authority at execution time.

## Expanded document and backend contract

`AgentStep` and `AgentInvocation` gain `effort?: string`. The effective value
is serialized into `pipeline.lock.yml`, so an already-created run remains
stable after settings or tier edits. The pipeline view records an effort
origin alongside the existing model origin: `step`, `job`, `pipeline`,
`settings`, or `tier`. Model-default is represented by an absent effective
value plus the discovered display metadata; it is not frozen as an explicit
override.

`BackendCapabilities` gains `effort`. Claude and Codex declare it
true. A backend without that capability may execute a step whose effort is
absent, but preflight rejects a step with an effective explicit or tier effort.
This prevents third-party adapters from silently ignoring a requested quality
setting.

At launch:

- Codex adds `-c model_reasoning_effort=<TOML string>` for both new and resumed
  executions;
- Claude adds `--effort <value>`;
- neither backend adds an effort argument when the effective value is absent.

The effort belongs to an invocation, not to `BackendConfig`, because pipeline,
job, and step overrides can vary it between calls using the same backend.

## Agents API and UI

`GET /api/models` extends each model object with the optional discovery
metadata. Existing consumers that only read `name` and `title` remain valid.

`GET /api/settings` additionally returns:

- global default effort and its source;
- normalized tier objects for each backend;
- the shared ordered tier-name list.

`PUT /api/settings` accepts:

- a nullable global `effort` patch;
- tier values containing nullable `model` and `effort`;
- a list of custom tier names to remove globally.

Removal is one atomic settings write: the writer deletes the named key from
every backend map. Built-in names are rejected by the removal operation.

The Agents page changes as follows:

- the Default agent card gains a default-effort combobox; an empty value means
  the selected model's default;
- each backend card renders every shared tier as one row containing a model
  combobox and an effort combobox;
- the effort combobox uses the selected listed model's supported efforts and
  shows its default in the placeholder;
- a custom or currently unsupported configured effort is retained and marked
  `custom`; changing a model never silently clears the effort;
- each listed model uses `label` for the CLI display name and `title` for its
  description, and shows its default effort;
- an `Add tier` action validates the custom slug and adds a draft row to all
  cards;
- a custom tier has one `Remove` action that marks it for deletion from all
  backends; built-in tiers have no removal action;
- Save is disabled for a new tier until at least one backend has a non-empty
  model, with an inline explanation;
- Discard restores settings, including removed and newly drafted tiers.

The page continues to permit custom model and effort strings. When model
discovery fails, all configured values stay editable.

## Errors and caching

The existing discovery result taxonomy remains unchanged. Codex can therefore
report `not_installed`, `timeout`, `failed`, `unparsed`, or `probe_error` by the
same API and UI path as Claude. A warning written to stderr with exit code zero
does not turn a valid stdout catalog into a failure.

The daemon keeps one discovery promise per backend command. Reload models
bypasses and replaces it. Changing `backends.codex.command` naturally changes
the cache key. Effort and tier edits do not invalidate the catalog because
they do not change the CLI being queried.

Settings validation rejects:

- malformed custom tier names;
- an object tier without `model`;
- empty model or effort strings after trimming;
- removal of a built-in tier;
- an unknown backend in a patch.

Execution rejects an effective effort only when the chosen backend explicitly
lacks effort support. It does not duplicate the CLI's model-specific validity
rules.

## Testing

Implementation follows test-first development.

Backend discovery tests cover:

- the real recorded shape of `codex debug models` through a committed fixture;
- filtering hidden entries, priority ordering, optional metadata, malformed
  entries, duplicate slugs, and invalid JSON;
- the Codex plugin declaring the probe and `/api/models` returning its result;
- cache reuse and explicit refresh, already covered generically and exercised
  once through Codex wiring.

Configuration and expansion tests cover:

- legacy string tier entries and the new object form;
- custom tier slugs and the global union;
- independent effort inheritance at every scope;
- explicit model severing the tier effort;
- explicit effort winning over tier effort;
- an unmapped custom tier falling back to backend/model defaults;
- lock serialization and origin reporting;
- rejection when a backend without the capability receives an effort.

Adapter tests assert the exact Codex `-c model_reasoning_effort=...` and Claude
`--effort ...` argv, including resumed Codex execution and omission when the
value is absent.

Settings/API tests cover backward-compatible reads, object writes, atomic
global deletion, built-in deletion rejection, and source reporting.

UI tests cover catalog metadata, model-dependent effort options, retention of
custom effort, adding/removing a shared tier, incomplete-new-tier validation,
Save/Discard, and graceful discovery failure.

The final verification is `npm run check` in the Stepcast repository plus the
focused UI and Node test commands used during red-green cycles.

## Documentation

Update:

- `docs/config.md` for `defaults.effort`, tier object syntax, custom tier names,
  and resolution precedence;
- `docs/pipeline-format.md` for effort inheritance and examples;
- `docs/plugins.md` for optional model effort metadata and the backend
  capability;
- the Agents-page documentation or README section describing model reload and
  shared tier management.

## Non-goals

- Direct OpenAI API model discovery.
- Reading Codex's private cache files.
- Configuring Responses API `reasoning.mode` (`standard`/`pro`), verbosity, or
  service tier.
- Enforcing catalog membership for custom models or effort values.
- Automatically rewriting existing string tier entries.
- Creating per-project tier registries in the browser; the Agents page edits
  the global Stepcast settings as it does today.
