import { useEffect, useState, type JSX } from 'react';

import { MODEL_TIERS, type ModelTier } from '../../../src/core/config/modelTiers';
import { fetchSettings, saveSettings, type Settings, type SettingsPatch } from '../api';

type AgentDraft = { defaultModel: string; modelTiers: Partial<Record<ModelTier, string>> };

/** Глобальные модели агентов; отправляются только изменённые поля. */
export function Agents(): JSX.Element {
  const [settings, setSettings] = useState<Settings>();
  const [draft, setDraft] = useState<Record<string, AgentDraft>>({});
  const [agent, setAgent] = useState('');
  const [connectCodex, setConnectCodex] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

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
        </p>

        <div className="agent-cards">
          {settings.backends.map((backend) => (
            <section className="card" key={backend.name}>
              <div className="card-head">
                <h2 className="card-title">{backend.name}</h2>
                <span className="small dim mono">{backend.command}</span>
                {!backend.available ? <span className="badge">плагин не подключён</span> : !backend.enabled ? <span className="badge">выключен</span> : null}
              </div>
              <div className="field">
                <label className="label" htmlFor={`agent-${backend.name}-model`}>модель по умолчанию</label>
                <div className="field-body">
                  <input id={`agent-${backend.name}-model`} className="mono" value={draft[backend.name]!.defaultModel}
                    placeholder="встроенная модель агента" onChange={(event) => updateModel(backend.name, event.target.value)} />
                  <span className="small dim">{backend.defaultModelSource}. Пустое поле снимает переопределение.</span>
                </div>
              </div>
              {MODEL_TIERS.map((tier) => (
                <div className="field" key={tier}>
                  <label className="label mono" htmlFor={`agent-${backend.name}-${tier}`}>{tier}</label>
                  <div className="field-body">
                    <input id={`agent-${backend.name}-${tier}`} className="mono" value={draft[backend.name]!.modelTiers[tier] ?? ''}
                      placeholder={draft[backend.name]!.defaultModel.trim() || 'модель по умолчанию'}
                      onChange={(event) => updateModel(backend.name, event.target.value, tier)} />
                    <span className="small dim">{backend.modelTierSources[tier] ?? 'не задан — модель агента по умолчанию'}</span>
                  </div>
                </div>
              ))}
            </section>
          ))}
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
