#!/usr/bin/env bash
# Синхронизация корпоративного форка с upstream (S-B5).
#
#   ./corp/upstream-sync.sh <тег upstream>        например ./corp/upstream-sync.sh v1.18.0
#
# Шаги: fetch upstream --tags → проверка чистого рабочего дерева → rebase рабочей ветки на тег →
# bun install → bun run typecheck → тесты пакетов opencode/tui/app → отчёт: какие из перечисленных
# в corp/patches.md upstream-файлов затронул апдейт. Скрипт ничего не пушит.
#
# Ненулевой код выхода при конфликте rebase, падении typecheck или тестов.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "укажите тег upstream, например: ./corp/upstream-sync.sh v1.18.0" >&2
  exit 2
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BASE_FILE="$ROOT/corp/upstream-base"
BASE="$(cat "$BASE_FILE" 2>/dev/null || echo "")"

step() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '\nОШИБКА: %s\n' "$1" >&2; exit 1; }

step "рабочее дерево"
if [ -n "$(git status --porcelain)" ]; then
  fail "рабочее дерево не чистое — закоммитьте или уберите изменения"
fi
echo "чисто, ветка $BRANCH"

step "git fetch upstream --tags"
if ! git remote get-url upstream >/dev/null 2>&1; then
  fail "нет remote 'upstream'; добавьте: git remote add upstream https://github.com/anomalyco/opencode"
fi
git fetch upstream --tags || fail "не удалось получить изменения upstream"

git rev-parse --verify "$TAG^{commit}" >/dev/null 2>&1 || fail "тег $TAG не найден"

step "файлы upstream, изменённые нами (corp/patches.md)"
PATCHED="$(grep -oE '^\| `[^`]+`' corp/patches.md | tr -d '|` ' | sort -u)"
if [ -z "$PATCHED" ]; then
  fail "corp/patches.md пуст — реестр правок обязателен (S-B6)"
fi
echo "$PATCHED" | sed 's/^/  /'

step "что меняет апдейт $BASE → $TAG в этих файлах"
CONFLICT_RISK=""
if [ -n "$BASE" ] && git rev-parse --verify "$BASE^{commit}" >/dev/null 2>&1; then
  UPSTREAM_CHANGED="$(git diff --name-only "$BASE" "$TAG")"
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    if printf '%s\n' "$UPSTREAM_CHANGED" | grep -Fxq "$file"; then
      CONFLICT_RISK="$CONFLICT_RISK$file"$'\n'
    fi
  done <<< "$PATCHED"
  if [ -n "$CONFLICT_RISK" ]; then
    echo "затронуты апдейтом (вероятны конфликты):"
    printf '%s' "$CONFLICT_RISK" | sed 's/^/  /'
  else
    echo "ни один из наших файлов апдейтом не затронут"
  fi
else
  echo "базовый тег '$BASE' из corp/upstream-base не найден — сравнение пропущено"
fi

step "git rebase $TAG"
if ! git rebase "$TAG"; then
  echo
  echo "rebase остановился. Конфликтующие файлы:"
  git diff --name-only --diff-filter=U | sed 's/^/  /'
  echo
  echo "Разрешите конфликты, затем: git rebase --continue (или git rebase --abort)."
  exit 1
fi

step "bun install"
bun install || fail "bun install"

step "bun run typecheck"
bun run typecheck || fail "typecheck"

step "тесты пакетов"
bun --cwd packages/opencode test || fail "тесты packages/opencode"
bun --cwd packages/tui test || fail "тесты packages/tui"
bun --cwd packages/app test || fail "тесты packages/app"

step "готово"
echo "$TAG" > "$BASE_FILE"
echo "corp/upstream-base обновлён до $TAG — не забудьте закоммитить его и corp/patches.md."
echo "Скрипт ничего не пушит: проверьте историю и отправьте изменения вручную."
