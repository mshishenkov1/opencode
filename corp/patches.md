# Реестр правок upstream (S-B6)

Базовый тег upstream — `corp/upstream-base` (`v1.17.9`). Таблица перечисляет **все** файлы upstream,
изменённые в ветке `corp/i4-sso-connectors`, с правилом спецификации и причиной. Новый корпоративный код
живёт в `corp/**` и в каталогах `packages/*/src/corp/**` и в этой таблице не перечисляется.

Правило: файл upstream правится отдельным коммитом с заголовком `corp: <что и зачем>`; строка в этой
таблице добавляется тем же коммитом (S-C8).

| Файл upstream | Правило | Причина | Коммит |
|---|---|---|---|
| `bun.lock` | — | Пересчёт lock-файла после `bun install` (github-зависимость `ghostty-web` сдвинула коммит) | `corp: bun.lock — ghostty-web pin после установки` |
| `packages/opencode/src/config/config.ts` | S-C3 | Мерж корпоративного слоя умолчаний до цикла `wellknown`, чтобы у слоя был наименьший приоритет | `corp: config layer` |
| `packages/opencode/script/build.ts` | S-C2 | Build-константы `OPENCODE_CORP_HUB_URL` и `OPENCODE_CORP_CONFIG` в блоке `define` | `corp: config layer` |
| `packages/opencode/src/server/routes/instance/httpapi/api.ts` | S-A1 | Регистрация группы корп-роутов `CorpApi` в `InstanceHttpApi` | `corp: hub client + routes` |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | S-A1 | Подключение `corpHandlers` к серверу | `corp: hub client + routes` |
| `packages/sdk/openapi.json` | S-A1 | Перегенерация OpenAPI-схемы после добавления корп-роутов | `corp: hub client + routes` |
| `packages/sdk/js/src/v2/gen/sdk.gen.ts` | S-A1 | Перегенерация SDK (`bun ./packages/sdk/js/script/build.ts`) | `corp: hub client + routes` |
| `packages/sdk/js/src/v2/gen/types.gen.ts` | S-A1 | Перегенерация SDK | `corp: hub client + routes` |
| `packages/opencode/src/index.ts` | S-A12 | Регистрация группы команд `opencode corp` | `corp: cli corp` |
| `packages/tui/src/app.tsx` | S-T1, S-T2, S-T3 | Корп-команды `corp.connectors` / `corp.login` и ветвление first-run на корп-экран входа | `corp: tui sso + connectors` |
| `packages/tui/src/config/keybind.ts` | S-T1, S-T6 | Имена команд и действий корп-диалогов (без них действия не отображаются) | `corp: tui sso + connectors` |
| `packages/tui/src/component/dialog-provider.tsx` | S-T5 | Перехват выбора провайдера `magnit_prod` — открывается корп-экран входа | `corp: tui sso + connectors` |
| `packages/tui/src/component/dialog-mcp.tsx` | S-V13 | Подпись `title` из кэша каталога рядом с alias | `corp: tui sso + connectors` |
| `packages/app/src/pages/layout.tsx` | S-D1, S-D3, S-D4 | Команды `corp.connectors` / `corp.login` и корп-кнопка в блоке Getting Started | `corp: app sso + connectors` |
| `packages/app/src/i18n/en.ts` | S-I1 | Ключи `corp.*` | `corp: app sso + connectors` |
| `packages/app/src/i18n/ru.ts` | S-I1 | Ключи `corp.*` | `corp: app sso + connectors` |
| `packages/app/src/context/language.tsx` | S-I2 | Русский по умолчанию при включённых корп-функциях | `corp: app sso + connectors` |
| `packages/app/src/components/dialog-select-provider.tsx` | S-D5 | Перехват выбора провайдера `magnit_prod` | `corp: app sso + connectors` |
