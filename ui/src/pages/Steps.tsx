import { useEffect, useState, type JSX } from 'react';

import { fetchSteps, type ProjectStepsView, type StepCatalogEntry } from '../api';

/**
 * Каталог переиспользуемых шагов — отдельный экран, а не секция экрана
 * пайплайнов (design.md изменения reusable-steps, решение 13): список шагов
 * читают, когда пайплайна ещё нет, и искать его внутри «Пайплайнов» пришлось
 * бы именно тогда, когда его там меньше всего ждут.
 *
 * Перекрытый одноимённый шаг нижнего слоя показан, а не пропущен: перекрытие
 * — самая дорогая неожиданность трёхслойного разрешения, и это единственное
 * место, где её видно.
 */

const LAYER_LABEL: Record<StepCatalogEntry['layer'], string> = {
  project: 'проект',
  home: 'домашний каталог',
  builtin: 'встроенный',
};

function ParamRow({ param }: { readonly param: StepCatalogEntry['params'][number] }): JSX.Element {
  return (
    <li className="ctx">
      <span className="mono">{param.name}</span>
      {param.type === undefined ? '' : ` : ${param.type}`}
      {param.required ? <span className="badge">обязателен</span> : null}
      {param.default === undefined ? null : (
        <span className="dim"> умолчание: {JSON.stringify(param.default)}</span>
      )}
      {param.description === undefined ? null : <div className="dim">{param.description}</div>}
    </li>
  );
}

function StepCard({ step }: { readonly step: StepCatalogEntry }): JSX.Element {
  return (
    <div className="step">
      <div className="step-head">
        <span className="job-name">{step.name}</span>
        <span className="kind">{LAYER_LABEL[step.layer]}</span>
        {step.overridden ? <span className="badge">перекрыт</span> : null}
        {step.hasOutputSchema ? <span className="kind dim">есть output_schema</span> : null}
      </div>
      {step.description === undefined ? null : <div className="desc">{step.description}</div>}
      {step.error === undefined ? null : (
        <p role="alert" className="error">
          {step.error} — {step.manifestPath}
        </p>
      )}
      {step.params.length === 0 ? (
        step.error === undefined ? <div className="ctx dim">параметров нет</div> : null
      ) : (
        <ul className="ctx-list">
          {step.params.map((param) => (
            <ParamRow key={param.name} param={param} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectSteps({ project }: { readonly project: ProjectStepsView }): JSX.Element {
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{project.projectPath}</h2>
      </div>
      {project.steps.length === 0 ? (
        <p className="empty">Шагов нет</p>
      ) : (
        project.steps.map((step) => <StepCard key={`${step.layer}/${step.name}`} step={step} />)
      )}
    </section>
  );
}

export function Steps(): JSX.Element {
  const [overview, setOverview] = useState<{ readonly projects: readonly ProjectStepsView[] }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchSteps().then(setOverview).catch((failure: Error) => setError(failure.message));
  }, []);

  if (overview === undefined) return <p className={error ? 'error' : 'empty'}>{error ?? 'Загрузка…'}</p>;
  if (overview.projects.length === 0) return <p className="empty">Проектов не найдено</p>;

  return (
    <>
      <h1>Шаги</h1>
      <p className="note dim">
        Переиспользуемые шаги, доступные каждому проекту, — каталог с манифестом `step.yml`, найденный
        тремя слоями: проектным, домашним и встроенным в пакет.
      </p>
      {overview.projects.map((project) => (
        <ProjectSteps key={project.projectKey} project={project} />
      ))}
    </>
  );
}
