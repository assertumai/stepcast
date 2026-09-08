# Agent and model tiers implementation plan

**Goal:** Configure default agents, per-agent models and five model tiers, with pipeline/job/step overrides.

**Architecture:** Extend the existing backend configuration (`default_model`, `model_tiers`) and resolve each selection field independently before expanding agent steps. Explicit models win over tiers; missing mappings fall back to the selected backend default. Keep existing `defaults` syntax and support pipeline root overrides. Store only the effective model in executable steps and retain selection provenance separately. Add an Agents page backed by the existing global settings API.

**Tech stack:** TypeScript, Zod, YAML, React, node:test.

- [x] Add failing behavior tests for config defaults, tier maps, all override levels, reused jobs, model precedence, invalid tiers and lock equivalence.
- [x] Extend config schemas/defaults and pipeline expansion. Preserve plugin-based Codex registration and give its contribution the requested default model.
- [x] Test and extend settings API to edit per-backend model maps, preserving YAML comments and validating requests before writes. Expose bundled Codex setup on the Agents page.
- [x] Add Agents UI and route; display effective selection origin on pipeline cards and update existing settings scope accounting.
- [x] Document syntax and priority, regenerate published schemas, run full repository checks, and review the diff.

Decisions: tiers are `max`, `deep`, `balance`, `fast`, `mini`; no guessed per-tier mappings. Claude defaults to `sonnet`, Codex to `gpt-5.6-terra`. Existing global `defaults.model` is retained for compatibility and remains an explicit inherited model. An agent override does not clear inherited model/tier fields.
