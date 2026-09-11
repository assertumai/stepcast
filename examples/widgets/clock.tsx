import { useEffect, useState } from 'react';

/**
 * Виджет-образец спайка `ui-runtime-widget-spike`: хук держит состояние,
 * эффект тикает раз в секунду, кнопка даёт видимую реакцию на действие —
 * тот самый файл, на котором проверяется замена на лету (docs/widgets.md).
 *
 * Скопируйте его в `<проект>/.stepcast/widgets/clock.tsx`, откройте экран
 * «Виджеты» и поправьте текст кнопки или цвет — карточка обновится без
 * перезагрузки страницы и без перезапуска демона.
 */
export default function Clock() {
  const [now, setNow] = useState(() => new Date());
  const [ticking, setTicking] = useState(true);

  useEffect(() => {
    if (!ticking) return undefined;
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  return (
    <div>
      <p>{now.toLocaleTimeString()}</p>
      <button onClick={() => setTicking((value) => !value)}>{ticking ? 'Пауза' : 'Пуск'}</button>
    </div>
  );
}
