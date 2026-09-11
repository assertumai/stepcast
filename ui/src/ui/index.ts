/**
 * `@stepcast/ui` — компоненты витрины исходниками в поставке (design.md
 * изменения `shared-module-table`, Решение 6). Исходники shadcn поверх Radix
 * и CSS-переменных, без Tailwind: браузерную половину плагина собирает демон
 * одним esbuild без прохода компилятора Tailwind, и утилитный класс в чужом
 * бандле не значил бы ничего (Риски design.md).
 *
 * Правятся как свой код репозитория, а не зависимость: тот, кому компонент не
 * подошёл, правит файл здесь, а не форкает пакет.
 */

export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './button';
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from './card';
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
} from './table';
export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription } from './dialog';
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';
export { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from './select';
export { Input } from './input';
