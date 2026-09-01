## ADDED Requirements

### Requirement: Практика памяти объявляется секцией project.knowledge

Система SHALL принимать секцию `project.knowledge` с ключами `provider`, `command`, `dir`, `rules`, `index_max_tokens`, `stale_after` и `timeout`. Каждый ключ MAY объявляться отдельно, слои сливаются по листьям, и встроенных умолчаний у `provider`, `command`, `dir` и `rules` не MUST быть.

#### Scenario: Объявлен встроенный источник

- **WHEN** проектный конфиг объявляет `provider: fs` и `dir: knowledge`
- **THEN** записи `knowledge:` разрешаются встроенным источником по этому каталогу

#### Scenario: Объявлен собственный источник

- **WHEN** проектный конфиг объявляет `provider: cmd` и `command: node scripts/knowledge.mjs`
- **THEN** записи `knowledge:` разрешаются запуском этой команды, а ключ `dir` источнику не передаётся

#### Scenario: Провайдер cmd без команды

- **WHEN** объявлено `provider: cmd` без ключа `command`
- **THEN** разбор конфигурации отклоняет секцию с диагностикой о недостающей команде

### Requirement: Знание принадлежит репозиторию, а не машине

Система SHALL допускать секцию `project.knowledge` только в `.stepcast/config.yml` и отклонять её в `~/.stepcast/config.yml` — тем же правилом, каким отклоняются `project.check`, `project.tools` и `project.spec`.

#### Scenario: Объявление в глобальном конфиге

- **WHEN** `~/.stepcast/config.yml` содержит секцию `project.knowledge`
- **THEN** разбор конфигурации отклоняет её с диагностикой о недопустимой области объявления

### Requirement: Пути секции знания относительны корню репозитория

Система SHALL проверять `dir` и `rules` той же моделью, что `project.spec.dir` и `project.spec.rules`: непустой относительный путь без сегмента `..`. Пустая строка, строка из пробелов, абсолютный путь и путь с `..` MUST отклоняться разбором конфигурации.

#### Scenario: Абсолютный путь отклонён

- **WHEN** объявлено `dir: /var/knowledge`
- **THEN** разбор конфигурации отклоняет значение

### Requirement: Значения секции знания доступны подстановкой

Система SHALL публиковать значения секции подстановками `${project.knowledge.dir}`, `${project.knowledge.rules}` и `${project.knowledge.provider}` в пайплайне, файлах работ и файлах промптов — тем же правилом, каким публикуются `${project.spec.*}`.

#### Scenario: Правила письма приходят контекстом

- **WHEN** работа объявляет `- path: ${project.knowledge.rules}`
- **THEN** в контекст шага попадает объявленный файл правил

### Requirement: Пайплайн может объявить практику памяти сам

Система SHALL принимать секцию `project.knowledge` верхним ключом `project` документа пайплайна, перекрывающим проектный конфиг полистовым слиянием, — тем же порядком слоёв, каким пайплайн перекрывает `project.check` и `project.spec`.

#### Scenario: Пайплайн переопределяет каталог знания

- **WHEN** конфиг объявляет `dir: knowledge`, а пайплайн — `dir: knowledge/experimental`
- **THEN** записи `knowledge:` этого пайплайна разрешаются по каталогу пайплайна, а прочие ключи секции берутся из конфига
