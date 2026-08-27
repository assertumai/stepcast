import { useState, type JSX } from 'react';

import { fetchFile, type JournalFileRef } from '../api';
import { fmtBytes } from '../format';

/**
 * Файл журнала, раскрываемый на месте.
 *
 * Содержимое запрашивается по клику, а не заранее: в прогоне сотни файлов, и
 * тянуть их все ради того, что пользователь откроет один, значит платить
 * трафиком за неоткрытое.
 */
export function FileView({
  address,
  file,
}: {
  readonly address: string;
  readonly file: JournalFileRef;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [truncated, setTruncated] = useState<number | undefined>(undefined);

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (text !== undefined || error !== undefined) return;

    try {
      const content = await fetchFile(address, file.path);
      // JSON показывается разложенным: журнал пишется компактно, а читают его
      // глазами.
      let shown = content.content;
      if (file.name.endsWith('.json')) {
        try {
          shown = JSON.stringify(JSON.parse(content.content), null, 2);
        } catch {
          // Недописанный на ходу файл остаётся как есть.
        }
      }
      setText(shown);
      if (content.truncated) setTruncated(content.bytes);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <div>
      <button className="mono" onClick={() => void toggle()}>
        {file.name} · {fmtBytes(file.bytes)}
      </button>
      {open && error !== undefined ? <p className="error">{error}</p> : null}
      {open && text !== undefined ? <pre>{text}</pre> : null}
      {open && truncated !== undefined ? (
        <div className="truncated">файл усечён до 1 МБ из {fmtBytes(truncated)}</div>
      ) : null}
    </div>
  );
}
