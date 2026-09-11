import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';

import { SHARED_MODULES } from '../../src/ui/sharedModules.ts';
import * as StepcastUi from '@stepcast/ui';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogTrigger,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@stepcast/ui';

/**
 * Библиотека `@stepcast/ui` (design.md изменения `shared-module-table`,
 * Решение 6): состав объявлен таблицей общих модулей и сверяется с реальным
 * экспортом индекса (Решение 4); каждый из семи компонентов отрисовывается;
 * ни один файл стилей библиотеки не называет цвет литералом мимо токенов
 * (`ui-components`, «Цвет литералом в библиотеке»).
 *
 * `DialogContent` и `SelectContent` — под порталом (`@radix-ui/react-portal`),
 * который монтируется эффектом и в `renderToStaticMarkup` (эффекты не
 * исполняются) не портирует ничего: проверяется то, что доступно без DOM —
 * `Trigger` и остальные не-портальные части, — тем же ограничением, что уже
 * названо в документации для адаптера веб-компонента (design.md, Решение 10).
 */

// Тест собирается в `dist/ui-test/` (`scripts/build-ui-tests.mjs`) — два
// уровня вверх от скомпилированного файла ведут к корню репозитория, а не к
// исходнику рядом (тем же приёмом, что `ROOT` в `test/ui-shared-modules.test.ts`).
const ROOT_UI = join(fileURLToPath(new URL('../../', import.meta.url)), 'ui', 'src', 'ui');

describe('ui-components: состав библиотеки не расходится с таблицей', () => {
  it('каждое объявленное имя действительно экспортируется', () => {
    const mod = StepcastUi as unknown as Record<string, unknown>;
    const missing = SHARED_MODULES['@stepcast/ui'].names.filter(
      (name) => !Object.prototype.hasOwnProperty.call(mod, name),
    );
    assert.deepEqual(missing, [], 'перечень записи разошёлся с реальным экспортом ui/src/ui/index.ts');
  });

  it('модуль не экспортирует лишнего сверх объявленного перечня', () => {
    const declared = new Set(SHARED_MODULES['@stepcast/ui'].names);
    const extra = Object.keys(StepcastUi).filter((name) => !declared.has(name));
    assert.deepEqual(extra, [], 'модуль экспортирует имя, не названное записью таблицы');
  });
});

describe('ui-components: каждый компонент отрисовывается', () => {
  it('Button', () => {
    const markup = renderToStaticMarkup(<Button>Запустить</Button>);
    assert.match(markup, /<button/);
    assert.match(markup, /Запустить/);
  });

  it('Card', () => {
    const markup = renderToStaticMarkup(
      <Card>
        <CardHeader>
          <CardTitle>demo</CardTitle>
          <CardDescription>описание</CardDescription>
        </CardHeader>
        <CardContent>тело</CardContent>
        <CardFooter>подвал</CardFooter>
      </Card>,
    );
    assert.match(markup, /demo/);
    assert.match(markup, /тело/);
  });

  it('Table', () => {
    const markup = renderToStaticMarkup(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Имя</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>demo</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    assert.match(markup, /<table/);
    assert.match(markup, /demo/);
  });

  it('Input', () => {
    const markup = renderToStaticMarkup(<Input placeholder="фильтр" />);
    assert.match(markup, /<input/);
    assert.match(markup, /фильтр/);
  });

  it('Tabs', () => {
    const markup = renderToStaticMarkup(
      <Tabs defaultValue="week">
        <TabsList>
          <TabsTrigger value="week">Неделя</TabsTrigger>
          <TabsTrigger value="month">Месяц</TabsTrigger>
        </TabsList>
        <TabsContent value="week">содержимое недели</TabsContent>
      </Tabs>,
    );
    assert.match(markup, /Неделя/);
    assert.match(markup, /содержимое недели/);
  });

  it('Dialog — часть без портала (Trigger)', () => {
    const markup = renderToStaticMarkup(
      <Dialog>
        <DialogTrigger>Удалить</DialogTrigger>
      </Dialog>,
    );
    assert.match(markup, /Удалить/);
  });

  it('Select — часть без портала (Trigger, Value)', () => {
    const markup = renderToStaticMarkup(
      <Select defaultValue="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
      </Select>,
    );
    assert.match(markup, /<button/);
  });
});

describe('ui-components: вид прежней витрины не меняется переводом на библиотеку', () => {
  /** Тело правила по его селектору — первый блок `{…}` после него. */
  function ruleBody(css: string, selector: string): string {
    const found = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(found !== null, `правило ${selector} не найдено`);
    return (found as RegExpExecArray)[1] as string;
  }

  it('база кнопки не задаёт кегль: он наследуется, как наследовался у голого <button>', () => {
    // Прежнее глобальное правило `button` в `styles.css` кегля не задавало —
    // кнопка брала 15px у `body`. Собственный `font-size` в базе класса
    // выигрывал бы по специфичности у любого класса экрана и уменьшал бы
    // каждую переведённую кнопку, то есть менял бы вид (Решение 12 переводит
    // экраны по одному именно затем, чтобы вид не менялся).
    const css = readFileSync(join(ROOT_UI, 'button.css'), 'utf8');
    assert.doesNotMatch(ruleBody(css, '.sc-button'), /font-size/);
    assert.match(ruleBody(css, '.sc-button'), /font:\s*inherit/);
    // Меньший кегль там, где он нужен, — отдельным размером, а не базой.
    assert.match(ruleBody(css, '.sc-button--sm'), /font-size/);
  });

  it('поле и выбор рисуются на подложке карточки, как рисовало правило input, select', () => {
    for (const [file, selector] of [
      ['input.css', '.sc-input'],
      ['select.css', '.sc-select-trigger'],
    ] as const) {
      const css = readFileSync(join(ROOT_UI, file), 'utf8');
      assert.match(
        ruleBody(css, selector),
        /background:\s*var\(--card\)/,
        `${selector}: прежнее правило рисовало поле на --panel (нынешний --card), а не на подложке страницы`,
      );
    }
  });
});

describe('ui-components: ни один цвет не назван литералом мимо токенов', () => {
  const LITERAL_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

  it('файлы стилей библиотеки не содержат цвет литералом', () => {
    const files = readdirSync(ROOT_UI).filter((name) => name.endsWith('.css'));
    assert.ok(files.length > 0, 'в ui/src/ui/ не нашлось ни одного файла стилей');

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(join(ROOT_UI, file), 'utf8');
      for (const line of content.split('\n')) {
        if (LITERAL_COLOR_RE.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    assert.deepEqual(offenders, [], `цвет назван литералом мимо токенов: ${offenders.join('; ')}`);
  });
});
