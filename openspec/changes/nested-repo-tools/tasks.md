## 1. Размножение списочного значения на позднем раскрытии

- [x] 1.1 `test/late.test.ts`: строковый массив из выхода работы размножает элемент списка; тот же массив в скалярном поле остаётся непредставимым строкой с подсказкой о списке; пустой массив отказывает сообщением о пустом списке. Прежние два теста, фиксировавшие обратное, переписаны — их предмет и есть предмет этого изменения.
- [x] 1.2 `src/core/pipeline/interpolate.ts`: снять ранний выход `resolveListExpansion` по `mode === 'late'` и оговорку `scope.mode !== 'late'` у подсказки `renderValue`; комментарии правила переписаны под оба этапа.

## 2. Инструменты вложенного репозитория

- [x] 2.1 `test/project-repos.test.ts`: сложение перечней с корневыми впереди, репозиторий без своих инструментов, дерево без объявленных инструментов (ключа в ответе нет).
- [x] 2.2 `src/core/config/schema.ts`: ключ `tools` объектной формы `nested_repos`, той же моделью, что `project.tools`.
- [x] 2.3 `src/core/config/resolve.ts`: `tools` в `NestedRepoDeclaration` и его приведение в `canonicalizeNestedRepos`.
- [x] 2.4 `src/core/project/repos.ts`: `mergeTools` — единственное место сложения; `ResolvedRepo.tools` необязателен.
- [x] 2.5 `src/core/backlog/schema.ts` и `npm run schema`: необязательный `tools` в блоке `repo`, пересобранные `schema/config.schema.json` и `schema/backlog-slots.schema.json`.

## 3. Документация

- [x] 3.1 `docs/config.md`: ключ в объектной форме состава и правило сложения, а не замещения.
- [x] 3.2 `docs/pipeline-format.md`: правило раскрытия действует на обоих этапах; довод про снимок переписан.
- [x] 3.3 `openspec/changes/nested-repo-tools/status.md` и `npm run status:build`: два прежних ограничения сняты, новое поведение записано.
