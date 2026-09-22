import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';

import { cn } from './utils';
import './combobox.css';

export interface ComboboxOption {
  readonly value: string;
  readonly label?: string;
  readonly description?: string;
}

export interface ComboboxProps {
  readonly id?: string;
  readonly value: string;
  readonly options: readonly ComboboxOption[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  /**
   * Свободный ввод: набранный текст, которого нет в списке, — тоже значение
   * и уходит в `onChange` на каждом нажатии. Без него поле только ищет по
   * списку, а значением становится лишь выбранный пункт.
   */
  readonly allowCustom?: boolean;
  readonly emptyText?: string;
  readonly disabled?: boolean;
  readonly className?: string;
  /** Моноширинный ввод — имена моделей и идентификаторы. */
  readonly mono?: boolean;
}

function labelOf(options: readonly ComboboxOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

function matches(option: ComboboxOption, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return (
    option.value.toLowerCase().includes(needle) ||
    (option.label ?? '').toLowerCase().includes(needle) ||
    (option.description ?? '').toLowerCase().includes(needle)
  );
}

/**
 * Поле с выпадающим списком и поиском по нему — без примитива Radix: список
 * рисуется под полем абсолютным блоком, а клавиатура (стрелки, Enter,
 * Escape) и роли ARIA (`combobox`, `listbox`, `option`) — свои.
 *
 * Два режима. `allowCustom` — как `<input list>`: значение и есть текст поля,
 * список лишь подсказывает; пункт «custom» показывает, что набранного в
 * списке нет, и это состояние, а не ошибка (модели агентов: перечень CLI
 * заведомо неполон). Без `allowCustom` — как `<select>` с поиском: в поле
 * видна подпись выбранного, набор фильтрует, выбор делает пункт.
 */
export function Combobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  allowCustom = false,
  emptyText = 'Nothing found',
  disabled = false,
  className,
  mono = false,
}: ComboboxProps): JSX.Element {
  const generatedId = useId();
  const inputId = id ?? `combobox-${generatedId}`;
  const listId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const text = allowCustom ? value : (query ?? labelOf(options, value));
  const filterQuery = allowCustom ? value : (query ?? '');
  const filtered = useMemo(() => options.filter((option) => matches(option, filterQuery)), [options, filterQuery]);
  const customRow = allowCustom && value.trim() !== '' && !options.some((option) => option.value === value.trim());

  useEffect(() => {
    if (highlight >= filtered.length) setHighlight(filtered.length === 0 ? 0 : filtered.length - 1);
  }, [filtered.length, highlight]);

  // Закрытие по клику мимо поля — на документе, а не по `blur` поля: клик по
  // пункту списка уводит фокус раньше, чем срабатывает `click`, и список
  // исчезал бы под курсором.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  });

  const close = (): void => {
    setOpen(false);
    setQuery(undefined);
  };

  const select = (option: ComboboxOption): void => {
    onChange(option.value);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!open) setOpen(true);
        else setHighlight((current) => Math.min(current + 1, Math.max(filtered.length - 1, 0)));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (open) setHighlight((current) => Math.max(current - 1, 0));
        break;
      case 'Enter': {
        if (!open) return;
        event.preventDefault();
        const option = filtered[highlight];
        if (option !== undefined) select(option);
        else if (allowCustom) close();
        break;
      }
      case 'Escape':
        if (open) {
          event.preventDefault();
          close();
        }
        break;
      case 'Tab':
        if (open) close();
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn('sc-combobox', className)} data-state={open ? 'open' : 'closed'}>
      <div className="sc-combobox-field">
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && filtered[highlight] !== undefined ? `${listId}-${highlight}` : undefined}
          autoComplete="off"
          className={cn('sc-combobox-input', mono && 'sc-combobox-input--mono')}
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            const next = event.target.value;
            setOpen(true);
            setHighlight(0);
            if (allowCustom) onChange(next);
            else setQuery(next);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? 'Close list' : 'Open list'}
          className="sc-combobox-toggle"
          disabled={disabled}
          onClick={() => (open ? close() : setOpen(true))}
        >
          ▾
        </button>
      </div>
      {open ? (
        <ul id={listId} role="listbox" className="sc-combobox-list">
          {customRow ? (
            <li
              role="option"
              aria-selected={true}
              className="sc-combobox-option sc-combobox-option--custom"
              onMouseDown={(event) => event.preventDefault()}
              onClick={close}
            >
              <span className="sc-combobox-option-label">{value.trim()}</span>
              <span className="sc-combobox-option-badge">custom</span>
            </li>
          ) : null}
          {filtered.length === 0 && !customRow ? <li className="sc-combobox-empty">{emptyText}</li> : null}
          {filtered.map((option, index) => (
            <li
              key={option.value}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={option.value === value}
              data-highlighted={index === highlight ? '' : undefined}
              className="sc-combobox-option"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              onClick={() => select(option)}
            >
              <span className="sc-combobox-option-check">{option.value === value ? '✓' : ''}</span>
              <span className="sc-combobox-option-text">
                <span className="sc-combobox-option-label">{option.label ?? option.value}</span>
                {option.description === undefined ? null : (
                  <span className="sc-combobox-option-description">{option.description}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
