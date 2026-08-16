export { ExitCode, ScarpError, isScarpError, type ExitCodeValue } from './errors.js';
export { parseTokens, parseDuration, formatTokens, formatDuration } from './units.js';
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
export { RawConfigSchema, type RawConfig } from './config/schema.js';
export { expandPipeline, type ExpandOptions } from './pipeline/expand.js';
export { serializeLock, writeLock, pipelineToPlain } from './pipeline/lock.js';
export { interpolate, interpolateTree, hasPlaceholder, type Scope } from './pipeline/interpolate.js';
export { resolveParams, type ParamValue } from './pipeline/params.js';
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
  Substitution,
  SubstitutionMap,
} from './pipeline/model.js';
