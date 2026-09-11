import { useState, type JSX } from 'react';
import type { Context } from 'cordis';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Select,
  SelectContent,
  SelectItem,
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
import { SCREEN } from '@stepcast/slots';

const SAMPLE_TASKS = [
  { id: 't1', title: 'починить сборку', priority: 'высокий' },
  { id: 't2', title: 'обновить документацию', priority: 'обычный' },
] as const;

/**
 * Образец плагина «доска задач»: React на `@stepcast/ui` — Dialog, Tabs и
 * Select, которым иначе негде набрать пользователя среди встроенных экранов
 * (design.md изменения `shared-module-table`, Решение 12), рядом с Button,
 * Card, Table и Input, — и вклад в `SCREEN` дескриптором из
 * `@stepcast/slots`, а не строкой наугад.
 *
 * Плагин ничего не импортирует относительным путём и ничего не приносит в
 * бандле, кроме своего кода: React, cordis и компоненты витрины резолвятся
 * картой имён страницы в тот же экземпляр, которым пользуется сама витрина.
 *
 * Экран открыт ключом `board-example`, у которого нет собственного адреса
 * (`user-defined-routes` — работа другого изменения, не эта): образец
 * проверяется сборкой и прямым обращением к слоту `SCREEN` по ключу
 * (`test/ui-plugins.test.ts`), а не переходом по ссылке.
 */
function BoardScreen(): JSX.Element {
  const [tab, setTab] = useState('open');
  const [priority, setPriority] = useState('normal');
  const [filter, setFilter] = useState('');
  const [confirmingClose, setConfirmingClose] = useState(false);

  const visible = SAMPLE_TASKS.filter((task) => task.title.includes(filter));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Доска задач (образец)</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="open">Открытые</TabsTrigger>
            <TabsTrigger value="closed">Закрытые</TabsTrigger>
          </TabsList>

          <TabsContent value="open">
            <Input
              placeholder="фильтр по названию"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Название</TableHead>
                  <TableHead>Приоритет</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>{task.title}</TableCell>
                    <TableCell>{task.priority}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">низкий</SelectItem>
                <SelectItem value="normal">обычный</SelectItem>
                <SelectItem value="high">высокий</SelectItem>
              </SelectContent>
            </Select>

            <Dialog open={confirmingClose} onOpenChange={setConfirmingClose}>
              <DialogTrigger asChild>
                <Button variant="destructive">Закрыть все</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Закрыть все открытые задачи?</DialogTitle>
                  <DialogDescription>Действие нельзя отменить.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmingClose(false)}>
                    Отмена
                  </Button>
                  <Button variant="destructive" onClick={() => setConfirmingClose(false)}>
                    Закрыть
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="closed">
            <p>Закрытых задач нет.</p>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

export default function board(ctx: Context): void {
  ctx.slots.contribute(SCREEN, { component: BoardScreen, key: 'board-example' });
}
