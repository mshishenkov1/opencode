# Спецификация I-4: корпоративный форк OpenCode — вход по SSO, витрина коннекторов, умолчания, сборки

Ревизия 1, 2026-08-19. Ветка `corp/i4-sso-connectors`. База — upstream `anomalyco/opencode` v1.17.9.

Входы: требование `opencode-mcp-hub/examples/req-i4-opencode-fork.md` (F-01…F-13),
контекст продукта `opencode-mcp-hub/docs/req-mvp.md` rev 0.2 (§1.1, §6.1),
карта исходников `opencode-mcp-hub/docs/opencode-source-map.md`,
контракты Hub — `opencode-mcp-hub-i3/spec.md` (I-1 R-L*/R-A*/R-C*, I-3 R-O*/R-B*/R-P*),
каталог `opencode-mcp-hub/catalog.yaml`.

Пометки: **[проверено]** — прочитано в коде форка на текущем HEAD ветки (пути ниже абсолютны от корня
репозитория `opencode`); **[проверить]** — гипотеза, подтверждается при реализации/интеграции.

---

## 1. Назначение и границы

### 1.1. Назначение

Корпоративная сборка OpenCode, в которой сотрудник:

1. при первом запуске входит через корпоративный SSO одним экраном (браузер + код + выбор команды),
   получает постоянный ключ LiteLLM и работающую модель без ручной настройки;
2. открывает витрину `/connectors` (TUI, Desktop, `opencode web`), видит карточки корпоративных
   MCP-серверов из Hub и подключает нужный «в 2 клика» (OAuth в браузере);
3. управляет правами и отключением из той же витрины;
4. получает корпоративные умолчания (адрес Hub, провайдер, лимиты, `autoupdate:false`) из бинарника.

Наши изменения — минимальный, отделимый набор коммитов с префиксом `corp:` поверх upstream.

### 1.2. В объёме

- Корпоративный слой конфигурации из build-констант (S-C*).
- Вход по SSO: серверные корп-роуты, экраны TUI и Desktop/web, CLI `opencode corp login|status` (S-A*).
- Витрина коннекторов: клиент Hub, кэш каталога, модель состояния, действия (S-V*), экраны TUI (S-T*)
  и Desktop/web (S-D*).
- Русский по умолчанию: словари `packages/app/src/i18n/{ru,en}.ts` + минимальный словарь TUI (S-I*).
- Сборки CLI и Desktop, версия `upstream+-magnit.N`, CI, `corp/upstream-sync` (S-B*).
- Тесты рядом с модулями, моки HTTP к Hub, smoke сборки (S-Q*).

### 1.3. Вне объёма

- Реализация Hub, LiteLLM, ТЭГ-MCP (итерации I-1/I-3, отдельные репозитории).
- Установщики, CA-bundle, портал раздачи (R-13 req-mvp).
- Подпись сборок (Apple Developer ID / Authenticode) — решение ИБ, вне репозитория (открытый вопрос §4.3
  требования, см. §9, D-9).
- Локализация TUI целиком (только наши экраны).
- Замена/переписывание upstream-диалога `/mcps` — он продолжает работать как есть.

---

## 2. Факты о коде форка [проверено]

Все пути — от `/Users/miroslavshishenkov/Documents/opencode`.

### 2.1. TUI (`packages/tui`)

- **F1.** Команды и слэш-имена — `packages/tui/src/app.tsx`: константа `appBindingCommands`
  (строки ~100–131, список имён вида `mcp.list`, `provider.connect`, `opencode.status`) и фабрика
  `appCommands = createMemo(() => [...])` (строка ~545 и далее). Элемент команды — объект
  `{ name, title, category, slashName?, slashAliases?, hidden?, suggested?, run() }`; `run()` обычно
  делает `dialog.replace(() => <Dialog… />)`. Команда `mcp.list` (`title: "Toggle MCPs"`,
  `slashName: "mcps"`) — строки ~672–680; `provider.connect` (`slashName: "connect"`,
  `suggested: !connected()`) — строки ~724–732.
- **F2.** First-run «нет провайдера» — `packages/tui/src/app.tsx`, строки ~525–535:
  ```
  createEffect(on(() => sync.status === "complete" && sync.data.provider.length === 0,
    (isEmpty, wasEmpty) => { if (!isEmpty || wasEmpty) return; dialog.replace(() => <DialogProviderList />) }))
  ```
  Это единственная точка автозапуска экрана подключения провайдера в TUI.
- **F3.** Диалог MCP — `packages/tui/src/component/dialog-mcp.tsx` (85 строк): список из `sync.data.mcp`,
  `description` = сырой статус, `footer` = `Status()` (`✓ Enabled` / `○ Disabled` / `⋯ Loading`),
  единственное действие `dialog.mcp.toggle` → `local.mcp.toggle(name)` → `sdk.client.mcp.status()` →
  `sync.set("mcp", …)`. Ни OAuth, ни запись конфига здесь нет.
- **F4.** Тумблер — `packages/tui/src/context/local.tsx`, строки ~504–519: `mcp.isEnabled` = статус
  `connected`; `mcp.toggle` = `connected → sdk.client.mcp.disconnect({name})`, иначе
  `sdk.client.mcp.connect({name})`. Конфиг не пишется — **изменение только runtime**.
- **F5.** Методы аутентификации провайдера в TUI берутся из `sync.data.provider_auth[providerID]`
  (`packages/tui/src/context/sync.tsx`, строка 516: `sdk.client.provider.auth(...)`), диспетчеризация —
  `packages/tui/src/component/dialog-provider.tsx`, строки 148–216: при отсутствии методов подставляется
  `[{type:"api", label:"API key"}]`; `type:"oauth"` → `sdk.client.provider.oauth.authorize` →
  `CodeMethod` или `AutoMethod`; `type:"api"` → `ApiMethod` (ввод ключа) → `sdk.client.auth.set({providerID,
  auth:{type:"api", key}})` (строки 396–403).
- **F6.** `AutoMethod` (`dialog-provider.tsx`, строки 233–303) рисует **только** ссылку
  (`props.authorization.url`), текст `instructions` и строку «Waiting for authorization...», а в `onMount`
  один раз вызывает `sdk.client.provider.oauth.callback(...)`. Промежуточного взаимодействия с
  пользователем между `authorize()` и `callback()` в этом экране нет.

### 2.2. Desktop/web (`packages/app`, `packages/desktop`)

- **F7.** Диалог MCP — `packages/app/src/components/dialog-select-mcp.tsx`: `statusLabels` (строки 9–15)
  сопоставляют статусы ключам i18n `mcp.status.*`; список + `Switch`; ошибки для `failed` и
  `needs_client_registration`.
- **F8.** Тумблер — `packages/app/src/context/global-sync/mcp.ts` (`toggleMcp`): маршрутизация по статусу
  `connected→disconnect`, `needs_auth→authenticate`, `disabled|failed|needs_client_registration→connect`,
  затем `refresh`. Вызов — `packages/app/src/context/mcp.ts` (`useMcpToggle`, tanstack mutation).
- **F9.** Команды — `packages/app/src/context/command.tsx`: `register(key, cb)` (строки ~394–400),
  элемент `{ id, title, description?, category?, keybind?, slash?, onSelect(source) }`, каталог
  персистится в `command.catalog.v1` (строки 251–262). Сессионные команды —
  `packages/app/src/pages/session/use-session-commands.tsx` (`mcpCmds()`, `mcp.toggle`, `slash: "mcp"`,
  `keybind: "mod+;"`, строки ~531–539; `chooseMcp()` строки 258–261). Глобальные — `layout.tsx`
  (`command.register("layout", …)` строка 993).
- **F10.** `layout.tsx`: `connectProvider()` (строки ~1205–1211) лениво импортирует
  `@/components/dialog-select-provider`; блок Getting Started (строки ~2295–2320) виден при
  `providers.all().size > 0 && providers.paid().length === 0` и содержит кнопку с `onClick={connectProvider}`.
- **F11.** Маршруты приложения — `packages/app/src/app.tsx`, строки 451–460: `/`, `/:dir`,
  `/:dir/session/:id?`, `/new-session`. Статического сегмента верхнего уровня, кроме `/new-session`, нет;
  `/:dir` — динамический сегмент, покрывающий любой одиночный путь.
- **F12.** Desktop — Electron: `packages/desktop/package.json` (`package:mac|win|linux` →
  `electron-builder --config electron-builder.config.ts`), `packages/desktop/electron-builder.config.ts`
  (`artifactName: "opencode-desktop-${os}-${arch}.${ext}"`, строка 43; `appId` по каналу из
  `process.env.OPENCODE_CHANNEL`, строки 30–40).

### 2.3. Сервер (внутри бинарника)

- **F13.** HTTP API MCP — `packages/opencode/src/server/routes/instance/httpapi/groups/mcp.ts`,
  `McpPaths` (строки 32–39): `GET /mcp`, `POST /mcp`, `POST /mcp/:name/auth`,
  `POST /mcp/:name/auth/callback`, `POST /mcp/:name/auth/authenticate`, `DELETE /mcp/:name/auth`,
  `POST /mcp/:name/connect`, `POST /mcp/:name/disconnect`.
- **F14.** Статусы MCP — `packages/opencode/src/mcp/index.ts`, строки 95–119:
  `connected | disabled | failed{error} | needs_auth | needs_client_registration{error}`.
- **F15.** `MCP.authenticate` (строки ~813–869) = `startAuth` → `open(authorizationUrl)` (при неудаче
  событие `BrowserOpenFailed`) → `McpOAuthCallback.waitForCallback` → сверка `oauthState` → `finishAuth`.
  `startAuth` (строки ~748–812) берёт `oauth` из конфига сервера: `clientId`, `clientSecret`, `scope`,
  `redirectUri`/`callbackPort`; при отсутствии `clientId` работает автообнаружение и DCR.
- **F16.** OAuth callback — `packages/opencode/src/mcp/oauth-provider.ts`: `OAUTH_CALLBACK_PORT = 19876`,
  `OAUTH_CALLBACK_PATH = "/mcp/oauth/callback"`, по умолчанию
  `http://127.0.0.1:19876/mcp/oauth/callback`. Токены — `packages/opencode/src/mcp/auth.ts`,
  `Global.Path.data/mcp-auth.json`, права `0o600`.
- **F17.** `MCP.connect` (строка ~610) = `createAndStore(name, {...mcp, enabled:true})` — правит только
  `s.config` в памяти; `disconnect` (строка ~615) закрывает клиент и ставит `{status:"disabled"}`.
  **Персиста конфига нет.**
- **F18.** Схема `mcp.<name>` (v1, пользовательский конфиг) — `packages/core/src/v1/config/mcp.ts`:
  `Remote = { type:"remote", url, enabled?, headers?, oauth?: OAuth|false, timeout? }`,
  `OAuth = { clientId?, clientSecret?, scope?, callbackPort?, redirectUri? }` (**camelCase**).
- **F19.** Имя MCP-инструмента для `permission`/`tools` — `packages/opencode/src/mcp/index.ts` (строка
  ~646): `key = McpCatalog.sanitize(clientName) + "_" + McpCatalog.sanitize(mcpTool.name)`, где
  `packages/opencode/src/mcp/catalog.ts` строка 110: `sanitize = (v) => v.replace(/[^a-zA-Z0-9_-]/g, "_")`.
  Дефис **сохраняется**: alias `gitlab-platform` даёт `gitlab-platform_create_issue`. Это закрывает
  открытый вопрос §4.2 требования (см. §9, D-8).
- **F20.** Слои конфигурации — `packages/opencode/src/config/config.ts`, `loadInstanceState` (строка ~313):
  `let result: Info = {}` → цикл по auth-записям `type:"wellknown"` (строки 355–394: `<url>/.well-known/opencode`,
  затем `remote_config` с заголовками) → `merge(Global.Path.config, global)` → `Flag.OPENCODE_CONFIG` →
  файлы проекта. Каждый следующий `merge` перекрывает предыдущий, поэтому **слой, добавленный до цикла
  well-known, имеет наименьший приоритет**.
- **F21.** Запись конфига — там же: `update` (строка ~623) пишет `<instance dir>/config.json`;
  `updateGlobal` (строка ~636) пишет `globalConfigFile()` = первый существующий из
  `opencode.jsonc | opencode.json | config.json` в `Global.Path.config` (строка ~139), для `.jsonc` —
  точечный патч `patchJsonc` (строка ~149), затем `invalidate()`; возвращает `{ info, changed }`.
- **F22.** Auth-store — `packages/opencode/src/auth/index.ts`: `Global.Path.data/auth.json`, права `0o600`,
  варианты записи `Oauth | Api{type:"api", key, metadata?} | WellKnown{type:"wellknown", key, token}`;
  `Auth.set(providerID, info)`. HTTP: `sdk.client.auth.set` (используется TUI, F5).
- **F23.** Plugin API — `packages/plugin/src/index.ts`: `Hooks = { dispose, event, config, tool, auth,
  provider, "chat.message", "chat.params", "chat.headers", "permission.ask", "command.execute.before",
  "tool.execute.before", "shell.env", "tool.execute.after", "experimental.chat.messages.transform" }`.
  **Хука для регистрации HTTP-маршрутов сервера нет.** `AuthHook.methods[].type = "oauth"|"api"`;
  `AuthOAuthResult = { url, instructions } & ({method:"auto", callback()} | {method:"code", callback(code)})`
  (строки 163–204) — промежуточных шагов диалога контракт не предусматривает.
  Реализация — `packages/opencode/src/provider/auth.ts`: `methods()` собирает хуки плагинов,
  `authorize()` вызывает `method.authorize(inputs)` и кладёт результат в `pending`, `callback()` вызывает
  `match.callback()` и при `"key" in result` делает `auth.set(providerID, {type:"api", key, metadata?})`
  (строки 200–210).
- **F24.** Флаги — `packages/core/src/flag/flag.ts`: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT`,
  `OPENCODE_CONFIG_DIR`, `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_CLIENT` и др.
- **F25.** Build-константы — `packages/opencode/script/build.ts`, блок `define` (строки ~189–197):
  `FFF_LIBC`, `OPENCODE_VERSION`, `OPENCODE_MODELS_DEV`, `OTUI_TREE_SITTER_WORKER_PATH`,
  `OPENCODE_WORKER_PATH`, `OPENCODE_CHANNEL`, `OPENCODE_LIBC`. Способ потребления —
  `packages/core/src/installation/version.ts`:
  ```
  declare const OPENCODE_VERSION: string
  export const InstallationVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"
  ```
  Там же (строки ~205–215) — smoke-тест `dist/<name>/bin/opencode --version` для текущей платформы.
- **F26.** CLI — `packages/opencode/src/index.ts` (строки 81–103) собирает команды через `.command(X)`;
  образец группы — `packages/opencode/src/cli/cmd/mcp.ts`: `McpCommand = cmd({ command: "mcp", builder:
  (y) => y.command(McpAddCommand)…demandCommand() })`, подкоманды через `effectCmd`. Персист конфига там же:
  `addMcpToConfig` (строки ~423–439) — `modify(text, ["mcp", name], mcpConfig)` + `applyEdits`.
- **F27.** Пути — `packages/core/src/global.ts`: `Path.data = xdgData/opencode`, `Path.config =
  xdgConfig/opencode`, `Path.cache`, `Path.state`.

### 2.4. i18n

- **F28.** `packages/app/src/context/language.tsx`: `Locale` — union из 18 значений, включая `ru`;
  словари грузятся лениво (`loaders`, строки ~106–125), базовый — `en`; выбор локали:
  `const warm = readStoredLocale() ?? detectLocale()` (строка ~195), `detectLocale()` перебирает
  `navigator.languages` по `localeMatchers` и **возвращает `"en"`, если ничего не совпало** (строки ~163–176);
  `normalizeLocale(value)` возвращает `"en"` для неизвестного значения (строка ~178).
- **F29.** `packages/app/src/i18n/ru.ts` — 944 строки против 1046 в `en.ts` (не полный).
  `packages/app/src/i18n/parity.test.ts` — **не** тест полного паритета ключей: он проверяет ровно два
  ключа (`command.session.previous.unseen`, `command.session.next.unseen`) во всех не-английских словарях.
  Формулировка требования F-09 «тест паритета ключей проходит» относится именно к этому тесту.
- **F30.** В `packages/tui/src` словарей и i18n нет — строки захардкожены («Toggle MCPs», «✓ Enabled»).

### 2.5. Тесты и сборка

- **F31.** `packages/opencode/package.json` и `packages/tui/package.json`: `"test": "bun test --timeout
  30000 --only-failures"`; `packages/app/package.json`: `"test": "bun run test:unit && bun run
  test:virtualizer"`. `turbo.json` содержит задачи `opencode#test`, `@opencode-ai/app#test`,
  `@opencode-ai/ui#test` и общий `typecheck`.
- **F32.** Корень: `packageManager: "bun@1.3.14"`, `"typecheck": "bun turbo typecheck"`,
  `"test"` в корне запрещён (`echo 'do not run tests from root' && exit 1`).

---

## 3. Контракты взаимодействия с Hub

Клиент обращается к Hub **только с серверной стороны бинарника OpenCode** (см. D-1). Базовый адрес —
`hubUrl` (§4, S-C2). Аутентификация `/api/*` и `/remote-config` — `Authorization: Bearer <ключ провайдера
magnit_prod из auth-store>`.

### 3.1. Вход (I-1, R-L*)

| Вызов | Запрос | Ответы, которые обрабатывает клиент |
|---|---|---|
| `POST {hub}/cli/start` | `{client: "opencode/<версия> <os>-<arch>"}` | 200 `{login_id, poll_secret, browser_url, user_code, expires_in}`; 429 `rate_limited` (+`Retry-After`); 502 `litellm_unavailable`; 400 `invalid_request` |
| `GET {hub}/cli/poll/{login_id}` | заголовок `X-Hub-Poll-Secret: <poll_secret>` | 200 `{status:"pending"}` / `{status:"team_selection_required", teams:[{team_id, team_alias}]}` / `{status:"ready", key, key_kind:"persistent"\|"jwt", user:{user_id,email}, team_id, expires_in?}`; 403 `forbidden`; 404 `login_expired`; 502 `litellm_unavailable` \| `litellm_invalid_response` |
| `POST {hub}/cli/poll/{login_id}/team` | `{team_id}` + `X-Hub-Poll-Secret` | 200 `{status:"pending"}`; 400 `invalid_request` \| `invalid_team`; 403; 404; 409 `team_selection_not_required` |

`poll_secret` **никогда** не покидает серверную часть бинарника (в UI не отдаётся, в логи не пишется).

### 3.2. Каталог и подключения (I-1 R-A*, I-3 R-W*/R-B*)

| Вызов | Ответ, используемый витриной |
|---|---|
| `GET {hub}/api/me` | `{user_id, email, key_kind, created_at}` — для `opencode corp status` и заголовка витрины |
| `GET {hub}/api/catalog` | `{version, servers:[{alias, title, description, owner, contact, docs_url, status, mode, mcp_url, permission_model, auth_kind, connection:{status, preset, updated_at}}]}` |
| `GET {hub}/api/me/connections` | `[{alias, status, preset, groups, created_at, updated_at}]` |
| `PUT {hub}/api/me/connections/{alias}/permissions` | тело `{preset, groups?}` → 200 `{alias, status, preset, groups}`; 400/401/404 |
| `DELETE {hub}/api/me/connections/{alias}` | 200 `{alias, status:"not_connected"}`; 401/404 |

`connection.status ∈ {not_connected, connected, needs_reauth}`; `server.status ∈ {beta, ga, deprecated}`;
`mode ∈ {native, facade}`; `mcp_url` для `facade` уже равен `<hub>/mcp/<alias>` (Hub подставляет сам).
`permission_model` — `{kind:"header_groups", groups:[{id,title,preset}], always:[…]}` или
`{kind:"consent"|"tool_filter", presets:{…}}`; поле `header` наружу не отдаётся.

### 3.3. OAuth к MCP-серверу (I-3 R-O*)

Подключение выполняется **штатным MCP-OAuth-клиентом OpenCode** (F15/F16), без корп-кода в OAuth:

- `resource` — `mcp_url` карточки; обнаружение AS — `/.well-known/oauth-protected-resource/mcp/{alias}` и
  `/.well-known/oauth-authorization-server`; регистрация клиента — `POST {hub}/oauth/register` (DCR),
  далее `/oauth/authorize` (PKCE S256) и `/oauth/token`.
- Scope для `mode: facade` — `"<alias>:readonly"` либо `"<alias>:readwrite"` (I-3 R-O1/R-O5, R-18/48/49):
  именно это значение пишется в `mcp.<alias>.oauth.scope`.
- Для `mode: native` (`permission_model.kind: "consent"`, напр. `tag`) `oauth.scope` **не задаётся** —
  права выбираются на экране согласия самого сервера.
- `redirect_uri` клиента — `http://127.0.0.1:19876/mcp/oauth/callback` (F16). **[проверить]** Hub
  `POST /oauth/register` должен принимать loopback-HTTP redirect (I-3 R-O3 отвергает `invalid_redirect_uri`);
  при отказе — параметризовать `oauth.redirectUri` из корп-конфига (§4, S-C4).
- Ошибки MCP-proxy Hub приходят как JSON-RPC `error.data.reason` (`needs_reauth`) и `hint_url`
  (I-3 §17) — витрина показывает их текстом карточки.

### 3.4. Корпоративные умолчания от Hub

`GET {hub}/.well-known/opencode` и `GET {hub}/remote-config` уже поддерживаются upstream (F20) при наличии
auth-записи `type:"wellknown"`. Корп-слой (S-C*) — **дополнение** к ним с меньшим приоритетом, а не замена.

---

## 4. Правила: корпоративные умолчания и конфигурация (S-C*)

- **S-C1. Каталог `corp/`.** В корне монорепо: `corp/config/opencode.corp.json` (эталонный корп-конфиг),
  `corp/README.md`, `corp/patches.md`, `corp/docs/` (эта спецификация и критерии), `corp/build.ts`,
  `corp/upstream-sync.sh`, `corp/plugin/` (зарезервирован под корп-плагины; в I-4 содержит только
  `README.md` с обоснованием D-1). Каталог не участвует в сборке upstream-пакетов и не ломает
  `bun run typecheck`.
- **S-C2. Build-константы.** В `define` (`packages/opencode/script/build.ts`) добавляются
  `OPENCODE_CORP_HUB_URL` (строка, базовый URL Hub без хвостового `/`) и `OPENCODE_CORP_CONFIG`
  (строка — JSON корп-конфига, содержимое `corp/config/opencode.corp.json`). Значения берутся из env
  сборки `CORP_HUB_URL` и файла `corp/config/opencode.corp.json`; если env/файла нет — константы не
  определяются. Потребление — по образцу F25:
  `declare const OPENCODE_CORP_HUB_URL: string; export const CorpHubUrl = typeof OPENCODE_CORP_HUB_URL === "string" && OPENCODE_CORP_HUB_URL !== "" ? … : undefined`.
- **S-C3. Слой конфигурации.** Корп-конфиг из `OPENCODE_CORP_CONFIG` мержится в `Config` **первым** —
  до цикла auth-записей `wellknown` в `loadInstanceState` (F20). Порядок приоритета (снизу вверх):
  `корп-слой < .well-known/remote-config Hub < глобальный конфиг пользователя < OPENCODE_CONFIG <
  конфиг проекта`. Разбор корп-JSON выполняется тем же `loadConfig`, что и файловые слои; ошибка разбора —
  предупреждение в лог и пустой слой (сборка не должна падать из-за опечатки в константе).
- **S-C4. Содержимое корп-конфига.** `corp/config/opencode.corp.json` задаёт: `$schema`,
  `autoupdate: false`, `share: "disabled"`, `enabled_providers: ["magnit_prod"]`, провайдера
  `magnit_prod` (`npm: "@ai-sdk/openai-compatible"`, `name`, `options.baseURL`, `options.apiKey:
  "{env:MAGNIT_COPILOT_KEY}"`, модель `MagnitCopilot` с `limit.context`/`limit.output`), `model:
  "magnit_prod/MagnitCopilot"`. Секретов в файле нет. Файл валиден по схеме конфига OpenCode.
- **S-C5. Переопределение адреса Hub.** Действующий адрес Hub = первое непустое из:
  1) флаг команды `--hub <URL>` (только для `opencode corp *`);
  2) переменная окружения `OPENCODE_CORP_HUB_URL`;
  3) build-константа `OPENCODE_CORP_HUB_URL`.
  Если ни одно не задано — корп-функции (вход по SSO, витрина, `opencode corp *`) **выключены**:
  корп-роуты возвращают `501 {error:"corp_disabled"}`, команды `/connectors` и корп-экран входа не
  регистрируются и не подменяют upstream-поведение.
- **S-C6. Ванильная сборка.** При отсутствии обеих build-констант и переменных окружения поведение
  бинарника побайтово эквивалентно upstream по наблюдаемому поведению: first-run открывает
  `DialogProviderList` (F2), в палитре нет корп-команд, конфиг не содержит корп-слоя.
- **S-C7. Отсутствие записи о пользовательском конфиге.** Корп-слой никогда не пишется в файлы
  пользователя; `Config.updateGlobal` вызывается только действиями витрины (S-V7/S-V8) и только для
  ключей `mcp.<alias>`.
- **S-C8. Границы префикса `corp:`.** Каждое изменение файла upstream — отдельный коммит с заголовком
  `corp: <что и зачем>`; новый корп-код размещается в новых файлах (`packages/*/src/corp/**`,
  `corp/**`), чтобы уменьшить поверхность конфликтов при rebase. `corp/patches.md` перечисляет **все**
  изменённые файлы upstream с причиной и ссылкой на правило спецификации.

---

## 5. Правила: вход по корпоративному SSO (S-A*)

### 5.1. Серверная часть

- **S-A1. Корп-роуты.** Новая группа HTTP API `packages/opencode/src/server/routes/instance/httpapi/groups/corp.ts`
  (+ `handlers/corp.ts`), регистрируемая рядом с существующими группами:
  | Метод и путь | Тело/параметры | Ответ |
  |---|---|---|
  | `POST /corp/login/start` | — | `{login_id, user_code, browser_url, expires_in}` |
  | `GET /corp/login/poll/:login_id` | — | `{status:"pending"}` / `{status:"team_selection_required", teams:[{team_id, team_alias}]}` / `{status:"ready", user:{user_id,email}, key_kind}` / `{status:"error", error, message}` |
  | `POST /corp/login/poll/:login_id/team` | `{team_id}` | `{status:"pending"}` / `{status:"error", …}` |
  | `GET /corp/status` | — | `{hub_url, enabled, authenticated, user?, key_kind?, catalog_version?, catalog_cached_at?, catalog_stale?}` |
  Все — за теми же middleware (`InstanceContextMiddleware`, `Authorization`), что и группы `mcp`/`config`.
- **S-A2. Прокси-семантика.** `POST /corp/login/start` вызывает Hub `POST /cli/start` (§3.1), сохраняет
  `login_id` и `poll_secret` Hub **только в памяти процесса** (Map `login_id → {poll_secret, hub_url,
  expires_at, teams?}`), а наружу отдаёт `login_id`, `user_code`, `browser_url`, `expires_in`.
  `GET /corp/login/poll/:login_id` подставляет сохранённый `poll_secret` в `X-Hub-Poll-Secret`.
  `poll_secret` не попадает ни в ответы, ни в логи, ни в события.
- **S-A3. Сохранение ключа.** При ответе Hub `ready` сервер выполняет `Auth.set("magnit_prod",
  {type:"api", key, metadata:{hub: <hub_url>, key_kind, user_id, team_id?}})` (F22), затем сбрасывает
  сессию входа из памяти и инвалидирует конфиг/провайдеров так же, как это делает upstream-флоу
  (`instance.dispose()` + `sync.bootstrap()` со стороны UI, F6). Перезапуск не требуется.
- **S-A4. Таймауты и повторы.** Клиентский опрос — раз в 2 с (соответствует дросселированию Hub, R-L10),
  общий предел — `expires_in` из `/cli/start` (при отсутствии — 600 с). Сетевая ошибка/502 от Hub не
  прекращает опрос (до 5 подряд), затем — ошибка `hub_unavailable`. `404 login_expired` и `403 forbidden`
  прекращают сессию сразу.
- **S-A5. Ошибки наружу.** Корп-роуты отдают стабильные коды: `corp_disabled`, `hub_unavailable`,
  `login_expired`, `forbidden`, `invalid_team`, `team_selection_not_required`, `rate_limited`,
  `litellm_unavailable`, `litellm_invalid_response`, `unauthorized`. Каждому соответствует русское
  сообщение в словаре (S-I*). Тексты ошибок Hub, содержащие секреты, не пересылаются: наружу идёт только
  код + наш текст + при наличии `Retry-After`.

### 5.2. Экран входа

- **S-A6. Содержимое экрана.** Корп-экран входа (общий сценарий для TUI и Desktop/web) состоит из шагов:
  1) заголовок «Вход через корпоративный SSO» и адрес Hub;
  2) после `POST /corp/login/start` — крупный `user_code`, ссылка `browser_url` (открывается в браузере
     автоматически) и подсказка «Скопировать код»; состояние «Ожидание подтверждения…»;
  3) при `team_selection_required` — список команд (`team_alias`, значение — `team_id`) с выбором;
     выбор отправляется в `POST /corp/login/poll/:login_id/team`, экран возвращается к шагу 2;
  4) при `ready` — сообщение об успехе с `user.email`, закрытие экрана и переход к обычной работе;
  5) при ошибке — код и русский текст, действия «Повторить» и «Отмена».
  Кнопка «Другой провайдер» на шаге 1 открывает upstream-список провайдеров без изменений.
- **S-A7. First-run.** Экран входа открывается автоматически, если одновременно: корп-функции включены
  (S-C5), в auth-store нет записи `magnit_prod`, и upstream-условие first-run выполнено
  (TUI — F2; Desktop/web — блок Getting Started, F10). При наличии ключа `magnit_prod` экран не
  показывается.
- **S-A8. Повторный вход.** Тот же экран доступен всегда: командой `corp.login` (слэш `login`,
  алиас `sso`) и при выборе провайдера `magnit_prod` в upstream-списке провайдеров. Повторный вход
  перезаписывает запись auth-store; предыдущий ключ Hub помечает устаревшим на своей стороне
  (I-1 R-L5) — клиент ничего не удаляет.
- **S-A9. Отмена.** Закрытие экрана (esc/крестик) прекращает опрос, освобождает сессию в памяти сервера,
  ключ не сохраняется, состояние приложения не меняется.

### 5.3. CLI

- **S-A10. `opencode corp login [--hub URL]`.** Тот же флоу без TUI: печатает адрес и код, пытается
  открыть браузер (`open`), при неудаче печатает URL; при `team_selection_required` — нумерованный
  список команд и ввод номера (в неинтерактивном режиме — ошибка с подсказкой `--team <id>`);
  при `ready` — печатает `user.email`, `key_kind` и сохраняет ключ (S-A3). Код выхода `0` при успехе,
  `1` при любой ошибке.
- **S-A11. `opencode corp status [--hub URL]`.** Печатает: адрес Hub, доступность Hub
  (`GET /health` — `ok`/`недоступен`), наличие ключа `magnit_prod` (`есть`/`нет`, без самого ключа),
  `user_id`/`email` и `key_kind` из `GET /api/me` (если ключ есть), версию каталога и время кэша
  (`catalog_version`, `catalog_cached_at`, признак `протух`). Код выхода `0`, если корп-функции включены
  и ключ есть; `1` иначе. Ключ, `poll_secret` и токены не печатаются никогда.
- **S-A12. Группа команд.** `CorpCommand = cmd({ command: "corp", builder: y =>
  y.command(CorpLoginCommand).command(CorpStatusCommand).demandCommand() })`, регистрация — одной
  строкой `.command(CorpCommand)` в `packages/opencode/src/index.ts` (F26). При выключенных корп-функциях
  (S-C5) команды печатают «Корпоративный режим не настроен» и завершаются с кодом `1`.

---

## 6. Правила: витрина коннекторов (S-V*)

### 6.1. Данные и кэш

- **S-V1. Корп-роуты витрины.** В той же группе `corp`:
  | Метод и путь | Тело | Ответ |
  |---|---|---|
  | `GET /corp/catalog?refresh=true\|false` | — | `{version, source:"hub"\|"cache", cached_at, stale, servers:[…], hub_error?}` |
  | `POST /corp/connectors/:alias/connect` | `{preset?}` | `{alias, status, error?}` |
  | `POST /corp/connectors/:alias/disconnect` | — | `{alias, status:"not_connected"}` |
  | `PUT /corp/connectors/:alias/permissions` | `{preset}` | `{alias, status, preset, reauth_required}` |
- **S-V2. Клиент Hub.** Модуль `packages/opencode/src/corp/hub.ts`: тонкая обёртка над `fetch` с базовым
  URL (S-C5), заголовками `Authorization: Bearer <ключ magnit_prod>`, `X-Request-ID` (uuid4) и таймаутом
  5 с на запрос. Ответы валидируются схемой; несоответствие схемы — ошибка `hub_invalid_response`
  (карточки не подменяются частично, ответ отбрасывается целиком).
- **S-V3. Кэш каталога.** Успешный `GET /api/catalog` пишется в
  `Global.Path.data/corp/catalog-<sha256(hub_url).slice(0,16)>.json` с правами `0o600`, содержимым
  `{hub_url, fetched_at, version, servers}`. TTL — 24 ч. При открытии витрины всегда выполняется запрос
  к Hub; при успехе кэш перезаписывается и `source:"hub"`. При ошибке Hub:
  - есть кэш и `now - fetched_at ≤ 24 ч` → `source:"cache"`, `stale:false`, отдаются карточки + `hub_error`;
  - есть кэш и `now - fetched_at > 24 ч` → `source:"cache"`, `stale:true`, карточки отдаются, но действия
    «Подключить»/«Права» недоступны;
  - кэша нет → `servers:[]`, `source:"cache"`, `stale:true`, `hub_error` заполнен.
  `?refresh=true` не меняет логики, но обходит внутрипроцессный memo (60 с) свежести.
- **S-V4. Отсутствие ключа.** Если в auth-store нет `magnit_prod`, `GET /corp/catalog` возвращает
  `{servers:[], hub_error:"unauthorized"}`; витрина показывает состояние «Требуется вход» с действием,
  открывающим экран входа (S-A6).

### 6.2. Модель состояния карточки

- **S-V5. Источники.** Для каждого `alias` объединяются: карточка каталога Hub (`server.*` +
  `server.connection.*`, §3.2), запись `mcp.<alias>` из действующего конфига (`GET /config`) и локальный
  статус MCP (`GET /mcp`, F14).
- **S-V6. Правило вычисления статуса.** Первое подошедшее:
  | № | Условие | Статус витрины | Действия |
  |---|---|---|---|
  | 1 | `alias` отсутствует в каталоге (в т.ч. скрыт/`unconfigured`), но есть в конфиге | `unavailable` | «Отключить», «Открыть в Hub» |
  | 2 | каталог `stale` (S-V3) | статус по правилам 3–7, действия «Подключить»/«Права» заблокированы | «Открыть в Hub» |
  | 3 | локальный статус `failed` | `unavailable` (подпись — текст ошибки) | «Переподключить», «Отключить» |
  | 4 | локальный статус `needs_auth` \| `needs_client_registration`, либо `connection.status = "needs_reauth"` | `needs_auth` | «Подключить» (повторная авторизация), «Отключить» |
  | 5 | локальный статус `connected` | `connected` | «Права», «Отключить», «Открыть в Hub» |
  | 6 | `mcp.<alias>` есть в конфиге, локальный статус `disabled` | `not_connected` | «Подключить», «Открыть в Hub» |
  | 7 | иначе | `not_connected` | «Подключить», «Открыть в Hub» |
  Карточка с `server.status = "deprecated"` дополнительно получает бейдж «устаревший» независимо от
  статуса; действие «Подключить» на ней доступно только если `alias` уже есть в конфиге (переподключение).
- **S-V7. Действие «Подключить».** По alias `A` и выбранному пресету `P` (по умолчанию `readonly`):
  1. `Config.updateGlobal` (F21) с патчем
     `mcp.<A> = { type:"remote", url:<server.mcp_url>, enabled:true, oauth: { scope:"<A>:<P>" } }`
     для `mode:"facade"`; для `mode:"native"` — то же без ключа `oauth` (D-5);
  2. `POST /mcp/:A/auth/authenticate` (F13/F15) — открывает браузер и ждёт callback 19876;
  3. по завершении — `GET /mcp` и обновление карточки; при `BrowserOpenFailed` — показать URL текстом
     и предложить открыть вручную;
  4. при ошибке OAuth — карточка получает статус по S-V6 (`needs_auth`/`unavailable`), запись
     `mcp.<A>` в конфиге **остаётся** (чтобы повтор был в один клик), сообщение об ошибке показывается.
- **S-V8. Действие «Отключить».** Последовательно: `DELETE /mcp/:A/auth` → `POST /mcp/:A/disconnect` →
  `Config.updateGlobal` с патчем `mcp.<A>.enabled = false` → (если ключ есть и Hub доступен)
  `DELETE {hub}/api/me/connections/<A>`. Отказ Hub на последнем шаге не откатывает локальные шаги, но
  показывается предупреждением. Запись `mcp.<A>` из конфига не удаляется.
- **S-V9. Действие «Права».** Открывает выбор пресета из `permission_model` карточки:
  - `kind:"header_groups"` — пресеты `readonly`/`readwrite` с раскрытием состава групп
    (`groups[].title` с их `preset`, плюс `always`);
  - `kind:"consent"` / `kind:"tool_filter"` — пресеты из `presets`.
  Подтверждение: `PUT {hub}/api/me/connections/<A>/permissions {preset}`; при `mode:"facade"` также
  `Config.updateGlobal` с `mcp.<A>.oauth.scope = "<A>:<preset>"`; если ответ Hub или расширение прав
  требует повторной авторизации (`reauth_required`, I-3 R-B: `readonly → readwrite` даёт `needs_reauth`) —
  сразу запускается шаг 2 из S-V7. Для `mode:"native"` локальный `oauth.scope` не меняется, повторная
  авторизация проходит через экран согласия самого сервера. Отмена на экране прав не меняет ни конфиг,
  ни Hub.
- **S-V10. «Открыть в Hub».** Открывает в браузере `<hub>/ui/servers/<alias>` (I-3 §17); если ссылка
  недоступна (нет `hub_url`) — действие скрыто. При неудаче открытия браузера URL показывается текстом.
- **S-V11. Поиск и группировка.** Поиск — подстрока без учёта регистра по `title`, `alias`,
  `description`, `owner`. Группировка — по `owner`, порядок групп и карточек внутри группы совпадает с
  порядком каталога Hub (I-1 R-A3: «порядок серверов — как в файле»).
- **S-V12. Пустые состояния.** Три различимых состояния: «Каталог пуст» (Hub ответил, `servers:[]`),
  «Hub недоступен» (`hub_error` + нет карточек), «Требуется вход» (S-V4). Каждое — с действием
  («Обновить» / «Обновить» / «Войти»).
- **S-V13. Совместимость `/mcps`.** Upstream-диалог `/mcps` не меняется функционально; в списке рядом с
  alias показывается `title` из кэша каталога, если alias в нём есть (F-08 требования). При отсутствии
  кэша поведение — как в upstream.

---

## 7. Правила: TUI (S-T*)

- **S-T1. Команда витрины.** В `appCommands` (F1) добавляется команда
  `{ name: "corp.connectors", title: <словарь>, category: "Agent", slashName: "connectors",
  slashAliases: ["mcp-catalog"], run: () => dialog.replace(() => <DialogConnectors />) }`; имя
  `corp.connectors` добавляется в `appBindingCommands`. Команда регистрируется только при включённых
  корп-функциях (S-C5).
- **S-T2. Команда входа.** Аналогично — `{ name:"corp.login", slashName:"login", slashAliases:["sso"],
  suggested: !hasCorpKey(), run: () => dialog.replace(() => <DialogCorpLogin />) }`.
- **S-T3. First-run.** Эффект F2 дополняется ветвлением: при выполнении условий S-A7 открывается
  `<DialogCorpLogin />` вместо `<DialogProviderList />`; иначе — прежнее поведение. Диапазон правки —
  тело существующего `createEffect`, без изменения его условия.
- **S-T4. Кнопка «Другой провайдер».** `DialogCorpLogin` содержит действие, открывающее
  `<DialogProviderList />` (тот же компонент, что и upstream).
- **S-T5. Перехват провайдера `magnit_prod`.** В `createDialogProviderOptions`
  (`packages/tui/src/component/dialog-provider.tsx`, F5) в начало `onSelect` добавляется проверка:
  если `providerID === "magnit_prod"` и корп-функции включены — открыть `<DialogCorpLogin />` и выйти.
  Прочие провайдеры обрабатываются без изменений.
- **S-T6. Экран витрины.** `packages/tui/src/component/corp/dialog-connectors.tsx` строится на
  существующем `DialogSelect` (как `dialog-mcp.tsx`, F3): `title` = название карточки, `description` =
  описание + владелец, `footer` = статус витрины (S-V6) цветами темы (`success` для `connected`,
  `warning` для `needs_auth`, `textMuted` для `not_connected`, `error` для `unavailable`), поиск —
  штатный поиск `DialogSelect`. Действия по клавишам: `enter` — «Подключить»/«Переподключить»,
  `d` — «Отключить», `p` — «Права», `o` — «Открыть в Hub», `r` — обновить каталог. Баннер «Hub
  недоступен, данные от <дата>» — строкой над списком.
- **S-T7. Запуск MCP-OAuth из TUI.** Действие «Подключить» вызывает `sdk.client.mcp.auth.authenticate`
  (или корп-роут S-V1, который делает это на сервере) — в upstream TUI такого вызова нет (F3/F4),
  это новая функциональность. Во время ожидания карточка показывает «⋯ Авторизация в браузере»,
  список не блокируется целиком; параллельный запуск второго подключения запрещён (как в `dialog-mcp.tsx`).
- **S-T8. Экран входа.** `packages/tui/src/component/corp/dialog-corp-login.tsx` реализует шаги S-A6;
  выбор команды — вложенный `DialogSelect`; копирование кода — по клавише `c` (как в `AutoMethod`, F6).
- **S-T9. Отсутствие регрессии.** Команды `mcps`, `connect`, `status`, `models`, `agents` и их слэш-имена
  остаются прежними; `dialog-mcp.tsx` меняется только в части S-V13 (подпись `title`).

---

## 8. Правила: Desktop и web (S-D*)

- **S-D1. Команда витрины.** В `command.register("layout", …)` (`packages/app/src/pages/layout.tsx`, F9/F10)
  добавляется команда `{ id: "corp.connectors", title: t("corp.connectors.title"),
  description: t("corp.connectors.description"), slash: "connectors", category: t("command.category.…"),
  onSelect: openConnectors }`, где `openConnectors()` лениво импортирует
  `@/components/corp/dialog-connectors` по образцу `connectProvider()`/`openServer()`. Команда
  регистрируется только при включённых корп-функциях (S-C5).
- **S-D2. Диалог, а не маршрут.** Витрина — полноэкранный диалог, а не URL-маршрут: сегмент верхнего
  уровня `/:dir` (F11) перехватывает произвольные пути, и добавление `/connectors` в роутер потребовало бы
  правки порядка маршрутов приложения. Решение D-4.
- **S-D3. Команда и экран входа.** Аналогично: команда `corp.login` (`slash: "login"`) и диалог
  `@/components/corp/dialog-corp-login`, реализующий шаги S-A6.
- **S-D4. Getting Started.** Блок Getting Started (F10) при включённых корп-функциях и отсутствии ключа
  `magnit_prod` показывает первичной кнопкой «Войти через корпоративный SSO» (`onClick=openCorpLogin`), а
  «Подключить провайдера» — вторичной. Условие видимости самого блока не меняется.
- **S-D5. Перехват провайдера.** В `dialog-select-provider.tsx` / `dialog-connect-provider.tsx` выбор
  провайдера `magnit_prod` при включённых корп-функциях открывает корп-экран входа вместо ввода API-ключа.
- **S-D6. Витрина.** `packages/app/src/components/corp/dialog-connectors.tsx` строится на `Dialog` +
  `List` (как `dialog-select-mcp.tsx`, F7): поиск (`search.placeholder`), группировка по владельцу,
  карточка = `title`, `description`, `owner`, бейдж статуса (S-V6), бейдж «устаревший», подпись пресета;
  действия — кнопки «Подключить», «Отключить», «Права», «Открыть в Hub». Баннер «Hub недоступен» и
  пустые состояния — по S-V12.
- **S-D7. Обновление данных.** Действия витрины выполняются мутациями поверх корп-роутов; после каждой —
  инвалидация `GET /mcp` и `GET /corp/catalog` (тем же механизмом, что `useMcpToggle` → `refresh`, F8).
- **S-D8. Electron.** Открытие браузера для OAuth и `browser_url` выполняется серверной частью (F15) либо
  штатным механизмом Desktop; корп-код не открывает внешние ссылки в окне приложения.
- **S-D9. `opencode web`.** Тот же UI `packages/app`, отдельных правок не требует; корп-роуты доступны с
  того же сервера.

---

## 9. Правила: локализация (S-I*)

- **S-I1. Ключи корп-текстов в `packages/app`.** Все наши строки добавляются в `packages/app/src/i18n/en.ts`
  и `packages/app/src/i18n/ru.ts` под префиксом `corp.` (`corp.login.*`, `corp.connectors.*`,
  `corp.status.*`, `corp.error.*`, `corp.preset.*`). Ключи в обоих словарях совпадают полностью.
- **S-I2. Русский по умолчанию.** В `packages/app/src/context/language.tsx` (F28) значения по умолчанию
  `detectLocale()` и `normalizeLocale()` возвращают `"ru"` вместо `"en"`, если корп-функции включены;
  явный выбор пользователя (`localStorage`/cookie `oc_locale`) и совпадение с `navigator.languages`
  имеют приоритет. При выключенных корп-функциях — прежнее поведение (`"en"`).
- **S-I3. Тест словарей.** Существующий `packages/app/src/i18n/parity.test.ts` (F29) продолжает
  проходить; дополнительно наш тест проверяет, что множества ключей с префиксом `corp.` в `en.ts` и
  `ru.ts` совпадают и что ни одно значение в `ru.ts` не равно значению `en.ts` (нет забытых переводов).
- **S-I4. Словарь TUI.** Новый файл `packages/tui/src/corp/i18n.ts` — плоский объект
  `{ ru: {…}, en: {…} }` и функция `t(key)`; язык выбирается из `OPENCODE_CORP_LANG` (`ru`/`en`), иначе
  `ru` при включённых корп-функциях, иначе `en`. Используется **только** нашими экранами; upstream-строки
  TUI не трогаем.
- **S-I5. Полнота.** Все пользовательские тексты корп-экранов (заголовки, статусы, действия, ошибки
  S-A5, пустые состояния S-V12) есть в обоих языках; в коде нет захардкоженных русских строк вне словарей.

---

## 10. Правила: сборка, CI, синхронизация с upstream (S-B*)

- **S-B1. Версия.** Версия корп-сборки = `<версия upstream>-magnit.<N>` (например `1.17.9-magnit.1`), где
  `N` берётся из `corp/version` или env `CORP_BUILD` (по умолчанию `1`). Значение подставляется в
  `OPENCODE_VERSION` (F25) и в `version` пакетов Desktop при сборке; исходные `package.json` upstream не
  правятся вручную.
- **S-B2. `corp/build.ts`.** Один вход: `bun run corp/build.ts [--targets …] [--desktop] [--skip-cli]`.
  Собирает CLI (`packages/opencode/script/build.ts`) для `darwin-arm64`, `darwin-x64`, `linux-x64`,
  `win32-x64`, кладёт `dist/opencode-<os>-<arch>/bin/opencode` и zip-архив каждого,
  печатает sha256 артефактов. Перед сборкой проверяет и передаёт `OPENCODE_CORP_HUB_URL` и
  `OPENCODE_CORP_CONFIG` (S-C2); при отсутствии `CORP_HUB_URL` — предупреждение «собирается ванильная
  сборка» и продолжение (S-C6).
- **S-B3. Desktop.** `corp/build.ts --desktop` вызывает `bun --cwd packages/desktop package:mac`
  (mac-arm64) и `package:win` (win-x64) с тем же `OPENCODE_CHANNEL` и версией S-B1. Windows-сборка
  выполняется на Windows-стенде или в CI; на macOS команда `--desktop --win` завершается понятной
  ошибкой, а не молчаливым пропуском.
- **S-B4. Публикация.** Артефакты публикуются в GitHub Releases приватного форка тегом
  `v<версия S-B1>`; в описании релиза — список артефактов и их sha256. Скрипт не публикует
  автоматически без явного флага `--publish`.
- **S-B5. `corp/upstream-sync.sh`.** Шаги: `git fetch upstream --tags` → проверка чистого рабочего дерева →
  `git rebase <тег>` рабочей ветки → `bun install` → `bun run typecheck` → `bun --cwd packages/opencode test`
  и `bun --cwd packages/tui test` (наши тесты) → отчёт: список конфликтов (если rebase остановился),
  список изменённых upstream-файлов из `corp/patches.md`, которые затронул апдейт. Ненулевой код выхода
  при конфликте, падении typecheck или тестов. Скрипт ничего не пушит.
- **S-B6. `corp/patches.md`.** Таблица: файл upstream → правило спецификации → причина → коммит.
  Обновляется в том же коммите, что и правка upstream-файла (проверяется правилом ревью, а также
  тестом S-Q7).
- **S-B7. CI на PR в `main`.** GitHub Actions: `bun install` → `bun run typecheck` → тесты пакетов
  `opencode`, `tui`, `app` → сборка CLI для `darwin-arm64`, `linux-x64`, `win32-x64` → smoke
  (`opencode --version` для сборки текущей ОС, F25). Ошибка любого шага валит PR.
- **S-B8. CI по тегу.** По тегу `v*-magnit.*` дополнительно собирается Desktop (mac-arm64 на macOS-раннере,
  win-x64 на Windows-раннере) и создаётся черновик GitHub Release с артефактами.
- **S-B9. Подпись.** Подпись Windows Authenticode и macOS Developer ID/notarization в I-4 не
  выполняется: конфигурация `electron-builder` не меняется, `script/sign-windows.ps1` остаётся
  upstream-логикой (срабатывает только в GitHub Actions на win32). **[проверить]** — решение ИБ,
  открытый вопрос §4.3 требования.

---

## 11. Правила: тесты (S-Q*)

- **S-Q1. Размещение.** Тесты лежат рядом с модулями (`*.test.ts` в тех же каталогах) и запускаются
  существующими скриптами пакетов (`bun test`, F31). Корневой `bun test` не используется (F32).
- **S-Q2. Клиент Hub.** Модульные тесты `packages/opencode/src/corp/hub.test.ts` с моками HTTP (без сети):
  успешные ответы `/cli/start`, `/cli/poll`, `/api/catalog`, `/api/me`, `/api/me/connections`,
  `PUT/DELETE /api/me/connections/*`; ветки `pending`, `team_selection_required`, `ready`;
  ошибки 400/401/403/404/409/429/502; тело, не соответствующее схеме; таймаут и сетевая ошибка;
  проверка заголовков (`Authorization`, `X-Hub-Poll-Secret`) и того, что `poll_secret` не попадает в
  ответы наружу.
- **S-Q3. Флоу входа.** Тесты `packages/opencode/src/corp/login.test.ts`: полный путь
  `start → pending → team_selection_required → team → pending → ready` с записью в auth-store (мок
  `Auth.set`); ветка одной команды; `login_expired`; `forbidden`; отмена сессии; отсутствие ключа в логах.
- **S-Q4. Витрина.** Тесты `packages/opencode/src/corp/connectors.test.ts`: таблица S-V6 (по одному
  случаю на строку), `connect` пишет ожидаемый патч конфига для `facade` и для `native`, `disconnect`
  выполняет три локальных шага и переживает отказ Hub, «Права» формируют корректный `oauth.scope`
  и признак `reauth_required`.
- **S-Q5. Кэш.** Тесты `packages/opencode/src/corp/catalog-cache.test.ts` с подменяемыми часами: запись и
  чтение, свежий кэш (< 24 ч), протухший (> 24 ч, `stale:true`), отсутствие кэша, повреждённый файл
  (трактуется как отсутствие), права файла `0o600`, изоляция кэшей разных `hub_url`.
- **S-Q6. Корп-слой конфига.** Тесты рядом с `packages/opencode/src/corp/config.ts`: корп-слой ниже
  `.well-known` и ниже глобального конфига; отсутствие констант = отсутствие слоя; невалидный JSON не
  роняет загрузку.
- **S-Q7. Реестр правок.** Тест `corp/patches.test.ts` (запускается в пакете `opencode`): множество
  upstream-файлов, изменённых относительно базового тега (`git diff --name-only <base>`), совпадает с
  множеством файлов, перечисленных в `corp/patches.md`. **[проверить]** — базовый тег берётся из
  `corp/upstream-base`.
- **S-Q8. Smoke.** В CI: собранный бинарник отвечает на `--version` (строка вида `1.17.9-magnit.N`) и на
  `opencode corp status --hub <адрес мока>` печатает адрес Hub и «ключ: нет» с кодом выхода `1`,
  а с подложенным auth-store — «ключ: есть» с кодом `0`.
- **S-Q9. UI.** Тесты словарей (S-I3) и unit-тест функции вычисления статуса карточки, вынесенной в
  чистый модуль (`packages/opencode/src/corp/status.ts`), общий для TUI и app.

---

## 12. Принятые решения по неоднозначностям

- **D-1. Plugin-hook `auth` недостаточен для входа по SSO.** Причины из кода: (а) контракт
  `AuthOAuthResult` (F23) — только `authorize() → {url, instructions}` и один `callback()`, без
  промежуточного шага; выбор команды при `team_selection_required` (I-1 R-L3, где правило «первая по
  умолчанию» **запрещено**) выразить нечем; (б) TUI-экран `AutoMethod` (F6) вызывает `callback()` один
  раз в `onMount` и не умеет ничего спросить; (в) плагин не может добавить HTTP-маршрут (F23), а браузерный
  UI (`packages/app`) не может ходить в Hub напрямую — CORS в Hub не включён (I-1 R-A7). Поэтому вход
  реализуется корп-роутами (S-A1) и корп-экранами (S-A6) с минимальными патчами `app.tsx` (S-T3),
  `dialog-provider.tsx` (S-T5), `layout.tsx` (S-D4) и диалогов провайдера в `packages/app` (S-D5).
  `corp/plugin/` сохраняется как место для будущих хуков (`config`, `tool`), в I-4 не подключается.
- **D-2. Все обращения к Hub — через серверную часть бинарника.** Единая точка для ключа, кэша, таймаутов
  и сокрытия `poll_secret`; UI (TUI и app) знает только корп-роуты.
- **D-3. Ключ провайдера хранится как `api`-запись `magnit_prod`** (`Auth.set`, F22), а не как
  `wellknown`: `wellknown` предназначен для автозагрузки удалённого конфига и требует пары `key/token`;
  корп-слой умолчаний мы даём build-константами (S-C3), а `.well-known` Hub остаётся доступным
  дополнительно и продолжает работать по upstream-логике.
- **D-4. Витрина — полноэкранный диалог, а не URL-маршрут `/connectors`** (S-D2), из-за динамического
  сегмента `/:dir` в роутере приложения (F11). Слэш-команда `/connectors` и пункт палитры сохраняются —
  для пользователя вход в витрину выглядит так же, как задумано.
- **D-5. `oauth.scope` пишем только для `mode: "facade"`** — Hub как AS объявляет
  `scopes_supported = ["<alias>:readonly","<alias>:readwrite"]` (I-3 R-O1/R-O5). Для `mode:"native"`
  (`permission_model.kind:"consent"`) scope не задаём: права выбираются экраном согласия сервера, а
  публичное представление каталога не отдаёт scopes целевой системы (I-1 R-C6).
- **D-6. Пресет по умолчанию — `readonly`** (I-1 `catalog.yaml` `defaults.permission_presets.readonly.default:
  true`, I-3 R-49: scope по умолчанию `<alias>:readonly`).
- **D-7. `enabled` персистится через `Config.updateGlobal`** (F21), а не через `POST /mcp/:name/connect`
  (F17 — только runtime). Пишем в глобальный конфиг пользователя, а не в конфиг проекта.
- **D-8. Имена MCP-инструментов для `permission`/`tools` — `<alias>_<tool>` с сохранением дефисов в
  alias** (F19): `sanitize` заменяет только символы вне `[A-Za-z0-9_-]`. Закрывает открытый вопрос §4.2
  требования; Hub в `remote-config` должен формировать маски в этом же виде (например
  `gitlab-platform_*`). **[проверить]** — согласовать с реализацией Hub.
- **D-9. Подпись сборок — вне объёма I-4** (S-B9), открытый вопрос §4.3 требования остаётся за ИБ;
  спецификация не блокируется.
- **D-10. Ванильный режим — первоклассный сценарий** (S-C5/S-C6): все корп-возможности выключаются одним
  условием (нет адреса Hub), что даёт дешёвую проверку «не сломали upstream» и упрощает rebase.
- **D-11. Статус `failed` отображается как `unavailable` с текстом ошибки** (S-V6, строка 3): человек
  зафиксировал четыре значения статуса витрины, а `failed` семантически ближе к «недоступен», чем к
  «требуется авторизация».
- **D-12. Кэш каталога не заменяет запрос**: витрина всегда пытается сходить в Hub, кэш — только
  деградация (S-V3). TTL 24 ч управляет не «когда обновлять», а «когда данные считать протухшими».

---

## 13. Открытые вопросы требования (§4) — состояние

| № | Вопрос | Состояние |
|---|---|---|
| 1 | Достаточно ли plugin-hook `auth` для first-run | **Закрыт**: недостаточен, обоснование D-1 (F6, F23, I-1 R-L3, I-1 R-A7) |
| 2 | Формат имён MCP-инструментов (`alias_tool` vs `alias-tool`) | **Закрыт по коду**: `sanitize(alias) + "_" + sanitize(tool)`, дефисы в alias сохраняются (F19, D-8). Требуется согласование с Hub — **[проверить]** |
| 3 | Подпись сборок | **Параметризован**: вне объёма I-4, S-B9, D-9 — **[проверить]** (решение ИБ) |

Прочие **[проверить]** этой спецификации: приём Hub loopback-HTTP `redirect_uri` при DCR (§3.3);
базовый тег для теста реестра правок (S-Q7).
