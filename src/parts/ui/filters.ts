/**
 * Правило, общее двум экранам витрины: список прогонов и очередь улучшений
 * оба держат фильтры состоянием экрана, и оба обязаны не терять выбранное
 * значение, если данные его больше не содержат (`withCurrentOption`). Живёт
 * отдельным модулем, а не повторяется в каждом `runsView`/`backlogView`,
 * потому что правило одно, а не два похожих: расхождение копий при правке
 * одной из них не поймает ни один тест.
 *
 * Модуль чист: ни React, ни `window`, ни чтения диска.
 */

export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Список значений фильтра с текущим выбором внутри, даже если данные его уже
 * не содержат: молча переключить линзу на другое значение — значит показать
 * не то, что выбрал человек.
 */
export function withCurrentOption(
  options: readonly FilterOption[],
  current: string | undefined,
  labelFor: (value: string) => string,
): readonly FilterOption[] {
  if (current === undefined || options.some((option) => option.value === current)) return options;
  return [...options, { value: current, label: labelFor(current) }];
}
