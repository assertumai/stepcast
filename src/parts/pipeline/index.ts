export { ExitCode, StepcastError, isStepcastError, type ExitCodeValue } from '../../kernel/errors.js';
export { parseTokens, parseDuration, formatTokens, formatDuration } from '../../kernel/units.js';
export {
  resolveConfig,
  expandHome,
  type Config,
  type BackendConfig,
  type ResolvedConfig,
  type ResolveOptions,
} from './config/resolve.js';
export {
  describeSource,
  matchesKeyPattern,
  type DenyContribution,
  type Source,
} from './config/merge.js';
export { BUILTIN_CONFIG } from './config/defaults.js';
export { findPackageRoot, packagedSchemaPath, type SchemaReference } from './domain/package-schema.js';
export { RawConfigSchema, type RawConfig } from './config/schema.js';
export { expandPipeline, type ExpandOptions } from './document/expand.js';
export { serializeLock, writeLock, pipelineToPlain } from './document/lock.js';
export { interpolate, interpolateTree, hasPlaceholder, type Scope } from './document/interpolate.js';
export { resolveParams, type ParamValue } from './document/params.js';
export type {
  Pipeline,
  Job,
  Step,
  AgentStep,
  RunStep,
  Predicate,
  ContextEntry,
  Budget,
  Workspace,
  ExpandedPipeline,
  ModelOrigin,
  Substitution,
  SubstitutionMap,
} from './document/model.js';
export { lintPipeline, hasErrors, compileNameGlob, type Diagnostic, type Severity } from './domain/lint.js';
export { buildGraph, type Graph, type GraphProblem } from './domain/graph.js';
export { parseExpression, evaluate, references, type Expr } from './domain/expr/parse.js';
export { RunJournal, atomicWrite } from './run/journal/writer.js';
export {
  listRuns,
  listRunsByKey,
  listProjects,
  type ProjectEntry,
  resolveRun,
  readStatus,
  readUsage,
  readEvents,
  findStepDir,
  follow,
} from './run/journal/reader.js';
export {
  findProjectRoot,
  projectKey,
  makeRunId,
  shortRunId,
  runPaths,
  stepDir,
  stepDirName,
  parseStepDirName,
  type RunPaths,
} from './run/journal/paths.js';
export {
  isFailure,
  type StatusValue,
  type RunManifest,
  type RunStatus,
  type JobRecord,
  type StepRecord,
  type AttemptRecord,
  type Usage,
  type UsageReport,
  type ContextReport,
  type ExpectReport,
  type Event,
} from './run/journal/schema.js';
export { buildStepEnv, injectedVariables, parseEnvFile, type BuiltEnv, type EnvLayers } from './run/exec/env.js';
export { runProcess, DEFAULT_GRACE_MS, type ProcessOptions, type ProcessResult } from './run/exec/process.js';
export { planAttempt, runAttempts, type AttemptPlan } from './run/exec/attempts.js';
export { executeRunStep, evaluateExitCode, type RunStepOptions, type RunStepResult } from './run/exec/runStep.js';
export { schedule, overallStatus, type JobOutcome, type SettledJob } from './run/scheduler.js';
export { runPipeline, type RunOptions, type RunResult } from './run/runner.js';
export { resolveAdapter } from './backend/registry.js';
export { createClaudeAdapter } from '../backends/claude/adapter.js';
export { createFakeBackend, resultLine, initLine, toolUseLine } from './backend/fake.js';
export { emptyUsage, mergeUsage, type BackendAdapter, type BackendEvent } from './backend/types.js';
export { executeAgentStep, createSessionRegistry, type AgentStepResult } from './run/exec/agentStep.js';
export { assembleContext, estimateTokens, type AssembleOptions } from './domain/context/assemble.js';
export { matchesGlob, matchesAnyGlob, globToRegExp } from './domain/context/glob.js';
export { evaluatePredicates, type EvaluationInput } from './expect/evaluate.js';
export {
  UsageAccumulator,
  ZERO_USAGE_SNAPSHOT,
  describeExceeded,
  type Exceeded,
  type UsageSnapshot,
} from './run/budget/accumulator.js';
export {
  parse,
  effectiveGroup,
  toRecord,
  isFree,
  selectItems,
  withFields,
  readBacklogFile,
  parseBacklogFile,
  writeBacklogFile,
  oneLine,
  tailLine,
  finishItem,
  REASON_LIMIT,
  DEFAULT_STALE_HOURS,
  BacklogSlugSchema,
  BacklogStatusSchema,
  BACKLOG_STATUSES,
  BacklogItemSchema,
  BacklogRecordSchema,
  BacklogSlotsResponseSchema,
  type BacklogEntry,
  type BacklogFieldPosition,
  type BacklogItem,
  type BacklogRecord,
  type BacklogSlotsResponse,
  type FinishOutcome,
} from './domain/backlog/index.js';
export { laneJobs, knownLanes, evaluateLane, type LaneJobStatus, type LaneOutcome } from './domain/lanes/lanes.js';
export { assertCleanTree, currentCommit, resetToCommit, commitAll } from './domain/lanes/tree.js';
export { runCheck, CHECK_TIMEOUT_MS, type CheckOptions } from './domain/lanes/check.js';
export { hasLaneItem, takenLanes, readLaneItem, type LaneItem } from './domain/lanes/item.js';
export { mergeLanes, type MergeLanesOptions, type LaneMergeResult } from './domain/lanes/merge.js';
