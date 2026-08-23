## MODIFIED Requirements

### Requirement: Правила разрешения путей

Пути в `uses`, `prompt: file:` и `schema` SHALL разрешаться относительно файла,
в котором объявлены. Правило для `schema` MUST применяться одинаково к
`output_schema` шага, к `output.schema` работы и к предикату `schema` в
`expect` и в `until.check`.

Пути в `context`, `output` и аргументах `run` SHALL разрешаться относительно
корня рабочей директории работы. По этому же правилу разрешаются пути
предиката `file_exists`.

#### Scenario: Промпт рядом с файлом работы

- **WHEN** файл `.stepcast/jobs/implement.yml` объявляет `prompt: file:../prompts/implement.md`
- **THEN** читается `.stepcast/prompts/implement.md`

#### Scenario: Контекст от корня рабочей директории

- **WHEN** тот же файл работы объявляет `context: [AGENTS.md]`
- **THEN** читается `AGENTS.md` из корня рабочей директории, а не из `.stepcast/jobs/`

#### Scenario: Схема предиката рядом с файлом работы

- **WHEN** файл `.stepcast/jobs/implement.yml` объявляет предикат
  `expect: [{ schema: ../schemas/implement.json }]`
- **THEN** читается `.stepcast/schemas/implement.json`

#### Scenario: Схема предиката в условии сходимости

- **WHEN** тот же файл работы объявляет `until.check` с предикатом
  `schema: ../schemas/implement.json`
- **THEN** путь разрешается по тому же правилу, что и в `expect`

#### Scenario: Файл, созданный шагом, от корня рабочей директории

- **WHEN** файл работы вне корня объявляет `expect: [{ file_exists: report.json }]`
- **THEN** проверяется `report.json` в корне рабочей директории
