import { useEffect, useState, type JSX } from 'react';

import { MODEL_TIERS, type ModelTier, type ModelTierSelection } from '../../../src/parts/pipeline/config/modelTiers';
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
  Input,
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

export type TierDraft = { model: string; effort: string };
export type AgentDraft = { defaultModel: string; modelTiers: Record<ModelTier, TierDraft> };

const TIER_NAME = /^[a-z][a-z0-9_-]*$/;

export function orderedTierNames(names: readonly string[]): readonly string[] {
  const custom = [...new Set(names.filter((name) => !(MODEL_TIERS as readonly string[]).includes(name)))].sort(
    (left, right) => left.localeCompare(right),
  );
  return [...MODEL_TIERS, ...custom];
}

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
    ...(option.label === undefined ? {} : { label: option.label }),
    ...(
      option.title === undefined && option.defaultEffort === undefined
        ? {}
        : {
            description: [option.title, option.defaultEffort === undefined ? undefined : `default effort: ${option.defaultEffort}`]
              .filter((part): part is string => part !== undefined)
              .join(' · '),
          }
    ),
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

export function effortOptions(
  listed: readonly ModelOption[],
  model: string,
  configured: string | undefined,
): readonly ComboboxOption[] {
  const selected = listed.find((option) => option.name === model.trim());
  const options: ComboboxOption[] = (selected?.efforts ?? []).map((effort) => ({
    value: effort.name,
    ...(effort.description === undefined ? {} : { description: effort.description }),
  }));
  const current = configured?.trim() ?? '';
  if (current !== '' && !options.some((option) => option.value === current)) {
    options.push({ value: current, description: 'from configuration' });
  }
  return options;
}

export function tierSelectionPatch(
  original: ModelTierSelection | undefined,
  draft: TierDraft,
): { readonly model: string | null; readonly effort?: string | null } | undefined {
  const model = draft.model.trim();
  const effort = draft.effort.trim();
  if (model === '') return original === undefined ? undefined : { model: null };
  if (model === original?.model && effort === (original.effort ?? '')) return undefined;
  return { model, effort: effort || null };
}

export function tierDraftProblem(
  tierNames: readonly string[],
  originalTierNames: readonly string[],
  draft: Readonly<Record<string, AgentDraft>>,
): string | undefined {
  for (const tier of tierNames) {
    for (const agent of Object.values(draft)) {
      const selection = agent.modelTiers[tier];
      if (selection !== undefined && selection.model.trim() === '' && selection.effort.trim() !== '') {
        return `Tier ${tier} needs a model before effort can be set`;
      }
    }
    if (!originalTierNames.includes(tier) && !Object.values(draft).some((agent) => agent.modelTiers[tier]?.model.trim())) {
      return `New tier ${tier} needs a model for at least one agent`;
    }
  }
  return undefined;
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
  const [effort, setEffort] = useState('');
  const [tierNames, setTierNames] = useState<readonly string[]>(MODEL_TIERS);
  const [removedTiers, setRemovedTiers] = useState<readonly string[]>([]);
  const [newTier, setNewTier] = useState('');
  const [tierError, setTierError] = useState<string>();
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
    setEffort(data.effort.value ?? '');
    setTierNames(orderedTierNames(data.modelTiers));
    setRemovedTiers([]);
    setNewTier('');
    setTierError(undefined);
    setDraft(Object.fromEntries(data.backends.map((backend) => [backend.name, {
      defaultModel: backend.defaultModel ?? '',
      modelTiers: Object.fromEntries(orderedTierNames(data.modelTiers).map((tier) => {
        const selection = backend.modelTiers[tier];
        return [tier, { model: selection?.model ?? '', effort: selection?.effort ?? '' }];
      })),
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
      const modelTiers = Object.fromEntries(tierNames.flatMap((tier) => {
        const change = tierSelectionPatch(backend.modelTiers[tier], next.modelTiers[tier] ?? { model: '', effort: '' });
        return change === undefined ? [] : [[tier, change]];
      }));
      const defaultChanged = next.defaultModel.trim() !== (backend.defaultModel ?? '');
      if (!defaultChanged && Object.keys(modelTiers).length === 0) return [];
      return [[backend.name, {
        ...(defaultChanged ? { defaultModel: next.defaultModel.trim() || null } : {}),
        ...(Object.keys(modelTiers).length === 0 ? {} : { modelTiers }),
      }]];
    }),
  );
  const effortChanged = effort.trim() !== (settings.effort.value ?? '');
  const addedTiers = tierNames.filter((tier) => !settings.modelTiers.includes(tier));
  const dirty = agent !== settings.agent.value || effortChanged || connectCodex || removedTiers.length > 0 ||
    addedTiers.length > 0 || Object.keys(backendPatch).length > 0;
  const selected = settings.backends.find((backend) => backend.name === agent);
  const canSelect = selected?.enabled && (selected.available || (agent === 'codex' && connectCodex));
  const draftProblem = tierDraftProblem(tierNames, settings.modelTiers, draft);
  const selectedDiscovery = models?.backends[agent];
  const selectedModels = selectedDiscovery?.status === 'ok' ? selectedDiscovery.models : [];
  const selectedModel = settings.model.value ?? draft[agent]?.defaultModel ?? selected?.defaultModel ?? '';
  const selectedModelDefaultEffort = selectedModels.find((option) => option.name === selectedModel)?.defaultEffort;
  const globalEffortOptions = effortOptions(selectedModels, selectedModel, effort);

  const updateModel = (name: string, value: string, tier?: ModelTier, field: keyof TierDraft = 'model'): void => {
    setSaved(false);
    setDraft((previous) => {
      const current = previous[name]!;
      return { ...previous, [name]: tier === undefined
        ? { ...current, defaultModel: value }
        : {
            ...current,
            modelTiers: {
              ...current.modelTiers,
              [tier]: { ...(current.modelTiers[tier] ?? { model: '', effort: '' }), [field]: value },
            },
          } };
    });
  };

  const addTier = (): void => {
    const name = newTier.trim();
    if (!TIER_NAME.test(name)) {
      setTierError('Use lowercase letters, digits, hyphens or underscores; start with a letter.');
      return;
    }
    if (tierNames.includes(name)) {
      setTierError(`Tier ${name} already exists.`);
      return;
    }
    setTierNames(orderedTierNames([...tierNames, name]));
    setRemovedTiers((current) => current.filter((tier) => tier !== name));
    setDraft((previous) => Object.fromEntries(Object.entries(previous).map(([backend, value]) => [backend, {
      ...value,
      modelTiers: { ...value.modelTiers, [name]: value.modelTiers[name] ?? { model: '', effort: '' } },
    }])));
    setNewTier('');
    setTierError(undefined);
    setSaved(false);
  };

  const removeTier = (tier: string): void => {
    setTierNames((current) => current.filter((name) => name !== tier));
    if (settings.modelTiers.includes(tier)) {
      setRemovedTiers((current) => [...new Set([...current, tier])]);
    }
    setSaved(false);
  };

  const submit = (): void => {
    setSaving(true);
    setSaved(false);
    setError(undefined);
    saveSettings({
      ...(agent === settings.agent.value ? {} : { agent }),
      ...(effortChanged ? { effort: effort.trim() || null } : {}),
      ...(connectCodex ? { connectCodex: true } : {}),
      ...(removedTiers.length === 0 ? {} : { removeModelTiers: removedTiers }),
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
            <ModelField
              id="default-effort"
              label="effort"
              value={effort}
              placeholder={selectedModelDefaultEffort === undefined ? 'model default' : `model default: ${selectedModelDefaultEffort}`}
              sourceNote={`${settings.effort.source}. An empty field lets the selected model and CLI choose.`}
              options={globalEffortOptions}
              onChange={(value) => { setEffort(value); setSaved(false); }}
            />
          </CardContent>
        </Card>

        {settings.model.value === undefined ? null : (
          <Alert variant="warning">
            A global <code>model</code> override <span className="mono">{settings.model.value}</span> ({settings.model.source}) takes
            precedence over tiers and per-agent models. Remove it on the <a href="/settings">Settings</a> page.
          </Alert>
        )}

        <p className="small dim agent-note">
          <code>agent</code>, <code>model</code>, <code>effort</code> and <code>model_tier</code> are inherited independently: step → job → pipeline → settings.
          A tier selects its model and optional effort together. An explicit <code>model</code> disconnects the tier effort; an explicit <code>effort</code> wins.
          The dropdown lists what the agent’s CLI reports and is not exhaustive — a typed name is saved as is.
          Lists are read once and kept while the daemon runs; after installing an agent or changing its command, reload them.
        </p>

        <Card className="tier-manager">
          <CardHeader>
            <CardTitle>Shared tiers</CardTitle>
            <CardDescription>
              One ordered set is shown for every agent. A custom tier may be mapped for only the agents that need it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="tier-list">
              {tierNames.map((tier) => (
                <span className="tier-chip" key={tier}>
                  <Badge variant={(MODEL_TIERS as readonly string[]).includes(tier) ? 'secondary' : 'default'}>{tier}</Badge>
                  {(MODEL_TIERS as readonly string[]).includes(tier) ? null : (
                    <Button variant="ghost" size="sm" onClick={() => removeTier(tier)} aria-label={`Remove tier ${tier}`}>Remove</Button>
                  )}
                </span>
              ))}
            </div>
            <div className="tier-add">
              <Input
                value={newTier}
                placeholder="review"
                aria-label="New tier name"
                onChange={(event) => { setNewTier(event.target.value); setTierError(undefined); }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addTier(); } }}
              />
              <Button type="button" variant="outline" onClick={addTier}>Add tier</Button>
            </div>
            {tierError === undefined ? null : <span className="small tier-error">{tierError}</span>}
          </CardContent>
        </Card>

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
              ...tierNames.map((tier) => backend.modelTiers[tier]?.model),
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
                  {tierNames.map((tier) => {
                    const selection = current.modelTiers[tier] ?? { model: '', effort: '' };
                    const listedModel = listed.find((option) => option.name === selection.model.trim());
                    return (
                      <div className="tier-config" key={tier}>
                        <ModelField
                          id={`agent-${backend.name}-${tier}-model`}
                          label={`${tier} model`}
                          value={selection.model}
                          placeholder={current.defaultModel.trim() || 'default model'}
                          sourceNote={backend.modelTierSources[tier] ?? 'not set — falls back to the default model'}
                          options={options}
                          onChange={(value) => updateModel(backend.name, value, tier, 'model')}
                        />
                        <ModelField
                          id={`agent-${backend.name}-${tier}-effort`}
                          label="effort"
                          value={selection.effort}
                          placeholder={listedModel?.defaultEffort === undefined ? 'model default' : `model default: ${listedModel.defaultEffort}`}
                          sourceNote={backend.modelTierEffortSources[tier] ?? 'not set — the selected model chooses its default'}
                          options={effortOptions(listed, selection.model, selection.effort)}
                          onChange={(value) => updateModel(backend.name, value, tier, 'effort')}
                        />
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="agent-actions">
          <Button disabled={!dirty || !canSelect || draftProblem !== undefined} onClick={submit}>{saving ? 'Saving…' : 'Save'}</Button>
          {dirty ? <Button variant="ghost" size="sm" onClick={() => { adopt(settings); setSaved(false); setError(undefined); }}>Discard changes</Button> : null}
          {saved && !dirty ? <span role="status" className="small dim">Saved</span> : null}
        </div>
        {draftProblem === undefined ? null : <Alert variant="warning">{draftProblem}</Alert>}
        {error === undefined ? null : <Alert variant="destructive">{error}</Alert>}
      </fieldset>
    </>
  );
}
