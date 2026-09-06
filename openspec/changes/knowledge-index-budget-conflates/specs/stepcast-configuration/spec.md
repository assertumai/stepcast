## MODIFIED Requirements

### Requirement: Практика памяти объявляется секцией project.knowledge

Система SHALL принимать секцию `project.knowledge` с ключами `provider`, `command`, `dir`, `rules`, `index_max_tokens`, `spec_index_max_tokens`, `unit_max_tokens`, `stale_after` и `timeout`. Каждый ключ MAY объявляться отдельно, слои сливаются по листьям, и встроенных умолчаний у `provider`, `command`, `dir` и `rules` не MUST быть.

Величины `spec_index_max_tokens` и `unit_max_tokens` MUST задаваться в токенах
той же записью, что `index_max_tokens`, и MUST иметь встроенные умолчания `2k` и
`1k`: они описывают поведение движка, а не устройство чужого дерева.

Пределы MUST быть независимыми друг от друга: объявление одного MUST NOT менять
действующее значение другого.

#### Scenario: Объявлен встроенный источник

- **WHEN** проектный конфиг объявляет `provider: fs` и `dir: knowledge`
- **THEN** записи `knowledge:` разрешаются встроенным источником по этому каталогу

#### Scenario: Объявлен собственный источник

- **WHEN** проектный конфиг объявляет `provider: cmd` и `command: node scripts/knowledge.mjs`
- **THEN** записи `knowledge:` разрешаются запуском этой команды, а ключ `dir` источнику не передаётся

#### Scenario: Провайдер cmd без команды

- **WHEN** объявлено `provider: cmd` без ключа `command`
- **THEN** разбор конфигурации отклоняет секцию с диагностикой о недостающей команде

#### Scenario: Умолчания пределов

- **WHEN** секция объявлена без ключей пределов
- **THEN** разрешённая конфигурация несёт `index_max_tokens` `2k`, `spec_index_max_tokens` `2k` и `unit_max_tokens` `1k`

#### Scenario: Объявлен только предел производной части

- **WHEN** проектный конфиг объявляет `spec_index_max_tokens: 6k`
- **THEN** это значение действует, а `index_max_tokens` остаётся умолчанием `2k`
