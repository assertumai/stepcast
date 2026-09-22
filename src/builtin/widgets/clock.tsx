import { useEffect, useState } from 'react';
import { Button } from '@stepcast/ui';

/**
 * A ticking clock with a pause button — the smallest widget that shows state,
 * effects and a click reacting on the page.
 *
 * Хук держит состояние, эффект тикает раз в секунду, кнопка даёт видимую
 * реакцию — тот самый файл, на котором проверяется замена на лету
 * (docs/widgets.md): поправьте текст кнопки, и карточка обновится без
 * перезагрузки страницы.
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
    <div style={{ display: 'flex', alignItems: 'center', gap: '.8rem' }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: '1.4rem' }}>{now.toLocaleTimeString()}</span>
      <Button variant="outline" size="sm" onClick={() => setTicking((value) => !value)}>
        {ticking ? 'Pause' : 'Resume'}
      </Button>
    </div>
  );
}
