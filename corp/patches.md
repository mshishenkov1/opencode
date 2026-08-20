# Реестр правок upstream (S-B6)

Базовый тег upstream — `corp/upstream-base` (`v1.17.9`). Таблица перечисляет **все** файлы upstream,
изменённые в ветке `corp/i4-sso-connectors`, с правилом спецификации, причиной и коммитом.

Правило: файл upstream правится отдельным коммитом с заголовком `corp: <что и зачем>`; строка в этой
таблице добавляется тем же коммитом (S-C8).

| Файл upstream | Правило | Причина | Коммит |
|---|---|---|---|
| `bun.lock` | — | Пересчёт lock-файла после `bun install`: github-зависимость `ghostty-web` сдвинула коммит (`20bd361` → `83c0a07`). Вернуть строку upstream нельзя — с исходным пином `bun install --frozen-lockfile` падает («lockfile had changes»), а обычный `bun install` пересчитывает её обратно: ссылка на ветку в upstream-репозитории уехала, старый коммит больше не воспроизводится | `ff6671cf10` |
| `packages/opencode/src/config/config.ts` | S-C3 | Мерж корпоративного слоя умолчаний до цикла `wellknown`, чтобы у слоя был наименьший приоритет | `06f3cada4e` |
| `packages/opencode/script/build.ts` | S-C2, S-I2, S-B2 | Build-константы `OPENCODE_CORP_HUB_URL` и `OPENCODE_CORP_CONFIG` в блоке `define`; `VITE_OPENCODE_CORP_HUB_URL` для сборки встроенного веб-UI; отбор целей по `CORP_TARGETS`, чтобы сборка одной цели не тянула остальные | `06f3cada4e`, `5adcde570d`, `cdf62dc441` |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | S-A1 | Регистрация группы корп-роутов `CorpApi` в `InstanceHttpApi` | `84e93ef0fe` |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | S-A1 | Подключение `corpHandlers` к серверу | `84e93ef0fe` |
| `packages/sdk/openapi.json` | S-A1 | Перегенерация OpenAPI-схемы после добавления корп-роутов | `84e93ef0fe` |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | S-A1 | Перегенерация SDK (`bun ./packages/sdk/js/script/build.ts`) | `84e93ef0fe` |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | S-A1 | Перегенерация SDK | `84e93ef0fe` |
| `packages/opencode/src/index.ts` | S-A12 | Регистрация группы команд `opencode corp` | `ee56c0514f` |
| `packages/tui/src/app.tsx` | S-T1, S-T2, S-T3 | Корп-команды `corp.connectors` / `corp.login` и ветвление first-run на корп-экран входа | `1b32c4d283` |
| `packages/tui/src/config/keybind.ts` | S-T1, S-T6 | Имена корп-команд и действий витрины (без них действия не отображаются) | `1b32c4d283` |
| `packages/tui/src/component/dialog-provider.tsx` | S-T5 | Перехват выбора провайдера `magnit_prod` — открывается корп-экран входа | `1b32c4d283` |
| `packages/tui/src/component/dialog-mcp.tsx` | S-V13 | Подпись `title` из кэша каталога рядом с alias | `1b32c4d283` |
| `packages/app/src/pages/layout.tsx` | S-D1, S-D3, S-D4 | Команды `corp.connectors` / `corp.login` и корп-кнопка в блоке Getting Started | `5adcde570d` |
| `packages/app/src/components/dialog-select-provider.tsx` | S-D5 | Перехват выбора провайдера `magnit_prod` | `5adcde570d` |
| `packages/app/src/context/language.tsx` | S-I2 | Русский язык по умолчанию при включённых корп-функциях | `5adcde570d` |
| `packages/app/src/env.d.ts` | S-C2, S-I2 | Объявление `VITE_OPENCODE_CORP_HUB_URL` для веб-UI | `5adcde570d` |
| `packages/app/src/i18n/en.ts` | S-I1 | Ключи `corp.*` | `5adcde570d` |
| `packages/app/src/i18n/ru.ts` | S-I1 | Ключи `corp.*` | `5adcde570d` |
| `packages/opencode/script/build-node.ts` | S-C2, S-B1, S-B3 | Build-константы `OPENCODE_CORP_HUB_URL` / `OPENCODE_CORP_CONFIG` и `OPENCODE_VERSION` для сервера, встроенного в Desktop: без них корп-режим в приложении был выключен, хотя CLI из той же сборки корпоративный (BUG-I4-003) | `e8cea036a4` |

Новые файлы, не относящиеся к upstream (в таблице не перечисляются): `corp/**`,
`packages/core/src/corp/**`, `packages/opencode/src/corp/**`, `packages/opencode/src/cli/cmd/corp.ts`,
`packages/opencode/src/server/routes/instance/httpapi/{groups,handlers}/corp.ts`,
`packages/tui/src/corp/**`, `packages/tui/src/component/corp/**`, `packages/app/src/corp/**`,
`packages/app/src/components/corp/**`, `packages/app/src/context/corp.ts`,
`.github/workflows/corp-ci.yml`.
