#!/usr/bin/env bash
# Собирает stepcast из текущего рабочего каталога и публикует его как
# отдельный, независимый от дальнейших правок релиз, на который смотрит
# глобальная команда `stepcast`.
#
# Идея: /opt/homebrew/bin/stepcast указывает на
# ~/.stepcast/releases/current/dist/src/bin.js, а current — это symlink,
# который здесь атомарно (через rename) переключается на новую директорию
# релиза. Пересборка в рабочем каталоге (`npm run build`, `npm run dev` и
# т.п.) никак не трогает уже опубликованный релиз — глобальный stepcast,
# которым пользуется, например, прогон assertum, продолжает работать со
# старой версией, пока этот скрипт не будет запущен явно.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASES_DIR="${STEPCAST_RELEASES_DIR:-$HOME/.stepcast/releases}"

cd "$REPO_DIR"

echo "==> npm run build"
npm run build

REV="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
DIRTY=""
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  DIRTY="-dirty"
fi
VERSION="$(date -u +%Y%m%dT%H%M%SZ)-${REV}${DIRTY}"
RELEASE_DIR="$RELEASES_DIR/$VERSION"

echo "==> Собираю независимый релиз $VERSION"
mkdir -p "$RELEASE_DIR"
cp -R dist "$RELEASE_DIR/dist"
cp -R schema "$RELEASE_DIR/schema"
cp package.json "$RELEASE_DIR/package.json"
cp package-lock.json "$RELEASE_DIR/package-lock.json"

echo "==> Ставлю зависимости релиза (npm ci --omit=dev)"
npm ci --omit=dev --prefix "$RELEASE_DIR" --no-audit --no-fund >/dev/null

echo "==> Атомарно переключаю current -> $VERSION"
ln -sfn "$RELEASE_DIR" "$RELEASES_DIR/current.tmp"
mv "$RELEASES_DIR/current.tmp" "$RELEASES_DIR/current"

echo "==> Готово: $RELEASES_DIR/current -> $RELEASE_DIR"
echo "    Глобальный stepcast (если настроен через bin-symlink) уже использует новую версию."
