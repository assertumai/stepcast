import type { StepcastPlugin } from './contract.js';

/**
 * Хелпер объявления ядерного плагина (design.md, Решение 1): тождество в
 * рантайме, ничего не оборачивает и не регистрирует — форму проверяет
 * загрузка (`StepcastPluginSchema`). Ценность в проверке литерала на лишние и
 * опечатанные поля: параметр типа не выводится по литералу, если тип входа —
 * не литерал (`StepcastPlugin`), а `.loose()` схемы загрузки опечатку
 * пропускает молча.
 *
 * Доменные хелперы — `definePipelinePlugin`, `defineBackend`,
 * `definePredicate`, `defineStepKind` — публикует подпуть `stepcast/pipeline`
 * (`src/parts/pipeline/surface.ts`), тем же основанием, каким объявление
 * пайплайна публикует его вклад (design.md, Решение 8): второй `definePlugin`
 * с тем же именем в двух подпутях читался бы как один экспорт, и первая же
 * ошибка автора — импортировал ядерный, объявил `steps` — объяснялась бы не
 * там, где сделана.
 */
export function definePlugin(plugin: StepcastPlugin): StepcastPlugin {
  return plugin;
}
