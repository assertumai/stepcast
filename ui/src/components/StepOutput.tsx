import { useEffect, useRef, useState, type JSX } from 'react';

import { fetchStepOutput, type StepOutputStream } from '../api';
import { fmtBytes } from '../format';
import { mergeToolOutcomes, parseTranscript, type TranscriptEntry } from '../transcript';

/**
 * Показ вывода шага: разобранный ход агентского шага или два помеченных
 * потока командного, с живым дописыванием, пока окно раскрыто.
 *
 * Опрос по смещению, не поток событий (design.md, Решение 4): раз в секунду,
 * пока раскрыто и демон не назвал вывод завершённым (Решение 5). Крупный файл
 * приходит с конца (Решение 8); режем всегда с хвоста — в отличие от
 * `FileView`, здесь смысла показывать начало нет: причина того, что шаг
 * делает, всегда в последних строках.
 */

const POLL_MS = 1000;

interface RawStream {
  readonly text: string;
  readonly exists: boolean;
  readonly bytes: number;
  readonly truncatedFrom?: number;
}

const EMPTY_RAW: RawStream = { text: '', exists: false, bytes: 0 };

/** Дописать пришедший кусок потока; `restarted` — файл усечён или заменён, начинаем с него. */
function appendRaw(prev: RawStream, chunk: StepOutputStream | undefined): RawStream {
  if (chunk === undefined) return prev;
  const base = chunk.restarted ? EMPTY_RAW : prev;
  // Признак усечения приходит один раз — с тем куском, что отдан с конца.
  // Следующие куски обычные, и брать признак только из них значило бы снять
  // плашку через секунду после раскрытия, оставив текст обрезанным с начала:
  // читатель принял бы обрубок за полный вывод.
  const truncatedFrom = chunk.truncatedFrom ?? base.truncatedFrom;
  return {
    text: base.text + chunk.content,
    exists: chunk.exists,
    bytes: chunk.bytes,
    ...(truncatedFrom === undefined ? {} : { truncatedFrom }),
  };
}

/** Вход или исход вызова инструмента: сворачиваемый JSON, чтобы не занимать экран целиком. */
function ToolPayload({ label, value }: { readonly label: string; readonly value: unknown }): JSX.Element {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <details>
      <summary className="mono small">{label}</summary>
      <pre>{text}</pre>
    </details>
  );
}

function TranscriptEntryRow({ entry }: { readonly entry: TranscriptEntry }): JSX.Element {
  switch (entry.kind) {
    case 'session': {
      const model = entry.data.model;
      return (
        <div className="transcript-entry session">
          сессия начата{typeof model === 'string' ? ` · ${model}` : ''}
        </div>
      );
    }
    case 'reply':
      return (
        <div className={entry.thinking ? 'transcript-entry reply thinking' : 'transcript-entry reply'}>
          {entry.thinking ? <span className="kind">размышление</span> : null}
          <pre>{entry.text}</pre>
        </div>
      );
    case 'tool_call':
      return (
        <div className={entry.outcome?.isError === true ? 'transcript-entry tool-call error' : 'transcript-entry tool-call'}>
          <span className="tool-name mono">{entry.name}</span>
          <ToolPayload label="вход" value={entry.input} />
          {entry.outcome === undefined ? (
            <span className="kind dim">без исхода — оборвано</span>
          ) : (
            <ToolPayload
              label={entry.outcome.isError ? 'исход: ошибка' : 'исход'}
              value={entry.outcome.content}
            />
          )}
        </div>
      );
    case 'tool_result':
      return (
        <div className={entry.outcome.isError ? 'transcript-entry tool-result error' : 'transcript-entry tool-result'}>
          <span className="kind dim">исход без вызова</span>
          <ToolPayload label={entry.outcome.isError ? 'исход: ошибка' : 'исход'} value={entry.outcome.content} />
        </div>
      );
    case 'result':
      return <div className="transcript-entry result">{entry.text ?? ''}</div>;
    case 'raw':
      return <pre className="transcript-entry raw">{entry.line}</pre>;
  }
}

function TruncatedNote({ stream }: { readonly stream: RawStream }): JSX.Element | null {
  if (stream.truncatedFrom === undefined) return null;
  return (
    <div className="truncated">показан последний 1 МБ из {fmtBytes(stream.bytes)} — начало обрезано</div>
  );
}

function StreamBlock({ name, stream }: { readonly name: string; readonly stream: RawStream }): JSX.Element {
  return (
    <div className="stream-block">
      <div className="kind">{name}</div>
      <TruncatedNote stream={stream} />
      {!stream.exists ? (
        <p className="empty">файла нет</p>
      ) : stream.text === '' && stream.bytes === 0 ? (
        <p className="empty">{name} пуст</p>
      ) : (
        <pre>{stream.text}</pre>
      )}
    </div>
  );
}

export function StepOutput({
  address,
  jobId,
  stepId,
  kind,
}: {
  readonly address: string;
  readonly jobId: string;
  readonly stepId: string;
  readonly kind: 'agent' | 'run';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState<readonly number[]>([]);
  const [attempt, setAttempt] = useState<number | undefined>(undefined);
  const [done, setDone] = useState(false);

  const [entries, setEntries] = useState<readonly TranscriptEntry[]>([]);
  const [stdout, setStdout] = useState<RawStream>(EMPTY_RAW);
  const [stderr, setStderr] = useState<RawStream>(EMPTY_RAW);

  // Недописанная строка и смещения живут в ref, а не в состоянии: их читает
  // только следующий опрос, и перерисовка ради них не нужна.
  const carryRef = useRef('');
  const offsetsRef = useRef({ stdout: 0, stderr: 0 });

  // Поколение запроса: переключение попытки обесценивает всё, что уже ушло в
  // сеть. Без этой отметки ответ прежней попытки, пришедший после сброса,
  // дописал бы её текст к новой и увёл смещение вперёд — начало новой попытки
  // потерялось бы до перезагрузки страницы.
  const generationRef = useRef(0);

  const resetStreams = (): void => {
    generationRef.current += 1;
    carryRef.current = '';
    offsetsRef.current = { stdout: 0, stderr: 0 };
    setEntries([]);
    setStdout(EMPTY_RAW);
    setStderr(EMPTY_RAW);
  };

  const poll = async (targetAttempt: number | undefined): Promise<void> => {
    const generation = generationRef.current;
    try {
      const result = await fetchStepOutput({
        address,
        jobId,
        stepId,
        ...(targetAttempt === undefined ? {} : { attempt: targetAttempt }),
        stdoutOffset: offsetsRef.current.stdout,
        ...(kind === 'run' ? { stderrOffset: offsetsRef.current.stderr } : {}),
      });
      if (generationRef.current !== generation) return;

      setError(undefined);
      setLoaded(true);
      setAttempts(result.attempts);
      setDone(result.done);
      if (result.attempt !== undefined) setAttempt(result.attempt);

      if (result.stdout !== undefined) {
        offsetsRef.current.stdout = result.stdout.offset;
        setStdout((prev) => appendRaw(prev, result.stdout));
        if (kind === 'agent') {
          const restarted = result.stdout.restarted;
          const source = (restarted ? '' : carryRef.current) + result.stdout.content;
          const { entries: fresh, carry } = parseTranscript(source);
          carryRef.current = carry;
          setEntries((prev) => mergeToolOutcomes([...(restarted ? [] : prev), ...fresh]));
        }
      }
      if (kind === 'run' && result.stderr !== undefined) {
        offsetsRef.current.stderr = result.stderr.offset;
        setStderr((prev) => appendRaw(prev, result.stderr));
      }
    } catch (failure) {
      if (generationRef.current !== generation) return;
      setError((failure as Error).message);
    }
  };

  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!loaded) await poll(undefined);
  };

  const switchAttempt = async (next: number): Promise<void> => {
    resetStreams();
    setAttempt(next);
    await poll(next);
  };

  // Опрос идёт, пока окно раскрыто и демон не назвал вывод завершённым;
  // сворачивание, размонтирование и признак завершённости снимают его.
  // Таймер перевзводит себя сам — тот же приём, что `follow()` в
  // `journal/reader.ts`, — а не `setInterval`: следующий опрос не должен
  // стартовать раньше, чем получен ответ на предыдущий.
  useEffect(() => {
    if (!open || done) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      void poll(attempt).finally(() => {
        if (alive) timer = setTimeout(tick, POLL_MS);
      });
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, done, attempt, address, jobId, stepId, kind]);

  return (
    <div className="step-output">
      <button className="mono" onClick={() => void toggle()}>
        вывод шага {open ? '▾' : '▸'}
      </button>
      {!open ? null : (
        <div className="step-output-body">
          {attempts.length > 1 ? (
            <div className="attempts">
              {attempts.map((value) => (
                <button
                  key={value}
                  className={value === attempt ? 'active' : undefined}
                  disabled={value === attempt}
                  onClick={() => void switchAttempt(value)}
                >
                  попытка {value}
                </button>
              ))}
            </div>
          ) : null}

          {error !== undefined ? <p className="error">{error}</p> : null}
          {error === undefined && !loaded ? <p className="empty">Загрузка…</p> : null}
          {/*
            Пустой перечень попыток — каталога шага ещё нет. Но `stdout.log`
            заводится в первый же миг шага, и у только что стартовавшего
            агентского шага попытка уже есть, а разобранных записей ещё нет:
            без второго условия раскрытое окно показывало бы пустоту без
            единого слова — самый частый вид «шага, ещё ничего не написавшего».
          */}
          {error === undefined &&
          loaded &&
          (attempts.length === 0 || (kind === 'agent' && entries.length === 0)) ? (
            <p className="empty">Вывода пока нет.</p>
          ) : null}

          {loaded && entries.length > 0 && kind === 'agent' ? (
            <div className="transcript">
              <TruncatedNote stream={stdout} />
              {entries.map((entry, index) => (
                // Ключ по индексу: записи не несут собственного идентификатора,
                // а порядок в разобранном ходе не меняется задним числом.
                <TranscriptEntryRow key={index} entry={entry} />
              ))}
            </div>
          ) : null}

          {loaded && attempts.length > 0 && kind === 'run' ? (
            <>
              <StreamBlock name="stdout" stream={stdout} />
              <StreamBlock name="stderr" stream={stderr} />
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
