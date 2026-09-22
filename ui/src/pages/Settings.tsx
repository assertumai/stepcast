import { useEffect, useState, type JSX } from 'react';

import { fetchPipelines, fetchSettings, saveSettings, type PipelineView, type Settings as SettingsData } from '../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@stepcast/ui';
import './settings.css';

/** Четыре числа для области действия `defaults.model`, посчитанные по известным витрине пайплайнам. */
interface ModelScope {
  /** Агентские шаги, которым модель назначит именно правка этого экрана. */
  readonly affected: number;
  /** Агентские шаги, объявившие модель сами (слой step/pipeline) — их правка не коснётся. */
  readonly unaffected: number;
  /** Агентские шаги, чью модель задаёт другой файл: проектный `.stepcast/config.yml` либо плагин. */
  readonly overridden: number;
  /** Пайплайны, которые не разбираются: их шаги не сосчитаны ни в одну из групп. */
  readonly unparsed: number;
}

/**
 * Счёт складывается здесь же, из ответа `/api/pipelines`, а не в `readSettings`:
 * `defaults.model` — вопрос конфигурации, размер области действия — вопрос
 * пайплайнов, и оба экрана обязаны видеть одни и те же числа (design.md,
 * Решение 3).
 *
 * Слоя `config` для счёта мало: экран пишет только глобальный файл
 * (`src/parts/ui/settings.ts`), а значение того же слоя может прийти из проектного
 * `.stepcast/config.yml` или от плагина — и там правка отсюда проиграет
 * ближнему слою. Различает их файл, победивший в проекте: витрина уже несёт его
 * на карточке шага, и сравнить с файлом настроек — единственный способ не
 * посчитать чужой шаг своим (docs/config.md, «Разрешение»).
 */
function scopeOf(pipelines: readonly PipelineView[], settingsFile: string): ModelScope {
  let affected = 0;
  let unaffected = 0;
  let overridden = 0;
  let unparsed = 0;
  for (const pipeline of pipelines) {
    if (pipeline.error !== undefined) {
      unparsed += 1;
      continue;
    }
    for (const job of pipeline.jobs) {
      for (const step of job.steps) {
        const origin = step.modelOrigin;
        if (origin === undefined) continue;
        if (origin.layer === 'step' || origin.layer === 'job' || origin.layer === 'pipeline') unaffected += 1;
        else if (origin.layer !== 'config') affected += 1;
        else if (origin.file === settingsFile) affected += 1;
        else overridden += 1;
      }
    }
  }
  return { affected, unaffected, overridden, unparsed };
}

/**
 * Экран настроек: агент и модель по умолчанию.
 *
 * Витрина охватывает все проекты сразу, поэтому правит она глобальный файл, а
 * не проектный, — и говорит, какой именно: правка настроек вслепую, без имени
 * файла на экране, оставляет пользователя гадать, где искать её след.
 *
 * Показывается и происхождение каждого значения (`source`): «встроенное
 * умолчание» и «взято из такого-то файла» — разные вещи, и человек, который
 * видит модель на экране, должен понимать, правил ли её кто-то до него.
 */
export function Settings(): JSX.Element {
  const [settings, setSettings] = useState<SettingsData | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Черновик отделён от сохранённого: поле модели правится по букве, и
  // приравнивать каждое нажатие к записи в конфигурацию проекта нельзя.
  const [agent, setAgent] = useState<string>('');
  const [model, setModel] = useState<string>('');

  // `undefined` — ещё не пришёл ответ; `null` — пришёл отказ либо пустой
  // список: пайплайнов витрине не известно, и ноль здесь был бы неправдой, а
  // не фактом (design.md, Решение 3).
  const [pipelines, setPipelines] = useState<readonly PipelineView[] | null | undefined>(undefined);

  const adopt = (data: SettingsData): void => {
    setSettings(data);
    setAgent(data.agent.value ?? '');
    setModel(data.model.value ?? '');
  };

  useEffect(() => {
    fetchSettings()
      .then(adopt)
      .catch((failure: Error) => setError(failure.message));
    fetchPipelines()
      .then((data) => setPipelines(data.pipelines.length === 0 ? null : data.pipelines))
      .catch(() => setPipelines(null));
  }, []);

  if (error !== undefined && settings === undefined) {
    return (
      <>
        <PageHeader title="Settings" description="Default agent and model for every project." />
        <Alert variant="destructive">{error}</Alert>
      </>
    );
  }
  if (settings === undefined) {
    return (
      <>
        <PageHeader title="Settings" description="Default agent and model for every project." />
        <EmptyState title="Loading…" />
      </>
    );
  }

  const dirty = agent !== (settings.agent.value ?? '') || model !== (settings.model.value ?? '');

  const submit = (): void => {
    setSaving(true);
    setError(undefined);
    setSaved(false);
    // Пустая модель — это снятие значения (`null`), а не пустая строка: модель
    // тогда берётся у бэкенда, и записать вместо неё пустоту значило бы
    // сломать следующий прогон вместо возврата к умолчанию.
    saveSettings({ agent, model: model === '' ? null : model })
      .then((data) => {
        adopt(data);
        setSaved(true);
      })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setSaving(false));
  };

  const enabled = settings.backends.filter((backend) => backend.enabled && backend.available);
  const chosen = settings.backends.find((backend) => backend.name === agent);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Default agent and model for every project; changes are written to the global config file named on the card."
      />

      <Card className="settings-card">
        <CardHeader>
          <CardTitle>Defaults for all projects</CardTitle>
          <CardDescription className="mono">{settings.file}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="field">
            <Label className="label" htmlFor="settings-agent">
              agent
            </Label>
            <div className="field-body">
              {/* Пустого пункта в списке нет: выбрать «ничего» нельзя —
                  `defaults.agent` снятию не подлежит. Пока значения нет, поле
                  показывает подсказку вместо выбранного. */}
              <Select value={agent} onValueChange={setAgent}>
                <SelectTrigger id="settings-agent" className="settings-agent" aria-label="Agent">
                  <SelectValue placeholder="not set" />
                </SelectTrigger>
                <SelectContent>
                  {enabled.map((backend) => (
                    <SelectItem key={backend.name} value={backend.name}>
                      {backend.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="small dim">{settings.agent.source}</span>
            </div>
          </div>

          <div className="field">
            <Label className="label" htmlFor="settings-model">
              model
            </Label>
            <div className="field-body">
              <Input
                id="settings-model"
                className="mono"
                value={model}
                placeholder={chosen?.defaultModel ?? 'backend model'}
                onChange={(event) => setModel(event.target.value)}
              />
              <span className="small dim">
                {settings.model.value === undefined
                  ? `not set — a step without its own model gets the backend model${chosen?.defaultModel === undefined ? '' : `: ${chosen.defaultModel}`}`
                  : settings.model.source}
              </span>
            </div>
          </div>

          <div className="field">
            <span className="label" />
            <div className="field-body">
              <p className="note dim">
                The value applies only to steps that do not declare a model themselves — neither in the
                step, nor in the job, nor in the pipeline defaults.{' '}
                {pipelines === undefined ? (
                  'The scope is still being counted…'
                ) : pipelines === null ? (
                  'No pipelines are known — there is nothing to count the scope from.'
                ) : (
                  (() => {
                    const scope = scopeOf(pipelines, settings.file);
                    return (
                      <>
                        Across the pipelines known to the dashboard it affects <b>{scope.affected}</b> step(s)
                        and leaves <b>{scope.unaffected}</b> alone — they already declare a model
                        {scope.overridden === 0 ? null : (
                          <>
                            ; <b>{scope.overridden}</b> more take the model from a closer file — the project
                            or a plugin — and editing here does not change them
                          </>
                        )}
                        {scope.unparsed === 0 ? null : (
                          <>
                            ; <b>{scope.unparsed}</b> pipeline(s) could not be parsed, their steps are not counted
                          </>
                        )}
                        .
                      </>
                    );
                  })()
                )}
              </p>
            </div>
          </div>

          <div className="field">
            <span className="label" />
            <div className="field-body">
              <Button disabled={!dirty || saving} onClick={submit}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {dirty ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    adopt(settings);
                    setSaved(false);
                  }}
                >
                  Discard changes
                </Button>
              ) : null}
              {saved && !dirty ? <span className="small dim">saved</span> : null}
            </div>
          </div>

          {error === undefined ? null : (
            <Alert variant="destructive" className="settings-error">
              {error}
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card className="settings-card">
        <CardHeader>
          <CardTitle>Backends</CardTitle>
          <CardDescription>Agent CLIs the daemon knows; the default one is marked.</CardDescription>
        </CardHeader>
        <CardContent>
          {settings.backends.length === 0 ? (
            <EmptyState title="No backends declared" />
          ) : (
            settings.backends.map((backend) => (
              <div key={backend.name} className="job">
                <div className="job-head">
                  <span className="job-name">{backend.name}</span>
                  {backend.enabled ? null : <Badge variant="secondary">disabled</Badge>}
                  {backend.name === settings.agent.value ? <Badge variant="success">default</Badge> : null}
                </div>
                <div className="ctx">$ {backend.command}</div>
                {backend.defaultModel === undefined ? null : (
                  <div className="ctx">backend model: {backend.defaultModel}</div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </>
  );
}
