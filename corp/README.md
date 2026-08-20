# corp/ — корпоративный слой OpenCode (Magnit)

Закрытый форк `anomalyco/opencode`. Ветка `corp/i4-sso-connectors`, база — upstream `v1.17.9`.

Всё, что добавлено сверх upstream, лежит здесь и в каталогах `packages/*/src/corp/**`.
Правки самих файлов upstream минимальны и перечислены в [`patches.md`](./patches.md).

## Что даёт корпоративная сборка

1. **Вход по SSO одним экраном** — браузер + код + выбор команды; постоянный ключ LiteLLM
   сохраняется в auth-store как запись провайдера `magnit_prod` (S-A*).
2. **Витрина коннекторов** `/connectors` — карточки корпоративных MCP-серверов из Hub, подключение
   «в 2 клика» через штатный MCP-OAuth OpenCode, управление правами и отключение (S-V*, S-T*, S-D*).
3. **Корпоративные умолчания из бинарника** — адрес Hub, провайдер, модель, `autoupdate:false`
   (S-C*), с наименьшим приоритетом: пользовательский и проектный конфиг их перекрывают.
4. **Русский язык по умолчанию** в Desktop/web и на корп-экранах TUI (S-I*).

## Состав каталога

| Путь | Назначение |
|---|---|
| `config/opencode.corp.json` | Эталонный корп-конфиг; попадает в бинарник как build-константа `OPENCODE_CORP_CONFIG` |
| `docs/spec.md` | Спецификация I-4 (74 правила, факты F1–F32, решения D-1…D-12) |
| `docs/acceptance-criteria.yaml` | Критерии приёмки AC-01…AC-121 |
| `build.ts` | Сборка CLI и Desktop с корп-константами и версией `<upstream>-magnit.<N>` |
| `upstream-sync.sh` | Rebase на новый тег upstream + typecheck + тесты + отчёт по `patches.md` |
| `patches.md` | Реестр правок upstream-файлов |
| `plugin/` | Зарезервировано под корп-плагины (в I-4 пусто, см. D-1) |
| `version` | Номер `N` корп-сборки (`1.17.9-magnit.<N>`) |
| `upstream-base` | Базовый тег upstream для `upstream-sync.sh` и реестра правок |

## Ванильный режим

Корпоративные возможности включаются **одним** условием — известен адрес Hub (S-C5):

1. флаг `--hub <URL>` (только для команд `opencode corp *`);
2. переменная окружения `OPENCODE_CORP_HUB_URL`;
3. build-константа `OPENCODE_CORP_HUB_URL` (задаётся при сборке из env `CORP_HUB_URL`).

Если адрес неизвестен — корп-роуты отвечают `501 {"error":"corp_disabled"}`, корп-команды и корп-экраны
не регистрируются, first-run открывает upstream-список провайдеров. Поведение бинарника совпадает
с upstream (S-C6).

## Сборка

```sh
# корпоративная сборка CLI под все целевые платформы
CORP_HUB_URL=https://hub.magnit.ru CORP_BUILD=1 bun run corp/build.ts

# только текущая платформа
CORP_HUB_URL=https://hub.magnit.ru bun run corp/build.ts --targets darwin-arm64

# Desktop (mac-arm64 на macOS, win-x64 на Windows-стенде или в CI)
CORP_HUB_URL=https://hub.magnit.ru bun run corp/build.ts --desktop --skip-cli

# отладочная сборка Desktop под именем «OpenCode Dev» и с отдельным идентификатором
CORP_HUB_URL=https://hub.magnit.ru bun run corp/build.ts --desktop --skip-cli --channel dev
```

Версия сборки — `<версия upstream>-magnit.<N>`, где `N` берётся из `corp/version` или env `CORP_BUILD`.
Скрипт печатает sha256 каждого артефакта. Публикация в GitHub Releases — только с явным `--publish`.

Без `CORP_HUB_URL` скрипт печатает предупреждение и собирает ванильную сборку.

### Канал сборки (`--channel`)

`--channel <канал>` (или env `OPENCODE_CHANNEL`) уходит в сборку как `OPENCODE_CHANNEL`.
**По умолчанию `latest`** — канал раздачи. Раньше канал не задавался явно (`magnit`), и Desktop
молча собирался как отладочный «OpenCode Dev».

| `--channel` | Канал Desktop | Имя приложения | Идентификатор | Веб-UI |
|---|---|---|---|---|
| `latest` (по умолчанию) | `prod` | `OpenCode` | `ai.opencode.desktop` | prod-режим, без бейджа DEV |
| `dev` | `dev` | `OpenCode Dev` | `ai.opencode.desktop.dev` | dev-режим |
| `beta` | `beta` | `OpenCode Beta` | `ai.opencode.desktop.beta` | dev-режим |

У CLI и Desktop канал раздачи называется по-разному: `latest` у `@opencode-ai/script`, `prod` у
`electron-builder`. `corp/build.ts` переводит `latest` → `prod` для шагов Desktop, поэтому
конфигурация electron-builder не правится (S-B9, AC-112).

Смена канала меняет каталог данных Desktop-приложения и имя файла БД CLI (`opencode.db` для
`latest`/`prod`), поэтому канал задаётся явно и не меняется от сборки к сборке.

Публикация из `electron-builder` запрещена (`--publish never`): релиз собирает только `--publish`
этого скрипта (S-B4). Автообновление CLI выключено корп-умолчанием `autoupdate: false` (S-C3).

> **[проверить] Автообновление Desktop.** На каналах `latest`/`prod` и `beta` electron-updater
> включён (`UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"`), а `app-update.yml` в собранном
> приложении указывает на **публичный репозиторий upstream** `anomalyco/opencode` — этот фид
> electron-builder подставляет из `publish` в `packages/desktop/electron-builder.config.ts`, а при
> его отсутствии выводит из `repository` в `package.json`. То есть корп-приложение будет
> предлагать и ставить поверх себя ванильный OpenCode. Выключить это можно только правкой
> `publish` в конфиге electron-builder или подменой фида на приватный форк, а конфигурация
> electron-builder в I-4 заморожена (S-B9, AC-112). До решения раздавать Desktop либо с
> `--channel dev`, либо с осознанием, что обновления придут из upstream.

### Что делает `--desktop`

`bun run prebuild` (иконки и metainfo канала + сборка встроенного сервера `script/build-node.ts`) →
`bun run build` (electron-vite: main, preload, веб-UI) → `package:mac` / `package:win`. Первые два шага
обязательны: electron-builder только упаковывает готовый `out/` и без них падает на
«Application entry file out/main/index.js was not found». Артефакты — в `packages/desktop/dist`.

Корп-константы попадают в Desktop так же, как в CLI: `CORP_HUB_URL` и `corp/config/opencode.corp.json`
— в бандл встроенного сервера (`packages/opencode/script/build-node.ts`), `VITE_OPENCODE_CORP_HUB_URL`
— в веб-UI, версия S-B1 — через `OPENCODE_VERSION` и аргумент `-c.extraMetadata.version`
electron-builder (сам `packages/desktop/package.json` не правится).

## Локальная дымовая проверка

```sh
# поднять мок Hub и прогнать вход/статус/каталог без обращения к реальным системам
bun run corp/smoke.ts
```

Скрипт поднимает HTTP-мок Hub на `127.0.0.1` (маршруты `/cli/*`, `/api/*`, `/health`), запускает
`opencode corp status --hub …` и `opencode corp login --hub …` в изолированных `XDG_*`-каталогах
и проверяет коды выхода и вывод.

## Синхронизация с upstream

```sh
bun run --bun ./corp/upstream-sync.sh v1.18.0
```

Скрипт делает `git fetch upstream --tags`, проверяет чистое рабочее дерево, ребейзит ветку на тег,
ставит зависимости, гоняет `bun run typecheck` и тесты пакетов `opencode`/`tui`/`app` и печатает,
какие из перечисленных в `patches.md` файлов затронул апдейт. Ничего не пушит.

## Тесты

```sh
cd packages/opencode && bun test src/corp
cd packages/app && bun test
```
