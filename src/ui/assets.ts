/**
 * Страница витрины.
 *
 * Строковой константой, а не отдельным `.html`: `npm run build` — это голый
 * `tsc`, он не копирует нескомпилируемые файлы в `dist/`, и заводить шаг
 * копирования ради одной страницы дороже, чем держать её в `.ts`. Тот же
 * приём уже применён для шаблонов `stepcast init`.
 *
 * Без фреймворка и без сборки по той же причине, по которой в `args.ts` свой
 * разборщик аргументов: страница простая, а бандлер в пакете, который должен
 * ставиться одной командой, стоит дороже.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>stepcast</title>
<style>
  :root {
    --bg: #fbfbfa; --panel: #fff; --border: #e3e3e0; --text: #1c1c1a;
    --dim: #6b6b66; --accent: #2f6f4f; --run: #b4690e; --fail: #a03030;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17171a; --panel: #1f1f23; --border: #33333a; --text: #e8e8e6;
      --dim: #9a9a94; --accent: #6bbd8e; --run: #e0a75e; --fail: #e08585;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 1.5rem; background: var(--bg); color: var(--text);
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
  }
  header { display: flex; align-items: baseline; gap: .75rem; margin-bottom: 1.25rem; }
  h1 { font-size: 1.1rem; margin: 0; font-weight: 650; letter-spacing: -.01em; }
  #live { font-size: .8rem; color: var(--dim); }
  #live.on::before { content: "●"; color: var(--accent); margin-right: .3rem; }
  #live.off::before { content: "○"; margin-right: .3rem; }
  .project { margin-bottom: 1.5rem; }
  .project > h2 {
    font-size: .82rem; font-weight: 600; color: var(--dim); margin: 0 0 .5rem;
    font-family: var(--mono); word-break: break-all;
  }
  .unknown-path { font-style: italic; }
  .run {
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    margin-bottom: .5rem; overflow: hidden;
  }
  .run > summary {
    cursor: pointer; padding: .6rem .8rem; display: flex; gap: .7rem;
    align-items: center; flex-wrap: wrap; list-style: none;
  }
  .run > summary::-webkit-details-marker { display: none; }
  .run > summary::before { content: "▸"; color: var(--dim); font-size: .8rem; }
  .run[open] > summary::before { content: "▾"; }
  .id { font-family: var(--mono); font-weight: 600; }
  .badge {
    font-size: .72rem; padding: .1rem .45rem; border-radius: 99px;
    border: 1px solid var(--border); color: var(--dim);
  }
  .badge.running { color: var(--run); border-color: var(--run); }
  .badge.success { color: var(--accent); border-color: var(--accent); }
  .badge.failed, .badge.budget_exceeded, .badge.canceled {
    color: var(--fail); border-color: var(--fail);
  }
  .when { font-size: .78rem; color: var(--dim); margin-left: auto; }
  .body { padding: 0 .8rem .8rem; border-top: 1px solid var(--border); }
  .note { color: var(--dim); font-size: .85rem; padding: .7rem 0; }
  .job { border-top: 1px solid var(--border); padding: .7rem 0; }
  .job:first-child { border-top: none; }
  .job-head { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .job-name { font-weight: 600; }
  .desc { color: var(--dim); font-size: .85rem; }
  .row { margin-top: .4rem; font-size: .85rem; display: flex; gap: .5rem; flex-wrap: wrap; }
  .row > .label { color: var(--dim); min-width: 7.5rem; }
  .step { margin-top: .5rem; padding-left: .8rem; border-left: 2px solid var(--border); }
  .step-head { display: flex; gap: .5rem; align-items: center; flex-wrap: wrap; }
  .kind { font-size: .72rem; color: var(--dim); font-family: var(--mono); }
  .ctx { font-family: var(--mono); font-size: .78rem; color: var(--dim); margin-top: .3rem; }
  .ctx b { color: var(--text); font-weight: 600; }
  button.file {
    font: inherit; font-size: .8rem; font-family: var(--mono);
    background: none; border: 1px solid var(--border); border-radius: 5px;
    color: var(--text); padding: .1rem .4rem; cursor: pointer;
  }
  button.file:hover { border-color: var(--accent); color: var(--accent); }
  pre {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: .6rem; overflow-x: auto; font-family: var(--mono); font-size: .8rem;
    margin: .4rem 0 0; max-height: 26rem;
  }
  .truncated { color: var(--run); font-size: .78rem; margin-top: .3rem; }
  .empty { color: var(--dim); padding: 2rem 0; }
</style>
</head>
<body>
<header>
  <h1>stepcast</h1>
  <span id="live" class="off">подключение…</span>
</header>
<div id="root"><p class="empty">Прогонов пока нет. Запустите <code>stepcast run</code>.</p></div>

<script>
const root = document.getElementById('root');
const live = document.getElementById('live');
// Какие прогоны раскрыты — переживает перерисовку, иначе живое обновление
// схлопывало бы карточку под курсором.
const open = new Set();
const snapshots = new Map();

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  // Только textContent: имена работ и пути приходят с диска и в разметку не
  // подставляются.
  if (text !== undefined) node.textContent = text;
  return node;
};

const fmtTokens = (v) => {
  if (v === null || v === undefined) return 'не сообщено';
  if (v >= 1e6) return (Number.isInteger(v / 1e6) ? v / 1e6 : (v / 1e6).toFixed(1)) + 'M';
  if (v >= 1e3) return (Number.isInteger(v / 1e3) ? v / 1e3 : (v / 1e3).toFixed(1)) + 'k';
  return String(v);
};

const fmtDuration = (ms) => {
  if (ms === null || ms === undefined) return 'не сообщено';
  if (ms >= 3600000 && ms % 3600000 === 0) return ms / 3600000 + 'h';
  if (ms >= 60000 && ms % 60000 === 0) return ms / 60000 + 'm';
  if (ms >= 1000 && ms % 1000 === 0) return ms / 1000 + 's';
  return Math.round(ms / 1000) + 's';
};

const when = (run) => {
  if (!run.startedAt) return '';
  const started = new Date(run.startedAt).toLocaleString('ru');
  return run.finishedAt ? started + ' → ' + new Date(run.finishedAt).toLocaleTimeString('ru') : started;
};

function fileButton(address, ref) {
  const button = el('button', 'file', ref.name + ' · ' + ref.bytes + ' Б');
  const box = el('div');
  let shown = false;

  button.addEventListener('click', async () => {
    if (shown) { box.textContent = ''; shown = false; return; }
    shown = true;
    box.textContent = '';
    const url = '/api/file?run=' + encodeURIComponent(address) + '&path=' + encodeURIComponent(ref.path);
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) { box.append(el('pre', null, data.error || 'не читается')); return; }
    let text = data.content;
    if (ref.name.endsWith('.json')) {
      try { text = JSON.stringify(JSON.parse(data.content), null, 2); } catch { /* как есть */ }
    }
    box.append(el('pre', null, text));
    if (data.truncated) box.append(el('div', 'truncated', 'файл усечён до 1 МБ из ' + data.bytes + ' Б'));
  });

  const wrap = el('div');
  wrap.append(button, box);
  return wrap;
}

function renderStep(address, step) {
  const node = el('div', 'step');
  const head = el('div', 'step-head');
  head.append(el('span', 'job-name', step.id), el('span', 'kind', step.kind));
  if (step.status) head.append(el('span', 'badge ' + step.status, step.status));
  if (step.attempts > 1) head.append(el('span', 'kind', 'попыток: ' + step.attempts));
  head.append(el('span', 'kind', fmtTokens(step.usage.billableTokens) + '  ' + fmtDuration(step.usage.wallclockMs)));
  node.append(head);

  if (step.reason) node.append(el('div', 'desc', step.reason));
  if (step.command) node.append(el('div', 'ctx', '$ ' + step.command));

  const breakdown = step.contextBreakdown;
  if (breakdown) {
    const line = el('div', 'ctx');
    const levels = [
      ['предшественники', breakdown.levels.upstream],
      ['пайплайн', breakdown.levels.pipeline],
      ['работа', breakdown.levels.job],
      ['шаг', breakdown.levels.step],
    ];
    for (const [name, value] of levels) line.append(document.createTextNode(name + ' ' + value + '  '));
    const total = el('b', null, 'итого ' + breakdown.total + ' ток.');
    line.append(total);
    node.append(line);
  }

  if (step.files.length) {
    const row = el('div', 'row');
    row.append(el('span', 'label', 'файлы'));
    for (const ref of step.files) row.append(fileButton(address, ref));
    node.append(row);
  }
  return node;
}

function renderJob(address, job) {
  const node = el('div', 'job');
  const head = el('div', 'job-head');
  head.append(el('span', 'job-name', job.id));
  if (job.status) head.append(el('span', 'badge ' + job.status, job.status));
  if (job.needs.length) head.append(el('span', 'kind', 'needs: ' + job.needs.join(', ')));
  head.append(el('span', 'kind', fmtTokens(job.usage.billableTokens) + '  ' + fmtDuration(job.usage.wallclockMs)));
  node.append(head);
  if (job.description) node.append(el('div', 'desc', job.description));

  const inputs = el('div', 'row');
  inputs.append(el('span', 'label', 'вход'));
  if (job.inputs.length) {
    for (const ref of job.inputs) inputs.append(fileButton(address, ref));
  } else {
    inputs.append(el('span', 'desc', job.needs.length ? 'предшественники ничего не опубликовали' : 'предшественников нет'));
  }
  node.append(inputs);

  const output = el('div', 'row');
  output.append(el('span', 'label', 'выход'));
  if (job.output) output.append(fileButton(address, job.output));
  else if (job.outputDeclared) output.append(el('span', 'desc', 'объявлен, ещё не опубликован'));
  else output.append(el('span', 'desc', 'не объявлен'));
  node.append(output);

  for (const step of job.steps) node.append(renderStep(address, step));
  return node;
}

async function loadSnapshot(address, into) {
  into.textContent = '';
  const response = await fetch('/api/run?run=' + encodeURIComponent(address));
  const data = await response.json();
  if (!response.ok) { into.append(el('p', 'note', data.error || 'не читается')); return; }
  snapshots.set(address, data);

  if (data.swept) {
    into.append(el('p', 'note', 'Прогон убран: остались только манифест, состояние и расход. Подробностей больше нет.'));
  }
  if (!data.jobs.length) {
    into.append(el('p', 'note', 'Работ в этом прогоне не записано.'));
  }
  for (const job of data.jobs) into.append(renderJob(address, job));
}

function renderRun(projectKey, run) {
  const address = projectKey + '/' + run.runId;
  const node = el('details', 'run');
  if (open.has(address)) node.open = true;

  const summary = el('summary');
  summary.append(el('span', 'id', run.shortId));
  if (run.pipeline) summary.append(el('span', 'desc', run.pipeline));
  summary.append(el('span', 'badge ' + (run.status || ''), run.status || 'неизвестно'));
  if (run.swept) summary.append(el('span', 'badge', 'убран'));
  if (run.unreadable) summary.append(el('span', 'badge', 'не читается'));
  if (run.usage) {
    summary.append(el('span', 'kind', fmtTokens(run.usage.billableTokens) + '  ' + fmtDuration(run.usage.wallclockMs)));
  }
  summary.append(el('span', 'when', when(run)));
  node.append(summary);

  const body = el('div', 'body');
  node.append(body);

  node.addEventListener('toggle', () => {
    if (node.open) { open.add(address); loadSnapshot(address, body); }
    else { open.delete(address); body.textContent = ''; }
  });
  if (node.open) loadSnapshot(address, body);

  return node;
}

function render(overview) {
  root.textContent = '';
  if (!overview.projects.length) {
    root.append(el('p', 'empty', 'Прогонов пока нет. Запустите stepcast run.'));
    return;
  }
  for (const project of overview.projects) {
    const block = el('div', 'project');
    const title = el('h2', project.path ? null : 'unknown-path',
      project.path || project.key + ' — путь неизвестен');
    block.append(title);
    for (const run of project.runs) block.append(renderRun(project.key, run));
    root.append(block);
  }
}

const source = new EventSource('/api/events');
source.addEventListener('overview', (event) => {
  live.className = 'on';
  live.textContent = 'живое обновление';
  render(JSON.parse(event.data));
});
source.addEventListener('error', () => {
  live.className = 'off';
  live.textContent = 'нет связи с демоном';
});
</script>
</body>
</html>
`;
