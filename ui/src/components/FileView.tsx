import { useState, type JSX } from 'react';

import { fetchFile, type FileSide, type JournalFileRef } from '../api';
import { fmtBytes } from '../format';

/**
 * Какой конец крупного файла показать первым.
 *
 * У лога смысл в хвосте: причина отказа — упор в лимит, таймаут, последняя
 * реплика перед обрывом — всегда в конце потока. У JSON-артефакта наоборот,
 * читают его сверху, да и разобрать в объект можно только целый файл.
 */
function defaultSide(name: string): FileSide {
  return name.endsWith('.json') ? 'head' : 'tail';
}

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
  const [shownSide, setShownSide] = useState<FileSide | undefined>(undefined);
  const [truncated, setTruncated] = useState<number | undefined>(undefined);

  const load = async (side: FileSide): Promise<void> => {
    setError(undefined);
    try {
      const content = await fetchFile(address, file.path, side);
      // JSON показывается разложенным: журнал пишется компактно, а читают его
      // глазами. Усечённый файл не разбирается — он заведомо оборван.
      let shown = content.content;
      if (file.name.endsWith('.json') && !content.truncated) {
        try {
          shown = JSON.stringify(JSON.parse(content.content), null, 2);
        } catch {
          // Недописанный на ходу файл остаётся как есть.
        }
      }
      setText(shown);
      setShownSide(content.side);
      setTruncated(content.truncated ? content.bytes : undefined);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (text !== undefined || error !== undefined) return;
    await load(defaultSide(file.name));
  };

  const flip = shownSide === 'head' ? 'tail' : 'head';

  return (
    <div>
      <button className="mono" onClick={() => void toggle()}>
        {file.name} · {fmtBytes(file.bytes)}
      </button>
      {open && error !== undefined ? <p className="error">{error}</p> : null}
      {/* Плашка над содержимым: читатель должен знать, какой это кусок, до
          того, как начнёт читать оборванный с одного края текст. */}
      {open && truncated !== undefined ? (
        <div className="truncated">
          показан {shownSide === 'head' ? 'первый' : 'последний'} 1 МБ из {fmtBytes(truncated)} —{' '}
          <button onClick={() => void load(flip)}>
            показать {flip === 'head' ? 'начало' : 'конец'}
          </button>
        </div>
      ) : null}
      {open && text !== undefined ? <pre>{text}</pre> : null}
    </div>
  );
}
