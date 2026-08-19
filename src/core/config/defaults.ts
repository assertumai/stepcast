import type { RawConfig } from './schema.js';

/**
 * Встроенные умолчания. Это такой же слой конфигурации, как файлы и флаги, —
 * поэтому у каждого значения из него в отчёте `stepcast config` будет честный
 * источник «встроенное умолчание», а не пустота.
 */
export const BUILTIN_CONFIG: RawConfig = {
  runs: {
    root: '~/.stepcast/runs',
    keep: '30d',
  },
  defaults: {
    agent: 'claude',
    workspace: { mode: 'cwd' },
    session: 'shared',
    concurrency: 1,
    fail_fast: true,
    step_timeout: '30m',
    stall_timeout: '5m',
  },
  limits: {
    tokens: '5M',
    wallclock: '4h',
    concurrency: 8,
    attempts: 5,
    iterations: 10,
  },
  // Широкий список: при полном наследовании окружения это единственный фильтр
  // между учётными данными машины и подпроцессами, которые запустит агент.
  //
  // Шаблона SSH_* здесь намеренно нет. Он выглядит осторожным, но ловит
  // SSH_AUTH_SOCK, SSH_AGENT_PID и SSH_CONNECTION — не секреты, а адрес
  // сокета и сведения о сеансе. Без SSH_AUTH_SOCK перестаёт работать git по
  // ssh, то есть первый же реальный шаг. Ключи ловятся шаблонами *_KEY.
  env_deny: [
    '*_TOKEN',
    '*_SECRET',
    '*_PASSWORD',
    '*_KEY',
    '*_CREDENTIALS',
    'AWS_*',
    'KUBECONFIG',
  ],
  context: {
    inline_threshold: '4k',
    max_tokens: '120k',
    deny: ['**/.env*', '**/*.pem', '**/*.key', '**/id_rsa*', '**/.git/**'],
  },
  backends: {
    claude: {
      command: 'claude',
      enabled: true,
      concurrency: 2,
      // Чтение кеша дешевле обычного ввода примерно вдесятеро; считать его
      // наравне значило бы объявлять катастрофой то, что на деле экономия.
      cache_read_weight: 0.1,
      sessions: true,
      structured_output: true,
      // Агентские CLI обновляются сами и могут обновиться посреди прогона.
      env: { DISABLE_AUTOUPDATER: '1' },
    },
  },
  ui: {
    port: 7717,
  },
};
