import { definePlugin, StepcastError, type CliIo, type CommandContribution, type ParsedArgs } from 'stepcast/plugin';

/**
 * Образец плагина, знающего только ядро (`plugin-surface-split`, design.md,
 * Решение 10, Решение 9): машинная проверка признака «плагин, пользующийся
 * только ядром, компилируется без доменного подпутя». Вносит одну команду и
 * не называет ни одного объявления пайплайна — ни шага, ни работы, ни
 * бэкенда, ни предиката — ни типом, ни значением. Импорт — только
 * `stepcast/plugin`, наравне с образцом доменного вклада
 * (`examples/plugins/typed`), который берёт `stepcast/pipeline`.
 */

const hello: CommandContribution = {
  name: 'hello',
  spec: { description: 'поздороваться с именем: stepcast hello <имя>', positional: ['name'] },
  run(args: ParsedArgs, io: CliIo) {
    const name = args.positional[0];
    if (name === undefined) {
      throw new StepcastError('Команда hello ждёт имя: stepcast hello <имя>', {
        hint: 'stepcast hello <имя>',
      });
    }
    io.out(`Привет, ${name}!`);
    return 0;
  },
};

export default definePlugin({
  name: 'command-example',
  version: '0.1.0',
  commands: [hello],
});
