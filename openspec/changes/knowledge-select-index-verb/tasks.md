## 1. Падающий тест

- [x] 1.1 В `test/knowledge.test.ts`, в блоке `describe('knowledge-source: контракт внешней команды', …)`, добавить источник-заглушку, которая пишет в файл (или переменную процесса, доступную тесту) вызванный глагол и полученный на stdin запрос. Тест вызывает `source.select({ kind: 'index' })` и проверяет: вызванный глагол — `index`, запрос — `{}`, и глагол `select` при этом не вызывался ни разу. Тест обязан падать на сегодняшнем коде (глагол вызывается `select` с запросом `{"index":true}`).
- [x] 1.2 В том же блоке добавить проверку (можно тем же стендом), что вызовы `select` по `{ kind: 'scope', scope }` и `{ kind: 'id', id }` несут запрос ровно из полей `scope`/`id`/`budget` (без лишних ключей, включая `index`) — сверкой `Object.keys(request)` с ожидаемым набором.

## 2. Правка source.ts

- [x] 2.1 В `src/core/knowledge/source.ts`, `CommandKnowledgeSource.select()`: убрать ветку, вызывающую `this.call('select', { index: true }, …)`. Для `selector.kind === 'index'` вызывать `this.index()` (глагол `index`, запрос `{}`) и свернуть полученные `KnowledgeIndexEntry[]` в один `KnowledgeEntry` с полем `text` — построчным перечислением `id`, `title` и `scope` записей; пустой список — текст, говорящий, что оглавление пусто (по образцу `renderContextIndex`/`renderEntryLine` в `src/core/knowledge/fs.ts`, но без бюджетной укладки `spec_index_max_tokens`, которая остаётся особенностью `fs` и в `cmd`-контракт не входит).
- [x] 2.2 Убедиться, что форма запроса `select` для веток `scope` и `id` не изменилась по составу полей (только `scope`/`id` и опциональный `budget`) — рефакторинг не должен задеть эти ветки по существу.

## 3. Проверка

- [x] 3.1 `npm run check` проходит, включая новый и существующие тесты `test/knowledge.test.ts`.
- [x] 3.2 `openspec validate knowledge-select-index-verb --strict` проходит.
