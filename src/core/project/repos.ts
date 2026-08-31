import { StepcastError } from '../errors.js';
import type { Config } from '../config/resolve.js';

/**
 * Разрешение репозитория, названного пунктом очереди, в объявление —
 * единственное место движка, где склеиваются пути практики спецификации от
 * корня рабочего дерева и решаются все отказы вокруг имени (design.md,
 * решения 2, 4, 5). Команда `stepcast project repos`
 * (`src/cli/commands/project.ts`) — единственный потребитель.
 */

export interface ResolvedRepo {
  /** Рабочий каталог исполнения команды проверки и инструмента спецификации; корень — `.`. */
  readonly dir: string;
  readonly check: string;
  /**
   * Инструменты репозитория: корневой перечень плюс объявленные им самим, в
   * этом порядке и без повторов. Ключа нет вовсе, когда не объявлен ни один
   * перечень, — пустой список отсюда доехал бы до `allow` нулём записей, а
   * ключ, которого нет, отказывает по существу («проверьте состав выхода»).
   */
  readonly tools?: readonly string[];
  readonly spec: {
    /** Путь от корня рабочего дерева, например `backend/docs/changes`. */
    readonly dir: string;
    readonly rules: string;
    readonly tool: string;
  };
}

/** Всё, что нужно для разрешения, от пункта очереди — не весь `BacklogRecord`. */
export interface RepoOwner {
  readonly slug: string;
  readonly repos: readonly string[];
}

/**
 * У корня пути практики не имеют приставки: `openspec/changes`, а не
 * `./openspec/changes` — склейка не имеет права испортить сравнение с
 * путями `changed_only`, которые всегда без `./`.
 */
function joinFromRoot(dir: string, sub: string): string {
  return dir === '.' ? sub : `${dir}/${sub}`;
}

/**
 * Инструменты репозитория — объединение, а не замена, в отличие от `check` и
 * `spec`: те описывают репозиторий целиком и корневым значением подменяются
 * молча неверно, а инструменты складываются — корневые (`git`, `npm`) верны в
 * любом дереве, репозиторий добавляет к ним своё (`./gradlew`). Порядок
 * объявленный, корневые впереди; повтор схлопывается здесь, потому что две
 * одинаковые записи `allow` — шум в политике, о котором бэкенду сказать
 * нечего.
 */
function mergeTools(
  root: readonly string[] | undefined,
  own: readonly string[] | undefined,
): readonly string[] | undefined {
  if (root === undefined && own === undefined) return undefined;
  return [...new Set([...(root ?? []), ...(own ?? [])])];
}

interface SpecFields {
  readonly dir: string | undefined;
  readonly rules: string | undefined;
  readonly tool: string | undefined;
}

/**
 * Четыре величины объявления обязаны быть все — вместе они и есть проверка
 * репозитория плюс инструмент спецификации, которыми петля затем правит и
 * гейтит документы. Первая недостающая по порядку check → spec.dir → rules →
 * tool называется отказом; называть все сразу здесь смысла нет — репозиторий
 * либо объявлен полностью, либо его правят до следующего захода.
 *
 * Пункт очереди назван и здесь, наравне с двумя другими отказами вокруг
 * имени: при двух заполненных дорожках, взявших разные репозитории, отказ без
 * слага не говорит, чей пункт остановил заход.
 */
function requireComplete(
  itemSlug: string,
  label: string,
  check: string | undefined,
  spec: SpecFields,
): { readonly check: string; readonly spec: { readonly dir: string; readonly rules: string; readonly tool: string } } {
  const missing =
    check === undefined
      ? 'check'
      : spec.dir === undefined
        ? 'spec.dir'
        : spec.rules === undefined
          ? 'spec.rules'
          : spec.tool === undefined
            ? 'spec.tool'
            : undefined;

  if (missing !== undefined) {
    throw new StepcastError(
      `пункт «${itemSlug}»: репозиторий «${label}» не объявляет ${missing}`,
      { at: itemSlug, hint: 'Объявите его в .stepcast/config.yml' },
    );
  }

  return {
    check: check as string,
    spec: { dir: spec.dir as string, rules: spec.rules as string, tool: spec.tool as string },
  };
}

/**
 * Разрешить репозиторий, названный пунктом `item.repos`, в объявление. Пункт
 * без поля (перечень пуст) и пункт, назвавший `.`, дают одно и то же —
 * объявление корня, без приставки к путям.
 */
export function resolveItemRepo(config: Config, item: RepoOwner): ResolvedRepo {
  if (item.repos.length > 1) {
    throw new StepcastError(
      `пункт «${item.slug}» называет несколько репозиториев (${item.repos.join(', ')}): дорожка ведёт один репозиторий`,
      { at: item.slug },
    );
  }

  const name = item.repos[0] ?? '.';

  if (name === '.') {
    const { check, spec } = requireComplete(
      item.slug,
      'корень',
      config.project.check,
      config.project.spec,
    );
    const tools = mergeTools(config.project.tools, undefined);
    return { dir: '.', check, ...(tools === undefined ? {} : { tools }), spec };
  }

  const declaredDirs = config.project.nestedRepos ?? [];
  if (!declaredDirs.includes(name)) {
    throw new StepcastError(
      `пункт «${item.slug}» называет репозиторий «${name}», не объявленный составом: объявлены ${
        declaredDirs.length === 0 ? '(нет)' : declaredDirs.join(', ')
      }`,
      { at: item.slug },
    );
  }

  const declaration = config.project.nestedRepoDeclarations?.get(name);
  const { check, spec } = requireComplete(
    item.slug,
    name,
    declaration?.check,
    declaration?.spec ?? { dir: undefined, rules: undefined, tool: undefined },
  );

  const tools = mergeTools(config.project.tools, declaration?.tools);

  return {
    dir: name,
    check,
    ...(tools === undefined ? {} : { tools }),
    spec: {
      dir: joinFromRoot(name, spec.dir),
      rules: joinFromRoot(name, spec.rules),
      tool: spec.tool,
    },
  };
}
