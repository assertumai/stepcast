import { useEffect, useState, type JSX } from 'react';

import { fetchSettings, saveSettings, type Settings as SettingsData } from '../api';

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

  const adopt = (data: SettingsData): void => {
    setSettings(data);
    setAgent(data.agent.value ?? '');
    setModel(data.model.value ?? '');
  };

  useEffect(() => {
    fetchSettings()
      .then(adopt)
      .catch((failure: Error) => setError(failure.message));
  }, []);

  if (error !== undefined && settings === undefined) return <p className="error">{error}</p>;
  if (settings === undefined) return <p className="empty">Загрузка…</p>;

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

  const enabled = settings.backends.filter((backend) => backend.enabled);
  const chosen = settings.backends.find((backend) => backend.name === agent);

  return (
    <>
      <h1>Настройки</h1>

      <div className="card">
        <div className="card-head">
          <span className="card-title">По умолчанию для всех проектов</span>
          <span className="mono small dim">{settings.file}</span>
        </div>

        <div className="field">
          <label className="label" htmlFor="settings-agent">
            агент
          </label>
          <div className="field-body">
            <select
              id="settings-agent"
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
            >
              {/* Пустой пункт нужен, только пока значения нет: выбрать «ничего»
                  нельзя — `defaults.agent` снятию не подлежит. */}
              {settings.agent.value === undefined ? <option value="">не задан</option> : null}
              {enabled.map((backend) => (
                <option key={backend.name} value={backend.name}>
                  {backend.name}
                </option>
              ))}
            </select>
            <span className="small dim">{settings.agent.source}</span>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="settings-model">
            модель
          </label>
          <div className="field-body">
            <input
              id="settings-model"
              className="mono"
              value={model}
              placeholder={chosen?.defaultModel ?? 'модель бэкенда'}
              onChange={(event) => setModel(event.target.value)}
            />
            <span className="small dim">
              {settings.model.value === undefined
                ? `пусто — берётся у бэкенда${chosen?.defaultModel === undefined ? '' : `: ${chosen.defaultModel}`}`
                : settings.model.source}
            </span>
          </div>
        </div>

        <div className="field">
          <span className="label" />
          <div className="field-body">
            <button disabled={!dirty || saving} onClick={submit}>
              {saving ? 'сохранение…' : 'сохранить'}
            </button>
            {dirty ? (
              <button
                className="plain"
                disabled={saving}
                onClick={() => {
                  adopt(settings);
                  setSaved(false);
                }}
              >
                отменить правку
              </button>
            ) : null}
            {saved && !dirty ? <span className="small dim">записано</span> : null}
          </div>
        </div>

        {error === undefined ? null : <p className="error">{error}</p>}
      </div>

      <h2 className="project">бэкенды</h2>
      <div className="card">
        {settings.backends.length === 0 ? (
          <p className="note dim">Бэкендов не объявлено.</p>
        ) : (
          settings.backends.map((backend) => (
            <div key={backend.name} className="job">
              <div className="job-head">
                <span className="job-name">{backend.name}</span>
                {backend.enabled ? null : <span className="badge">выключен</span>}
                {backend.name === settings.agent.value ? (
                  <span className="badge success">по умолчанию</span>
                ) : null}
              </div>
              <div className="ctx">$ {backend.command}</div>
              {backend.defaultModel === undefined ? null : (
                <div className="ctx">модель бэкенда: {backend.defaultModel}</div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
