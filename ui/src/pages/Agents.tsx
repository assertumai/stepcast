import { useEffect, useState, type JSX } from 'react';

import { MODEL_TIERS, type ModelTier } from '../../../src/parts/pipeline/config/modelTiers';
import {
  fetchModels, fetchSettings, saveSettings,
  type ModelOption, type ModelsForBackend, type ModelsResult, type Settings, type SettingsPatch,
} from '../api';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Combobox,
  Label,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type ComboboxOption,
} from '@stepcast/ui';
import './agents.css';

type AgentDraft = { defaultModel: string; modelTiers: Partial<Record<ModelTier, string>> };

/**
 * Причина недоступности распознавания — словами, как её видит пользователь.
 *
 * Текст CLI и текст исключения идут при подписи, а не голыми: без неё
 * непонятно, чей это текст и о чём он, а CLI, отказавший молча (ненулевой код
 * без единого байта вывода), оставил бы в карточке пустую строку — ни списка,
 * ни причины, ни следа того, что проба вообще была.
 */
export function unavailableReason(result: ModelsForBackend): string | undefined {
  switch (result.status) {
    case 'ok': return undefined;
    case 'unsupported': return 'This agent cannot list its models — type a model name';
    case 'not_installed': return `Command “${result.command}” not found`;
    case 'timeout': return 'The agent did not answer in time';
    case 'failed': return withText('The agent failed', result.message, 'without saying why');
    case 'unparsed': return 'The agent’s answer could not be parsed';
    case 'probe_error': return withText('Listing crashed', result.message, 'without explanation');
  }
}

/** Подпись причины и текст, который прислал не браузер: пустой текст не оставляет подпись голой. */
function withText(label: string, text: string, whenEmpty: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? `${label} ${whenEmpty}` : `${label}: ${trimmed}`;
}

/**
 * Варианты поля модели: перечисленные CLI плюс те имена, которые уже стоят в
 * конфигурации, — модель по умолчанию и модели тиров. Перечень CLI заведомо
 * неполон (design.md, решение 4), и сохранённое значение обязано оставаться
 * выбираемым, а не только «custom».
 */
export function modelOptions(listed: readonly ModelOption[], configured: readonly (string | undefined)[]): readonly ComboboxOption[] {
  const options: ComboboxOption[] = listed.map((option) => ({
    value: option.name,
    ...(option.title === undefined ? {} : { description: option.title }),
  }));
  const seen = new Set(options.map((option) => option.value));
  for (const name of configured) {
    const trimmed = name?.trim() ?? '';
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    options.push({ value: trimmed, description: 'from configuration' });
  }
  return options;
}

interface ModelFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly sourceNote: string;
  readonly options: readonly ComboboxOption[];
  readonly onChange: (value: string) => void;
}

/**
 * Поле модели — Combobox со свободным вводом, а не закрытый список: перечень
 * неполон по устройству (design.md, решение 4), и запирать в нём выбор
 * значило бы сделать распознавание хуже свободного ввода (решение 8).
 * Набранное имя вне списка — обычное состояние, отмеченное бейджем `custom`.
 */
function ModelField({ id, label, value, placeholder, sourceNote, options, onChange }: ModelFieldProps): JSX.Element {
  const trimmed = value.trim();
  const custom = trimmed !== '' && !options.some((option) => option.value === trimmed);

  return (
    <div className="agent-field">
      <Label htmlFor={id} className="agent-field-label mono">{label}</Label>
      <div className="agent-field-body">
        <div className="agent-field-row">
          <Combobox
            id={id}
            mono
            allowCustom
            value={value}
            options={options}
            placeholder={placeholder}
            emptyText="No listed model matches — the typed name is used as is"
            onChange={onChange}
          />
          {custom ? <Badge variant="secondary">custom</Badge> : null}
        </div>
        <span className="small dim">{sourceNote}</span>
      </div>
    </div>
  );
}

/** Глобальные модели агентов; отправляются только изменённые поля. */
export function Agents(): JSX.Element {
  const [settings, setSettings] = useState<Settings>();
  const [draft, setDraft] = useState<Record<string, AgentDraft>>({});
  const [agent, setAgent] = useState('');
  const [connectCodex, setConnectCodex] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<ModelsResult>();
  const [modelsError, setModelsError] = useState<string>();
  const [modelsBusy, setModelsBusy] = useState(true);

  const adopt = (data: Settings): void => {
    setSettings(data);
    setAgent(data.agent.value ?? '');
    setDraft(Object.fromEntries(data.backends.map((backend) => [backend.name, {
      defaultModel: backend.defaultModel ?? '', modelTiers: { ...backend.modelTiers },
    }])));
    setConnectCodex(false);
  };

  useEffect(() => {
    fetchSettings().then(adopt).catch((failure: Error) => setError(failure.message));
  }, []);

  // Списки — отдельным запросом (design.md, решение 5): пробы поднимают
  // дочерние процессы демона и могут занять секунды на агента, а страница уже
  // отрисована и правима по одним настройкам.
  //
  // `refresh` — не украшение: демон держит ответ пробы, пока жив, и держит его
  // одинаково для списка и для отказа. Без явного «перечислить заново»
  // пользователь, починивший причину (поставил агента, поправил `command`,
  // авторизовался), видел бы прежний отказ до перезапуска `stepcast up`.
  const loadModels = (refresh = false): void => {
    setModelsBusy(true);
    setModelsError(undefined);
    if (refresh) setModels(undefined);
    fetchModels(refresh)
      .then(setModels)
      .catch((failure: Error) => setModelsError(failure.message))
      .finally(() => setModelsBusy(false));
  };

  // Один запрос на открытие страницы; дальше — только по кнопке.
  useEffect(() => loadModels(), []);

  const header = (
    <PageHeader
      title="Agents"
      description="Default models for every project, per agent and per tier. Project settings may override these values."
      actions={
        <Button variant="outline" size="sm" onClick={() => loadModels(true)} disabled={modelsBusy}>
          {modelsBusy ? 'Listing models…' : 'Reload models'}
        </Button>
      }
    />
  );

  if (settings === undefined) {
    return (
      <>
        {header}
        {error === undefined ? <p className="dim">Loading…</p> : <Alert variant="destructive">{error}</Alert>}
      </>
    );
  }

  const backendPatch: NonNullable<SettingsPatch['backends']> = Object.fromEntries(
    settings.backends.flatMap((backend) => {
      const next = draft[backend.name]!;
      const modelTiers = Object.fromEntries(MODEL_TIERS.flatMap((tier) => {
        const value = (next.modelTiers[tier] ?? '').trim();
        return value === (backend.modelTiers[tier] ?? '') ? [] : [[tier, value || null]];
      }));
      const defaultChanged = next.defaultModel.trim() !== (backend.defaultModel ?? '');
      if (!defaultChanged && Object.keys(modelTiers).length === 0) return [];
      return [[backend.name, {
        ...(defaultChanged ? { defaultModel: next.defaultModel.trim() || null } : {}),
        ...(Object.keys(modelTiers).length === 0 ? {} : { modelTiers }),
      }]];
    }),
  );
  const dirty = agent !== settings.agent.value || connectCodex || Object.keys(backendPatch).length > 0;
  const selected = settings.backends.find((backend) => backend.name === agent);
  const canSelect = selected?.enabled && (selected.available || (agent === 'codex' && connectCodex));

  const updateModel = (name: string, value: string, tier?: ModelTier): void => {
    setSaved(false);
    setDraft((previous) => {
      const current = previous[name]!;
      return { ...previous, [name]: tier === undefined
        ? { ...current, defaultModel: value }
        : { ...current, modelTiers: { ...current.modelTiers, [tier]: value } } };
    });
  };

  const submit = (): void => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    saveSettings({
      ...(agent === settings.agent.value ? {} : { agent }),
      ...(connectCodex ? { connectCodex: true } : {}),
      ...(Object.keys(backendPatch).length === 0 ? {} : { backends: backendPatch }),
    }).then((data) => { adopt(data); setSaved(true); })
      .catch((failure: Error) => setError(failure.message))
      .finally(() => setSaving(false));
  };

  const codexOffered = settings.backends.some((backend) => backend.name === 'codex' && !backend.available);

  return (
    <>
      {header}
      <fieldset className="agent-settings" disabled={saving}>
        <Card>
          <CardHeader>
            <CardTitle>Default agent</CardTitle>
            <CardDescription>
              Used when a pipeline, job or step does not set <code>agent</code>. Written to{' '}
              <span className="mono">{settings.file}</span>.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="agent-field">
              <Label htmlFor="default-agent" className="agent-field-label">agent</Label>
              <div className="agent-field-body">
                <Select value={agent} onValueChange={(value) => { setAgent(value); setSaved(false); }}>
                  <SelectTrigger id="default-agent" className="agent-select">
                    <SelectValue placeholder="not set" />
                  </SelectTrigger>
                  <SelectContent>
                    {settings.backends.map((backend) => (
                      <SelectItem key={backend.name} value={backend.name}
                        disabled={!backend.enabled || (!backend.available && !(backend.name === 'codex' && connectCodex))}>
                        {backend.name}{!backend.available ? ' — plugin not connected' : !backend.enabled ? ' — disabled' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="small dim">{settings.agent.source}</span>
              </div>
            </div>
            {codexOffered ? (
              <div className="agent-field">
                <span className="agent-field-label" />
                <div className="agent-field-body">
                  <label className="check">
                    <input type="checkbox" checked={connectCodex} onChange={(event) => { setConnectCodex(event.target.checked); setSaved(false); }} />
                    {' '}Connect Codex
                  </label>
                  <span className="small dim">Adds the Codex plugin shipped with Stepcast. Running it needs an installed and signed-in Codex CLI.</span>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {settings.model.value === undefined ? null : (
          <Alert variant="warning">
            A global <code>model</code> override <span className="mono">{settings.model.value}</span> ({settings.model.source}) takes
            precedence over tiers and per-agent models. Remove it on the <a href="/settings">Settings</a> page.
          </Alert>
        )}

        <p className="small dim agent-note">
          <code>agent</code>, <code>model</code> and <code>model_tier</code> are inherited independently: step → job → pipeline → settings.
          An explicit <code>model</code> wins over <code>model_tier</code>; an empty tier falls back to the agent’s default model.
          The dropdown lists what the agent’s CLI reports and is not exhaustive — a typed name is saved as is.
          Lists are read once and kept while the daemon runs; after installing an agent or changing its command, reload them.
        </p>

        <div className="agent-cards">
          {settings.backends.map((backend) => {
            const discovery = models?.backends[backend.name];
            const reason = discovery === undefined
              ? (modelsError ?? 'Listing models…')
              : unavailableReason(discovery);
            const listed: readonly ModelOption[] = discovery?.status === 'ok' ? discovery.models : [];
            const current = draft[backend.name]!;
            const options = modelOptions(listed, [
              backend.defaultModel,
              current.defaultModel,
              ...MODEL_TIERS.map((tier) => backend.modelTiers[tier]),
            ]);

            return (
              <Card key={backend.name} className="agent-card">
                <CardHeader>
                  <div className="agent-card-head">
                    <CardTitle>{backend.name}</CardTitle>
                    <span className="small dim mono">{backend.command}</span>
                    {!backend.available ? <Badge>plugin not connected</Badge> : !backend.enabled ? <Badge>disabled</Badge> : null}
                    {discovery?.status === 'ok' ? <Badge variant="success">{discovery.models.length} models listed</Badge> : null}
                  </div>
                  {reason === undefined ? null : <CardDescription>{reason}</CardDescription>}
                </CardHeader>
                <CardContent>
                  <ModelField
                    id={`agent-${backend.name}-model`}
                    label="default model"
                    value={current.defaultModel}
                    placeholder="agent’s built-in model"
                    sourceNote={`${backend.defaultModelSource}. An empty field removes the override.`}
                    options={options}
                    onChange={(value) => updateModel(backend.name, value)}
                  />
                  {MODEL_TIERS.map((tier) => (
                    <ModelField
                      key={tier}
                      id={`agent-${backend.name}-${tier}`}
                      label={tier}
                      value={current.modelTiers[tier] ?? ''}
                      placeholder={current.defaultModel.trim() || 'default model'}
                      sourceNote={backend.modelTierSources[tier] ?? 'not set — falls back to the default model'}
                      options={options}
                      onChange={(value) => updateModel(backend.name, value, tier)}
                    />
                  ))}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="agent-actions">
          <Button disabled={!dirty || !canSelect} onClick={submit}>{saving ? 'Saving…' : 'Save'}</Button>
          {dirty ? <Button variant="ghost" size="sm" onClick={() => { adopt(settings); setSaved(false); setError(undefined); }}>Discard changes</Button> : null}
          {saved && !dirty ? <span role="status" className="small dim">Saved</span> : null}
        </div>
        {error === undefined ? null : <Alert variant="destructive">{error}</Alert>}
      </fieldset>
    </>
  );
}
