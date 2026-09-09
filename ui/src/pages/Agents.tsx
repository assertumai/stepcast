import { useEffect, useState, type JSX } from 'react';

import { MODEL_TIERS, type ModelTier } from '../../../src/core/config/modelTiers';
import {
  fetchModels, fetchSettings, saveSettings,
  type ModelOption, type ModelsForBackend, type ModelsResult, type Settings, type SettingsPatch,
} from '../api';

type AgentDraft = { defaultModel: string; modelTiers: Partial<Record<ModelTier, string>> };

/**
 * Причина недоступности распознавания — словами, как её видит пользователь.
 *
 * Текст CLI и текст исключения идут при подписи, а не голыми: без неё
 * непонятно, чей это текст и о чём он, а CLI, отказавший молча (ненулевой код
 * без единого байта вывода), оставил бы в карточке пустую строку — ни списка,
 * ни причины, ни следа того, что проба вообще была.
 */
function unavailableReason(result: ModelsForBackend): string | undefined {
  switch (result.status) {
    case 'ok': return undefined;
    case 'unsupported': return 'этот агент перечислять модели не умеет';
    case 'not_installed': return `команда «${result.command}» не найдена`;
    case 'timeout': return 'агент не ответил за отпущенное время';
    case 'failed': return withText('агент ответил отказом', result.message, 'и ничего не сказал');
    case 'unparsed': return 'ответ агента не разобран';
    case 'probe_error': return withText('перечисление сорвалось', result.message, 'без объяснения');
  }
}

/** Подпись причины и текст, который прислал не браузер: пустой текст не оставляет подпись голой. */
function withText(label: string, text: string, whenEmpty: string): string {
  const trimmed = text.trim();
  return trimmed === '' ? `${label} ${whenEmpty}` : `${label}: ${trimmed}`;
}

/** Копирует имя модели в буфер обмена; отказ и успех сообщаются рядом с кнопкой, а не проглатываются. */
function CopyButton({ value }: { readonly value: string }): JSX.Element {
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');

  // Ответ кнопки относится к тому значению, которое копировали: стоит поле
  // поправить — и «скопировано» утверждало бы про буфер обмена то, что
  // перестало быть правдой.
  useEffect(() => setState('idle'), [value]);

  const copy = (): void => {
    // `navigator.clipboard` в незащищённом контексте и под запретом
    // Permissions-Policy отсутствует вовсе: обращение к `writeText` бросает
    // синхронно, и `.catch` такого отказа не увидел бы — он ушёл бы мимо
    // страницы, оставив пользователя без ответа кнопки.
    try {
      const clipboard: Clipboard | undefined = navigator.clipboard;
      if (clipboard === undefined) {
        setState('error');
        return;
      }
      clipboard.writeText(value).then(() => setState('ok'), () => setState('error'));
    } catch {
      setState('error');
    }
  };

  return (
    <span className="model-copy">
      <button type="button" className="plain" onClick={copy} disabled={value === ''} title="скопировать имя модели">
        копировать
      </button>
      {state === 'ok' ? <span className="small dim" role="status">скопировано</span> : null}
      {state === 'error' ? <span className="small error" role="alert">буфер обмена недоступен — выделите значение и скопируйте вручную</span> : null}
    </span>
  );
}

interface ModelFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly sourceNote: string;
  readonly options: readonly ModelOption[];
  readonly listId: string;
  readonly onChange: (value: string) => void;
}

/**
 * Поле модели — свободный ввод со списком-подсказкой (`<datalist>`), а не
 * `<select>`: список неполон по устройству (design.md, решение 4), и
 * запирать в нём выбор значило бы сделать распознавание хуже свободного
 * ввода (решение 8). Сохранённое значение вне списка остаётся выбранным —
 * `<input>` его не теряет — и помечается отдельной строкой, отличимой от
 * ошибки.
 *
 * Сам `<datalist>` живёт в карточке, а не здесь: он один на агента, и шесть
 * его копий с одним `id` были бы невалидным DOM — браузер брал бы первую
 * попавшуюся, а обращение по `id` из теста или стиля попадало бы в случайную.
 */
function ModelField({ id, label, value, placeholder, sourceNote, options, listId, onChange }: ModelFieldProps): JSX.Element {
  const trimmed = value.trim();
  const offList = trimmed !== '' && options.length > 0 && !options.some((option) => option.name === trimmed);

  return (
    <div className="field" key={id}>
      <label className="label mono" htmlFor={id}>{label}</label>
      <div className="field-body">
        <div className="model-input">
          <input id={id} className="mono" list={listId} value={value} placeholder={placeholder}
            onChange={(event) => onChange(event.target.value)} />
          <CopyButton value={trimmed} />
        </div>
        <span className="small dim">{sourceNote}</span>
        {offList ? <span className="badge">вне списка распознанных моделей</span> : null}
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

  if (settings === undefined) return <p className={error ? 'error' : 'empty'}>{error ?? 'Загрузка…'}</p>;

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

  return (
    <>
      <h1>Агенты</h1>
      <p className="note dim">
        Модели по умолчанию для всех проектов. Настройки проекта могут переопределить эти значения.
        Файл: <span className="mono">{settings.file}</span>
      </p>
      <fieldset className="agent-settings" disabled={saving}>
        <div className="card">
          <div className="field">
            <label className="label" htmlFor="default-agent">агент по умолчанию</label>
            <div className="field-body">
              <select id="default-agent" value={agent} onChange={(event) => { setAgent(event.target.value); setSaved(false); }}>
                {settings.backends.map((backend) => (
                  <option key={backend.name} value={backend.name}
                    disabled={!backend.enabled || (!backend.available && !(backend.name === 'codex' && connectCodex))}>
                    {backend.name}{!backend.available ? ' — плагин не подключён' : !backend.enabled ? ' — выключен' : ''}
                  </option>
                ))}
              </select>
              <span className="small dim">Используется, если agent не задан в pipeline, job или step. {settings.agent.source}</span>
            </div>
          </div>
          {settings.backends.some((backend) => backend.name === 'codex' && !backend.available) ? (
            <div className="field">
              <span className="label" />
              <div className="field-body">
                <label className="check"><input type="checkbox" checked={connectCodex} onChange={(event) => { setConnectCodex(event.target.checked); setSaved(false); }} /> подключить Codex</label>
                <span className="small dim">Добавит плагин из поставки Stepcast. Для запуска нужен установленный и авторизованный Codex CLI.</span>
              </div>
            </div>
          ) : null}
        </div>

        {settings.model.value === undefined ? null : (
          <p className="note">
            Общее переопределение model: <span className="mono">{settings.model.value}</span> ({settings.model.source}) имеет приоритет над tier и моделями агентов.
            Его можно снять на странице <a href="/settings">«Настройки»</a>.
          </p>
        )}

        <p className="note dim">
          Поля agent, model и model_tier наследуются независимо: step → job → pipeline → настройки.
          Явная model побеждает model_tier. Для незаполненного tier используется модель агента по умолчанию.
          Список моделей у каждого поля — подсказка от CLI агента, а не перечень допустимого: имя вне списка
          сохраняется как есть.
        </p>

        <p className="note dim model-refresh">
          Списки распознаются один раз и держатся, пока демон жив. Установили агента, поправили команду или
          авторизовались — <button type="button" className="plain" onClick={() => loadModels(true)} disabled={modelsBusy}>
            {modelsBusy ? 'перечисление…' : 'перечислить заново'}
          </button>.
        </p>

        <div className="agent-cards">
          {settings.backends.map((backend) => {
            const discovery = models?.backends[backend.name];
            const reason = discovery === undefined
              ? (modelsError ?? 'список распознаётся…')
              : unavailableReason(discovery);
            const options: readonly ModelOption[] = discovery?.status === 'ok' ? discovery.models : [];
            const listId = `agent-${backend.name}-models`;

            return (
              <section className="card" key={backend.name}>
                <div className="card-head">
                  <h2 className="card-title">{backend.name}</h2>
                  <span className="small dim mono">{backend.command}</span>
                  {!backend.available ? <span className="badge">плагин не подключён</span> : !backend.enabled ? <span className="badge">выключен</span> : null}
                </div>
                {reason === undefined ? null : <p className="small dim">{reason}</p>}
                <datalist id={listId}>
                  {options.map((option) => <option key={option.name} value={option.name}>{option.title}</option>)}
                </datalist>
                <ModelField
                  id={`agent-${backend.name}-model`}
                  label="модель по умолчанию"
                  value={draft[backend.name]!.defaultModel}
                  placeholder="встроенная модель агента"
                  sourceNote={`${backend.defaultModelSource}. Пустое поле снимает переопределение.`}
                  options={options}
                  listId={listId}
                  onChange={(value) => updateModel(backend.name, value)}
                />
                {MODEL_TIERS.map((tier) => (
                  <ModelField
                    key={tier}
                    id={`agent-${backend.name}-${tier}`}
                    label={tier}
                    value={draft[backend.name]!.modelTiers[tier] ?? ''}
                    placeholder={draft[backend.name]!.defaultModel.trim() || 'модель по умолчанию'}
                    sourceNote={backend.modelTierSources[tier] ?? 'не задан — модель агента по умолчанию'}
                    options={options}
                    listId={listId}
                    onChange={(value) => updateModel(backend.name, value, tier)}
                  />
                ))}
              </section>
            );
          })}
        </div>

        <div className="agent-actions">
          <button disabled={!dirty || !canSelect} onClick={submit}>{saving ? 'сохранение…' : 'сохранить'}</button>
          {dirty ? <button className="plain" onClick={() => { adopt(settings); setSaved(false); setError(undefined); }}>отменить правку</button> : null}
          {saved && !dirty ? <span role="status" className="small dim">записано</span> : null}
          {error === undefined ? null : <p role="alert" className="error">{error}</p>}
        </div>
      </fieldset>
    </>
  );
}
