import type {
  BackendEffort,
  BackendConfig,
  BackendModel,
  LaunchSpec,
  ModelDiscovery,
  ProbeOutput,
} from '../../pipeline/surface.js';

interface CatalogModel {
  readonly slug: string;
  readonly label?: string;
  readonly title?: string;
  readonly defaultEffort?: string;
  readonly efforts?: readonly BackendEffort[];
  readonly priority: number;
}

/** Account-aware model catalog exposed by current Codex CLI versions. */
export const codexModelDiscovery: ModelDiscovery = {
  probe(config: BackendConfig): LaunchSpec {
    return { command: [config.command, 'debug', 'models'], stdin: '' };
  },
  parse(output: ProbeOutput): readonly BackendModel[] {
    return parseCodexModelCatalog(output.stdout);
  },
};

/** Parse only the stable, user-facing subset of the CLI's extensible JSON. */
export function parseCodexModelCatalog(stdout: string): readonly BackendModel[] {
  let source: unknown;
  try {
    source = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(source) || !Array.isArray(source.models)) return [];

  const parsed = source.models.flatMap((value): CatalogModel[] => {
    if (!isRecord(value) || value.visibility !== 'list') return [];
    const slug = text(value.slug);
    if (slug === undefined) return [];
    const label = text(value.display_name);
    const title = text(value.description);
    const defaultEffort = text(value.default_reasoning_level);
    const efforts = parseEfforts(value.supported_reasoning_levels);
    return [{
      slug,
      ...(label === undefined ? {} : { label }),
      ...(title === undefined ? {} : { title }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(efforts.length === 0 ? {} : { efforts }),
      priority: typeof value.priority === 'number' && Number.isFinite(value.priority)
        ? value.priority
        : Number.POSITIVE_INFINITY,
    }];
  });
  parsed.sort((left, right) => left.priority - right.priority || left.slug.localeCompare(right.slug));

  const seen = new Set<string>();
  return parsed.flatMap(({ slug, label, title, defaultEffort, efforts }): BackendModel[] => {
    if (seen.has(slug)) return [];
    seen.add(slug);
    return [{
      name: slug,
      ...(label === undefined ? {} : { label }),
      ...(title === undefined ? {} : { title }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(efforts === undefined ? {} : { efforts }),
    }];
  });
}

function parseEfforts(value: unknown): readonly BackendEffort[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((raw): BackendEffort[] => {
    if (!isRecord(raw)) return [];
    const name = text(raw.effort);
    if (name === undefined || seen.has(name)) return [];
    seen.add(name);
    const description = text(raw.description);
    return [{ name, ...(description === undefined ? {} : { description }) }];
  });
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
