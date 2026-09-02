import { isAbsolute } from 'node:path';

import { z } from 'zod';

/**
 * Схема конфигурации в «сыром» виде: величины ещё строки, всё необязательно,
 * потому что каждый источник задаёт только свою часть. Приведение к числам
 * выполняется один раз после слияния слоёв — см. finalize.ts.
 *
 * Схемы строгие: неизвестный ключ в конфигурации почти всегда опечатка, и
 * молча проглатывать её дороже, чем отклонить.
 */

const amount = z.union([z.string(), z.number()]);

export const RawRunsSchema = z
  .object({
    root: z.string().optional(),
    keep: amount.optional(),
  })
  .strict();

export const RawWorkspaceSchema = z
  .object({
    mode: z.enum(['cwd', 'worktree', 'copy']).optional(),
    path: z.string().optional(),
  })
  .strict();

export const RawDefaultsSchema = z
  .object({
    agent: z.string().optional(),
    model: z.string().optional(),
    workspace: RawWorkspaceSchema.optional(),
    session: z.enum(['shared', 'per_step']).optional(),
    concurrency: z.number().int().positive().optional(),
    fail_fast: z.boolean().optional(),
    step_timeout: amount.optional(),
    stall_timeout: amount.optional(),
    max_wait: amount.optional(),
  })
  .strict();

export const RawLimitsSchema = z
  .object({
    tokens: amount.optional(),
    cost: amount.optional(),
    wallclock: amount.optional(),
    concurrency: z.number().int().positive().optional(),
    attempts: z.number().int().positive().optional(),
    iterations: z.number().int().positive().optional(),
  })
  .strict();

export const RawContextSchema = z
  .object({
    inline_threshold: amount.optional(),
    max_tokens: amount.optional(),
    note_max_tokens: amount.optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

export const RawPermissionsSchema = z
  .object({
    mode: z.string().optional(),
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    enforce: z.enum(['inherit', 'strict']).optional(),
  })
  .strict();

export const RawBackendSchema = z
  .object({
    command: z.string().optional(),
    enabled: z.boolean().optional(),
    default_model: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
    cache_read_weight: z.number().min(0).optional(),
    sessions: z.boolean().optional(),
    structured_output: z.boolean().optional(),
    // Возможность адаптера отсекать настройки вне репозитория и запрещать
    // неназванное — наравне с sessions/structured_output. Флаг «умею», а не
    // желание: выключенный превращает `enforce: strict` в ошибку конфигурации,
    // не в послабление.
    strict_permissions: z.boolean().optional(),
    permissions: RawPermissionsSchema.optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const RawUiSchema = z
  .object({
    port: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Команда проверки репозитория. Пустая строка отклоняется здесь же: пустая
 * команда даёт нулевой код возврата, то есть зелёный гейт на любом коде.
 *
 * Требование записано дважды нарочно. `.trim().min(1)` отвергает строку из
 * одних пробелов в движке; `.regex(/\S/)` говорит то же самое образцом,
 * который переносится в публикуемую JSON Schema. Обрезку JSON Schema выразить
 * не умеет, и без образца редактор принимал бы `check: "   "`, которое движок
 * отклоняет, — опубликованный контракт врал бы о поведении.
 *
 * Модель одна на конфигурацию и на документ пайплайна (`src/core/pipeline/
 * schema.ts`): объявление в пайплайне перекрывает конфигурацию, а не заводит
 * второй формат, и разъехаться этим двум требованиям нечем.
 */
export const CheckCommandSchema = z.string().trim().min(1).regex(/\S/);

/**
 * Относительный путь от корня репозитория: непустой, не абсолютный, без
 * сегмента `..`. Требование не про аккуратность — `dir` раскрывается в
 * границу правок `<dir>/**`, и пустое значение дало бы `changed_only: /**`
 * (петлю без границ), а `..` вывел бы границу за пределы проверяемого
 * дерева.
 *
 * Непустота записана той же парой, что у `CheckCommandSchema`: `.trim()` в
 * модели и образец `\S` в JSON Schema — обрезку опубликованная схема
 * выразить не умеет. Проверки «не абсолютный» и «без ..» идут `.refine()` и
 * в публикуемую схему не переносятся: их отклонение — не то, что редактор
 * обязан подсветить заранее, а разбор конфигурации отклонит и так.
 */
export const RelativeRepoPathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/\S/)
  .refine((value) => !isAbsolute(value), 'Ожидается относительный путь от корня репозитория')
  .refine(
    (value) => !value.split('/').includes('..'),
    'Путь не может выходить за корень репозитория сегментом ..',
  );

/**
 * Объявление практики спецификации проекта: где лежат документы изменения,
 * по каким правилам они пишутся, каким инструментом заводятся. Каждый ключ
 * необязателен сам по себе — слои конфигурации сливаются по листьям, и
 * репозиторий может объявить часть группы. Умолчаний нет: путь или имя,
 * подставленные за автора, указывали бы в чужом репозитории на
 * несуществующее.
 */
export const RawSpecSchema = z
  .object({
    dir: RelativeRepoPathSchema.optional(),
    rules: RelativeRepoPathSchema.optional(),
    // Та же непустая строка, что и у команды проверки: право, собранное из
    // пустого имени, либо тихо расширяет разрешённое, либо отказывает без
    // причины.
    tool: CheckCommandSchema.optional(),
  })
  .strict();

/**
 * Объявление практики памяти проекта: каким источником читается знание
 * репозитория, где оно лежит и по каким правилам пишется. Устроено тем же
 * порядком, что `RawSpecSchema`, и по той же причине: движок знает, что у
 * репозитория есть память, но про её раскладку не знает ничего — раскладку
 * знает источник.
 *
 * `provider` — единственный ключ с закрытым перечнем: `fs` — встроенный
 * источник (раскладка описана в docs/knowledge.md), `cmd` — любой свой,
 * названный ключом `command`. Умолчания нет ни у одного ключа: источник,
 * подставленный за автора, читал бы в чужом репозитории несуществующий
 * каталог, а величины (`index_max_tokens`, `stale_after`, `timeout`)
 * умолчания как раз имеют — они про поведение движка и источника, а не про
 * устройство чужого дерева, и объявлены встроенным слоем конфигурации.
 */
export const RawKnowledgeSchema = z
  .object({
    provider: z.enum(['fs', 'cmd']).optional(),
    // Команда своего источника — та же непустая строка, что `check` и
    // `spec.tool`: движок её не разбирает, а передаёт оболочке глаголом
    // первым аргументом.
    command: CheckCommandSchema.optional(),
    dir: RelativeRepoPathSchema.optional(),
    rules: RelativeRepoPathSchema.optional(),
    index_max_tokens: amount.optional(),
    stale_after: amount.optional(),
    timeout: amount.optional(),
  })
  .strict();

/**
 * Объявление репозитория: чем он проверяет себя, какими инструментами, по
 * какой практике спецификации и в каких границах его правят. Каждый ключ
 * объяснён у себя же — общего у них только то, что все необязательны и все
 * рассказывают о репозитории, а не о движке.
 */
/**
 * Каталог вложенного репозитория: та же `RelativeRepoPathSchema`, что у
 * `spec.dir` и `edit_paths`, но с дополнительным отказом символам шаблона
 * глоба (`*`, `?`) — значение здесь конкретный каталог, а не образец, по
 * нему заводится отдельное частное состояние составного якоря и им же
 * префиксуются пути в `changedPaths` и `diff.patch`.
 */
const NestedRepoDirSchema = RelativeRepoPathSchema.refine(
  (value) => !/[*?]/.test(value),
  'Путь не может содержать символы шаблона глоба (*, ?)',
);

/**
 * Объектная форма элемента `nested_repos`: вложенный репозиторий объявляет
 * себя тем же языком, каким корень объявляет себя в секции `project` —
 * `CheckCommandSchema` и `RawSpecSchema` переиспользуются, а не копируются,
 * чтобы диагностика отказа не разошлась с одноимёнными ключами `project`.
 */
export const NestedRepoDeclarationSchema = z
  .object({
    dir: NestedRepoDirSchema,
    check: CheckCommandSchema.optional(),
    // Инструменты этого репозитория — той же моделью, что `project.tools`, и
    // тем же смыслом: имена, а не записи прав. В отличие от `check` и `spec`,
    // ключ не замещает корневой, а дополняет его (`resolveItemRepo`): `git`,
    // `npm` и прочее из корневого перечня верны в любом дереве, а `./gradlew`
    // — только там, где лежит обёртка. Репозиторий, объявивший своё, получает
    // корневое плюс своё; не объявивший — ровно корневое, как до этого ключа.
    tools: z.array(CheckCommandSchema).min(1).optional(),
    spec: RawSpecSchema.optional(),
  })
  .strict();

export type NestedRepoDeclaration = z.infer<typeof NestedRepoDeclarationSchema>;

export const RawProjectSchema = z
  .object({
    check: CheckCommandSchema.optional(),
    // Инструменты репозитория — имена, а не готовые записи прав (форма права
    // знает файл работы, не конфигурация). Список, а не строка с
    // разделителем: разделитель не даёт объявить имя с пробелом (`npm run`,
    // `./gradlew`). Пустой список отклоняется здесь же: объявление, не
    // называющее ни одного инструмента, почти наверняка забытая правка, а не
    // «инструментов нет» — для второго ключ просто не заводят. Каждый элемент
    // — та же непустая строка, что `check` и `spec.tool`
    // (`CheckCommandSchema` переиспользуется, а не копируется); пробел внутри
    // значения намеренно допущен теми же причинами.
    tools: z.array(CheckCommandSchema).min(1).optional(),
    spec: RawSpecSchema.optional(),
    // Практика памяти репозитория: чем читается знание, где лежит, по каким
    // правилам пишется. Соседствует со `spec` не случайно — это второе
    // объявление того же рода: движок узнаёт, что практика есть, и не узнаёт,
    // как она устроена.
    knowledge: RawKnowledgeSchema.optional(),
    // Границы правок репозитория: пути и шаблоны глоба от корня, правка
    // которых и есть работа над ним. Модель — `RelativeRepoPathSchema`, та
    // же, что у `spec.dir`: пути в предикат `changed_only` приходят
    // сравнением двух снимков дерева (`git diff-tree --name-only`) и потому
    // всегда относительны корню рабочего дерева — абсолютный путь и путь с
    // `..` не совпали бы ни с одним из них никогда, то есть были бы тихо
    // бесполезной записью, а не расширенной границей. Шаблоны глоба
    // (`src/**`) модель пропускает беспрепятственно.
    //
    // Список между слоями заменяется целиком (ключ не входит ни в
    // `UNION_LIST_KEYS`, ни в `TIGHTEN_ONLY_KEYS`) — так же, как `tools`:
    // граница одного репозитория не «дополняется» соседним слоем, а задаётся
    // им заново. Пустой список отклоняется той же причиной, что `tools: []`,
    // — объявление, не называющее ни одного пути, почти наверняка забытая
    // правка, а не «границ нет»: для последнего ключ просто не заводят.
    edit_paths: z.array(RelativeRepoPathSchema).min(1).optional(),
    // Вложенные репозитории дерева: каждый элемент называет каталог,
    // который сам является рабочим деревом git — строкой, как раньше, либо
    // объектом `{ dir, check, spec }`, где репозиторий заодно объявляет
    // свою команду проверки и практику спецификации (`NestedRepoDeclarationSchema`).
    // Обе формы называют один и тот же каталог: второго места, где
    // перечислены те же пути, изменение сознательно не заводит (design.md,
    // решение 7). Пустой список отклоняется той же причиной, что `tools: []`
    // и `edit_paths: []`; повтор каталога — в любой из форм — тоже отказ
    // разбора (`canonicalizeNestedRepos` в resolve.ts), потому что два
    // объявления одного каталога несравнимы по приоритету между собой.
    //
    // В отличие от соседей по секции, у ключа нет пайплайнового слоя
    // (`ProjectSchema` в src/core/pipeline/schema.ts его не заводит) и он
    // не публикуется подстановкой `${project.*}`: состав описывает форму
    // состояния дерева, которая обязана быть одна на дерево, а не
    // значение, которое документ пайплайна вправе переопределить или
    // куда-то вставить. Та же причина закрывает объявления самих вложенных
    // репозиториев (`check`/`spec` объектной формы) от подстановки: значений
    // тут по числу репозиториев, и выбрать из них нечем, пока не выбран
    // пункт очереди.
    nested_repos: z.array(z.union([NestedRepoDirSchema, NestedRepoDeclarationSchema])).min(1).optional(),
  })
  .strict();

export const RawConfigSchema = z
  .object({
    version: z.literal(1).optional(),
    kind: z.literal('config').optional(),
    runs: RawRunsSchema.optional(),
    defaults: RawDefaultsSchema.optional(),
    limits: RawLimitsSchema.optional(),
    env_deny: z.array(z.string()).optional(),
    context: RawContextSchema.optional(),
    /**
     * Модули плагинов, расширяющих движок (`docs/plugins.md`). Ключ допустим в
     * обоих слоях и между ними объединяется: глобальный называет машинное
     * (адаптер бэкенда, установленный на этой машине), проектный — то, от чего
     * зависит пайплайн репозитория. Пустой список отклоняется — объявление, не
     * объявляющее ничего, забытая правка, а не осмысленное значение.
     */
    plugins: z.array(z.string().min(1).regex(/\S/, 'модуль плагина не может быть пустым')).min(1).optional(),
    backends: z.record(z.string(), RawBackendSchema).optional(),
    ui: RawUiSchema.optional(),
    project: RawProjectSchema.optional(),
  })
  .strict();

export type RawConfig = z.infer<typeof RawConfigSchema>;
export type RawBackend = z.infer<typeof RawBackendSchema>;

/**
 * Ключи, допустимые только в глобальном конфиге. Проектный конфиг лежит в
 * репозитории и попадает в ревью, поэтому машинно-зависимым путям там не место.
 * Шаблон `*` совпадает с одним сегментом пути.
 */
export const GLOBAL_ONLY_KEYS = ['runs.root', 'backends.*.command'] as const;

/**
 * Ключи, допустимые только в проектном конфиге. Глобальный конфиг общий всем
 * репозиториям машины и не может объявлять команду одного из них.
 *
 * Хвостовая форма `**` — «этот ключ и всё под ним». Перечисление уровней
 * (`project.*`, `project.*.*`) не годится: `matchesKeyPattern` сравнивает
 * пути посегментно и требует равной длины, а значит каждое новое углубление
 * секции `project` (как `project.spec.dir`) открывало бы дыру в глобальном
 * конфиге молча, пока про него не вспомнят здесь.
 */
export const PROJECT_ONLY_KEYS = ['project.**'] as const;

/** Списки, которые между слоями объединяются, а не заменяются. */
export const UNION_LIST_KEYS = ['env_deny', 'context.deny', 'plugins'] as const;

/** Потолки: между слоями берётся строжайшее значение, поднять их снизу нельзя. */
export const TIGHTEN_ONLY_KEYS = [
  'limits.tokens',
  'limits.cost',
  'limits.wallclock',
  'limits.concurrency',
  'limits.attempts',
  'limits.iterations',
] as const;
