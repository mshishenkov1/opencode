#!/usr/bin/env bash
#
# corp/next-tag.sh — вычисление номера и имени тега корп-сборки (S-B16 п. 1, S-B1).
#
# Скрипт ТОЛЬКО считает: он не создаёт тегов, не коммитит, не пушит и не обращается в сеть.
# Постановку тега делает `.github/workflows/corp-release.yml`, и делает её по тому, что напечатано
# здесь. Логика вынесена из workflow ради S-Q11: вычисление N обязано проверяться по случаю на
# каждое правило на подменённом списке тегов, а шаг `run:` внутри YAML тестами не достаётся.
#
# Правила номера N (S-B1, S-B16 п. 1):
#   * коммит уже помечен тегом `v*-magnit.*` → ничего не делаем (идемпотентность);
#   * тегов текущей версии upstream нет (версия upstream сменилась) → N = 1;
#   * теги есть → N = максимум среди них + 1.
#
# Версия для имени тега берётся из ЕДИНСТВЕННОГО источника — `corp/build.ts --print-version`, того
# же кода, который проставит версию артефактам (`corpVersion()`, S-B1). Второго места, где имя тега
# собирается из кусков, в цепочке нет: имя тега и версия внутри артефактов не могут разойтись.
#
# Использование:
#   corp/next-tag.sh                 # печатает key=value для GITHUB_OUTPUT
#   corp/next-tag.sh --quiet         # без пояснений в stdout, только key=value
#
# Печатает (stdout):
#   skip=true|false      нужно ли ставить тег
#   build=<N>            номер корп-сборки (только при skip=false)
#   tag=v<версия>        имя тега (только при skip=false)
#   reason=<текст>       почему пропускаем (только при skip=true)
#
# Совместимость: bash 3.2 (тот же порог, что у установщиков).

set -euo pipefail

CDPATH=''
self_dir=$(cd -- "$(dirname -- "$0")" && pwd -P)
root=$(cd -- "$self_dir/.." && pwd -P)

quiet=0
if [ "${1:-}" = "--quiet" ]; then
  quiet=1
fi

note() {
  [ "$quiet" -eq 1 ] || printf '%s\n' "$1" >&2
}

# Версия корп-сборки от самого `corp/build.ts`. `CORP_BUILD` передаётся окружением: `corpVersion()`
# предпочитает его файлу `corp/version`, поэтому одним и тем же кодом считается и «текущая» версия
# (для выделения версии upstream), и версия с новым номером сборки.
build_version() {
  CORP_BUILD="$1" bun run "$root/corp/build.ts" --print-version
}

# 1. Коммит уже помечен — задание завершается успехом, ничего не делая (S-B16 п. 1).
#    Перезапуск задания не имеет права плодить теги на одном и том же составе.
existing=$(git -C "$root" tag --points-at HEAD --list 'v*-magnit.*' | head -1)
if [ -n "$existing" ]; then
  note "Коммит уже помечен тегом $existing — делать нечего."
  printf 'skip=true\n'
  printf 'reason=commit-already-tagged\n'
  exit 0
fi

# 2. Версия upstream — из той же версии сборки, а не из второго читателя package.json.
current=$(build_version 1)
upstream=${current%%-magnit.*}
note "версия upstream: $upstream"

# 3. Максимум среди тегов ТОЙ ЖЕ версии upstream.
#
#    Якорь `$` в sed обязателен: без него в счёт попали бы посторонние теги вида
#    `v<upstream>-magnit.<N>.<что-то>` и `…-magnit.<N>rc`, а посторонний номер способен оказаться
#    больше настоящего максимума — тогда следующий тег перепрыгнул бы через десятки номеров.
#    `sort -n` тоже обязателен: лексикографически «10» меньше «2», и после десятой сборки номер
#    поехал бы назад, на уже выпущенный состав.
last=$(git -C "$root" tag --list "v$upstream-magnit.*" \
  | sed -n "s|^v$upstream-magnit\.\([0-9][0-9]*\)\$|\1|p" \
  | sort -n \
  | tail -1)

if [ -z "$last" ]; then
  build=1
  note "тегов версии upstream $upstream нет — счёт корп-сборок начинается заново с 1"
else
  build=$((last + 1))
  note "максимум среди тегов версии upstream $upstream — v$upstream-magnit.$last"
fi

version=$(build_version "$build")
tag="v$version"
note "версия сборки: $version"

# 4. Последняя защита: имя нового тега обязано быть свободным. При правиле «максимум + 1» такого
#    тега быть не может — проверка охраняет само это свойство. Если правило номера когда-нибудь
#    поменяют и оно начнёт предлагать занятое имя, задание завершится успехом и ничего не сделает,
#    а не перезапишет тег уже выпущенного состава.
if git -C "$root" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  note "Тег $tag уже существует — делать нечего."
  printf 'skip=true\n'
  printf 'reason=tag-exists\n'
  exit 0
fi

printf 'skip=false\n'
printf 'build=%s\n' "$build"
printf 'tag=%s\n' "$tag"
