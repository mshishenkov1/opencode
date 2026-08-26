import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import * as CorpCatalogCache from "@/corp/catalog-cache"
import * as CorpConfig from "@/corp/config"
import * as CorpConnections from "@/corp/connections"
import * as CorpConnectors from "@/corp/connectors"
import * as CorpErrors from "@/corp/errors"
import * as CorpHub from "@/corp/hub"
import * as CorpLogin from "@/corp/login"
import * as CorpSchema from "@/corp/schema"
import * as CorpStatus from "@/corp/status"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { CORP_PROVIDER_ID, corpUserEmail } from "@opencode-ai/core/corp/constants"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import open from "open"
import { InstanceHttpApi } from "../api"
import { CorpBadRequestError, CorpDisabledError, CorpHubError } from "../groups/corp"

/**
 * Обработчики корп-роутов (S-A1…S-A5, S-V1…S-V10).
 *
 * Все обращения к Hub выполняются здесь, на серверной стороне бинарника (D-2). Ключ провайдера и
 * `poll_secret` наружу не отдаются и в логи не пишутся.
 */

/**
 * Пользователь в ответах корп-роутов (S-A1, S-A13).
 *
 * Hub может прислать `email` отсутствующим или `null` — наружу неизвестный email отдаётся отсутствием
 * поля: клиентам не приходит ни `null`, ни пустая строка, показывать им нечего кроме `user_id`.
 */
function publicUser(user: CorpSchema.HubUser): CorpSchema.HubUser {
  const email = corpUserEmail(user)
  return { user_id: user.user_id, ...(email === undefined ? {} : { email }) }
}

/** Свежесть внутрипроцессного memo каталога (S-V3). */
const CATALOG_MEMO_MS = 60_000

/**
 * Memo каталога на процесс сервера.
 *
 * Ключ — рабочий каталог инстанса, workspace и адрес Hub: карточки зависят от конфига и локальных
 * статусов MCP конкретного инстанса (S-V5), а один процесс обслуживает несколько рабочих каталогов
 * (InstanceContextMiddleware). Общий ключ отдал бы второму каталогу карточки, посчитанные для первого.
 */
const memo = new Map<string, { at: number; view: CorpSchema.CatalogView }>()

export const corpHandlers = HttpApiBuilder.group(InstanceHttpApi, "corp", (handlers) =>
  Effect.gen(function* () {
    const authSvc = yield* Auth.Service
    const configSvc = yield* Config.Service
    const mcpSvc = yield* MCP.Service

    const hubUrl = () => CorpConfig.corpHubUrl()

    const requireHub = Effect.fnUntraced(function* () {
      const url = hubUrl()
      if (!url) return yield* new CorpDisabledError({ error: "corp_disabled" })
      return url
    })

    /** Ключ провайдера `magnit_prod` из auth-store (D-3); наружу не отдаётся. */
    const corpKey = Effect.fnUntraced(function* () {
      const record = yield* authSvc.get(CORP_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
      return record?.type === "api" ? record.key : undefined
    })

    /** Ключ memo каталога: инстанс (рабочий каталог + workspace) и адрес Hub. */
    const memoKey = Effect.fnUntraced(function* (url: string) {
      const instance = yield* InstanceRef
      const workspace = yield* WorkspaceRef
      return [instance?.directory ?? "", workspace ?? "", url].join("\u0000")
    })

    /** Сбрасывает memo текущего инстанса после действий витрины (S-V7…S-V9). */
    const dropMemo = Effect.fnUntraced(function* (url: string) {
      memo.delete(yield* memoKey(url))
    })

    // --- Вход (S-A2…S-A5) ---

    const loginStart = Effect.fn("CorpHttpApi.loginStart")(function* () {
      const url = yield* requireHub()
      const hub = CorpHub.make({ hubUrl: url })
      const started = yield* Effect.promise(() => hub.cliStart(CorpHub.clientDescriptor(InstallationVersion)))
      if (!started.ok) {
        // S-A5: наружу уходит только стабильный код (+ Retry-After), текст Hub не пересылается.
        return yield* new CorpHubError({
          error: started.code,
          ...(started.retryAfter === undefined ? {} : { retry_after: started.retryAfter }),
        })
      }
      const session = CorpLogin.store.create({
        loginId: started.data.login_id,
        pollSecret: started.data.poll_secret,
        hubUrl: url,
        expiresIn: started.data.expires_in,
      })
      // S-A6 шаг 2, S-D8: браузер открывает серверная часть — тем же механизмом, что MCP-OAuth (F15).
      // Экран входа всё равно показывает `browser_url` и код: если открыть не удалось, вход
      // продолжается вручную по ссылке.
      yield* Effect.promise(() =>
        open(started.data.browser_url)
          .then(() => undefined)
          .catch(() => undefined),
      )
      return CorpLogin.publicView(session, started.data.user_code, started.data.browser_url)
    })

    /** Общая обработка ответа Hub на опрос: сохранение ключа при `ready` (S-A3). */
    const handlePoll = Effect.fnUntraced(function* (
      session: CorpLogin.Session,
      result: CorpHub.Result<CorpSchema.CliPoll>,
    ) {
      if (!result.ok) {
        let code: CorpErrors.Code = result.code
        if (code === "hub_unavailable" || code === "litellm_unavailable") {
          session.hubErrors += 1
          // S-A4: сетевая ошибка и 502 не прекращают опрос — до пяти подряд.
          if (session.hubErrors < CorpLogin.MAX_CONSECUTIVE_HUB_ERRORS) return { status: "pending" as const }
          // Бюджет исчерпан: наружу всегда hub_unavailable, независимо от последнего кода Hub.
          code = "hub_unavailable"
          CorpLogin.store.drop(session.loginId)
        }
        if (code === "login_expired" || code === "forbidden") CorpLogin.store.drop(session.loginId)
        return {
          status: "error" as const,
          error: code,
          message: `hub responded with ${code}`,
          ...(result.retryAfter === undefined ? {} : { retry_after: result.retryAfter }),
        }
      }
      session.hubErrors = 0
      const data = result.data
      if (data.status === "pending") return { status: "pending" as const }
      if (data.status === "team_selection_required") {
        session.teams = data.teams
        return { status: "team_selection_required" as const, teams: data.teams }
      }
      yield* authSvc
        .set(CORP_PROVIDER_ID, {
          type: "api",
          key: data.key,
          metadata: CorpLogin.authMetadata({
            hubUrl: session.hubUrl,
            keyKind: data.key_kind,
            userId: data.user.user_id,
            ...(data.team_id === undefined ? {} : { teamId: data.team_id }),
          }),
        })
        .pipe(Effect.orDie)
      CorpLogin.store.drop(session.loginId)
      yield* configSvc.invalidate()
      return { status: "ready" as const, user: publicUser(data.user), key_kind: data.key_kind }
    })

    const loginPoll = Effect.fn("CorpHttpApi.loginPoll")(function* (ctx: { params: { loginID: string } }) {
      yield* requireHub()
      const session = CorpLogin.store.get(ctx.params.loginID)
      if (!session)
        return {
          status: "error" as const,
          error: "login_expired" as CorpErrors.Code,
          message: "login session is unknown or expired",
        }
      const hub = CorpHub.make({ hubUrl: session.hubUrl })
      const result = yield* Effect.promise(() => hub.cliPoll(session.loginId, session.pollSecret))
      return yield* handlePoll(session, result)
    })

    const loginTeam = Effect.fn("CorpHttpApi.loginTeam")(function* (ctx: {
      params: { loginID: string }
      payload: { team_id: string }
    }) {
      yield* requireHub()
      const session = CorpLogin.store.get(ctx.params.loginID)
      if (!session)
        return {
          status: "error" as const,
          error: "login_expired" as CorpErrors.Code,
          message: "login session is unknown or expired",
        }
      const hub = CorpHub.make({ hubUrl: session.hubUrl })
      const result = yield* Effect.promise(() => hub.cliTeam(session.loginId, session.pollSecret, ctx.payload.team_id))
      return yield* handlePoll(session, result)
    })

    /** S-A9: закрытие экрана входа освобождает сессию (вместе с `poll_secret`) в памяти сервера. */
    const loginCancel = Effect.fn("CorpHttpApi.loginCancel")(function* (ctx: { params: { loginID: string } }) {
      yield* requireHub()
      const known = CorpLogin.store.get(ctx.params.loginID) !== undefined
      CorpLogin.store.drop(ctx.params.loginID)
      return { cancelled: known }
    })

    // --- Статус (S-A11) ---

    const status = Effect.fn("CorpHttpApi.status")(function* () {
      const url = hubUrl()
      const key = yield* corpKey()
      if (!url) return { enabled: false, authenticated: false }
      const cached = yield* Effect.promise(() => CorpCatalogCache.read(url))
      const base: CorpSchema.CorpStatus = {
        hub_url: url,
        enabled: true,
        authenticated: key !== undefined,
        ...(cached === undefined
          ? {}
          : {
              catalog_version: cached.version,
              catalog_cached_at: cached.fetchedAt,
              catalog_stale: CorpCatalogCache.isStale(cached, Date.now()),
            }),
      }
      if (!key) return base
      const hub = CorpHub.make({ hubUrl: url, key })
      const health = yield* Effect.promise(() => hub.health())
      const me = yield* Effect.promise(() => hub.me())
      if (!me.ok) return { ...base, hub_reachable: health.ok, hub_error: me.code }
      return {
        ...base,
        hub_reachable: health.ok,
        // S-A13: email может быть неизвестен — тогда поле не проставляется вовсе (без `null` наружу).
        user: publicUser(me.data),
        ...(me.data.key_kind === undefined ? {} : { key_kind: me.data.key_kind }),
      }
    })

    // --- Витрина (S-V1…S-V6) ---

    /** Локальные статусы MCP и записи `mcp.<alias>` действующего конфига (S-V5). */
    const localState = Effect.fnUntraced(function* () {
      const statuses = yield* mcpSvc.status()
      const config = yield* configSvc.get()
      // S-V23: раздел `permission` действующего (слитого) конфига — по нему считается permission_state.
      return {
        statuses,
        configured: new Set(Object.keys(config.mcp ?? {})),
        permission: config.permission,
      }
    })

    /**
     * Признак «подключение состоялось» (S-V15).
     *
     * Читается один раз на построение витрины; повреждённый файл трактуется как отсутствующий и
     * пишет предупреждение в лог, не мешая открыть витрину (S-V15 п.4, AC-179).
     */
    const readConnections = Effect.fnUntraced(function* (url: string) {
      const result = yield* Effect.promise(() => CorpConnections.read(url))
      if (result.corrupted)
        yield* Effect.logWarning("corp connections: файл признака подключений нечитаем, считается отсутствующим", {
          file: CorpConnections.fileFor(url),
        })
      return result.entry
    })

    /**
     * Записывает наблюдения признака (S-V15 п.2): локальный `connected` и запись подключения Hub.
     * `connected_at` первого наблюдения не меняется, повторные подключения файл не трогают.
     */
    const rememberConnections = Effect.fnUntraced(function* (
      entry: CorpConnections.Entry,
      observations: Iterable<string>,
    ) {
      const next = CorpConnections.remember(entry, observations)
      if (!next) return entry
      yield* Effect.promise(() => CorpConnections.write(next))
      return next
    })

    const toCards = Effect.fnUntraced(function* (url: string, servers: CorpSchema.CatalogServer[], stale: boolean) {
      const { statuses, configured, permission } = yield* localState()
      const known = new Set(servers.map((server) => server.alias))
      // S-V20: группы, выброшенные разбором словаря, — та же новость, что отброшенные карточки,
      // и доезжает до пользователя тем же полем `dropped` (`corp.connectors.partial`).
      const dropped: CorpSchema.Dropped[] = []

      // S-V15: сначала фиксируем наблюдения этого построения витрины, потом считаем по ним карточки —
      // иначе признак у только что подключённого сервера появился бы лишь со следующего открытия.
      const observations: string[] = []
      for (const server of servers)
        if (
          CorpConnections.observed({
            ...(statuses[server.alias] === undefined ? {} : { local: statuses[server.alias]!.status }),
            ...(server.connection === undefined ? {} : { connection: server.connection.status }),
          })
        )
          observations.push(server.alias)
      for (const alias of configured)
        if (!known.has(alias) && statuses[alias]?.status === "connected") observations.push(alias)
      const connections = yield* rememberConnections(yield* readConnections(url), observations)

      const cards: CorpSchema.CatalogCard[] = servers.map((server) => {
        const local = statuses[server.alias]
        const permissions = CorpSchema.parsePermissionModel(server.permission_model)
        const groups = CorpSchema.parsePermissionGroups(server.permission_groups)
        if (groups && groups.dropped > 0)
          for (let index = 0; index < groups.dropped; index++)
            dropped.push({ alias: server.alias, reason: "permission_groups.group" })
        const card = CorpStatus.compute({
          alias: server.alias,
          server,
          configured: configured.has(server.alias),
          ...(local === undefined ? {} : { local: local.status }),
          ...(local && "error" in local ? { localError: local.error } : {}),
          everConnectedLocally: CorpConnections.has(connections, server.alias),
          stale,
        })
        return {
          alias: server.alias,
          title: server.title,
          ...(server.description === undefined ? {} : { description: server.description }),
          ...(server.owner === undefined ? {} : { owner: server.owner }),
          ...(server.contact === undefined ? {} : { contact: server.contact }),
          ...(server.docs_url === undefined ? {} : { docs_url: server.docs_url }),
          ...(server.status === undefined ? {} : { server_status: server.status }),
          // S-V22: значение колонки «Тип» — данные каталога; деградацию `type` → `owner` → пусто
          // делает оболочка, у которой есть оба поля.
          ...(server.type === undefined ? {} : { type: server.type }),
          mode: server.mode,
          mcp_url: server.mcp_url,
          // Наружу уходит разобранная модель прав; непонятый вид — как отсутствующий, экран прав
          // блокируется с причиной (S-V9, S-V14 п.3). Дословное значение остаётся в кэше.
          ...(permissions === undefined ? {} : { permission_model: permissions }),
          // S-V20: разобранный словарь групп; неразобранный — как отсутствующий, экран деградирует
          // на прежний вид по `permission_model`. S-V23: действующий режим групп считает сервер.
          ...(groups === undefined
            ? {}
            : {
                permission_groups: groups.groups,
                permission_state: CorpConnectors.permissionState(server.alias, groups.groups, permission),
              }),
          ...(server.connection === undefined ? {} : { connection_status: server.connection.status }),
          ...(server.connection?.preset === undefined ? {} : { preset: server.connection.preset }),
          status: card.status,
          actions: card.actions,
          state: card.state,
          ever_connected: card.everConnected,
          deprecated: card.deprecated,
          blocked: card.blocked,
          configured: configured.has(server.alias),
          ...(card.error === undefined ? {} : { error: card.error }),
          ...(card.errorClass === undefined ? {} : { error_class: card.errorClass }),
          hub_url: CorpConnectors.hubServerUrl(url, server.alias),
        }
      })
      // Правило 1 S-V6: alias есть в конфиге, но пропал из каталога — карточку всё равно показываем.
      for (const alias of configured) {
        if (known.has(alias)) continue
        const local = statuses[alias]
        const card = CorpStatus.compute({
          alias,
          configured: true,
          stale,
          ...(local ? { local: local.status } : {}),
          everConnectedLocally: CorpConnections.has(connections, alias),
        })
        cards.push({
          alias,
          title: alias,
          status: card.status,
          actions: card.actions,
          state: card.state,
          ever_connected: card.everConnected,
          deprecated: false,
          blocked: card.blocked,
          configured: true,
          ...(card.error === undefined ? {} : { error: card.error }),
          ...(card.errorClass === undefined ? {} : { error_class: card.errorClass }),
          hub_url: CorpConnectors.hubServerUrl(url, alias),
        })
      }
      return { cards, dropped }
    })

    const catalog = Effect.fn("CorpHttpApi.catalog")(function* (ctx: { query: { refresh?: string } }) {
      const url = yield* requireHub()
      const refresh = ctx.query.refresh === "true"
      const now = Date.now()
      const key = yield* memoKey(url)
      const cachedView = memo.get(key)
      if (!refresh && cachedView && now - cachedView.at < CATALOG_MEMO_MS) return cachedView.view

      const corpApiKey = yield* corpKey()
      if (!corpApiKey) {
        // S-V4: без ключа витрина показывает состояние «Требуется вход».
        return { version: "", source: "cache" as const, stale: true, servers: [], hub_error: "unauthorized" as const }
      }

      const hub = CorpHub.make({ hubUrl: url, key: corpApiKey })
      const fresh = yield* Effect.promise(() => hub.catalog())
      if (fresh.ok) {
        const built = yield* toCards(url, fresh.data.servers, false)
        // S-V14 п.5 и S-V20: отброшенные карточки и выброшенные группы словаря — один список.
        const dropped = [...(fresh.dropped ?? []), ...built.dropped]
        if (dropped.length > 0) {
          // S-V14 п.5: отброшенные карточки не исчезают молча. В лог уходят только alias и путь к
          // полю — ни тела ответа Hub, ни ключа провайдера, ни `poll_secret`.
          yield* Effect.logWarning("corp catalog: cards dropped", {
            count: dropped.length,
            cards: dropped.map((entry) => ({
              ...(entry.alias === undefined ? {} : { alias: entry.alias }),
              field: entry.reason,
            })),
          })
        }
        yield* Effect.promise(() =>
          CorpCatalogCache.write({
            hubUrl: url,
            fetchedAt: now,
            version: fresh.data.version,
            servers: fresh.data.servers,
          }),
        )
        const view: CorpSchema.CatalogView = {
          version: fresh.data.version,
          source: "hub",
          cached_at: now,
          stale: false,
          servers: built.cards,
          ...(dropped.length === 0 ? {} : { dropped }),
        }
        // Записи других инстансов старше окна свежести больше не нужны — memo не растёт бесконечно.
        for (const [entry, value] of memo) if (now - value.at >= CATALOG_MEMO_MS) memo.delete(entry)
        memo.set(key, { at: now, view })
        return view
      }

      // Деградация на кэш (S-V3, D-12).
      const cached = yield* Effect.promise(() => CorpCatalogCache.read(url))
      if (!cached) {
        return {
          version: "",
          source: "cache" as const,
          stale: true,
          servers: [],
          hub_error: fresh.code,
        }
      }
      const stale = CorpCatalogCache.isStale(cached, now)
      const built = yield* toCards(url, cached.servers, stale)
      return {
        version: cached.version,
        source: "cache" as const,
        cached_at: cached.fetchedAt,
        stale,
        servers: built.cards,
        ...(built.dropped.length === 0 ? {} : { dropped: built.dropped }),
        hub_error: fresh.code,
      }
    })

    /**
     * Карточка каталога по alias — из свежего ответа Hub, иначе из кэша.
     * Вместе с карточкой возвращается признак протухшего источника (S-V3), нужный правилу 2 S-V6.
     */
    const serverFor = Effect.fnUntraced(function* (url: string, alias: string) {
      const key = yield* corpKey()
      if (key) {
        const hub = CorpHub.make({ hubUrl: url, key })
        const fresh = yield* Effect.promise(() => hub.catalog())
        if (fresh.ok) return { server: fresh.data.servers.find((server) => server.alias === alias), stale: false }
      }
      return yield* cachedServerFor(url, alias)
    })

    /**
     * Карточка каталога **только из кэша** (S-V3).
     *
     * Нужна действиям, которым обращаться к Hub запрещено: у вида `permission_groups` запроса к Hub
     * не выполняется вовсе (S-V1, D-35), а словарь групп взять всё равно откуда-то надо.
     */
    const cachedServerFor = Effect.fnUntraced(function* (url: string, alias: string) {
      const cached = yield* Effect.promise(() => CorpCatalogCache.read(url))
      if (!cached) return { server: undefined, stale: true }
      return {
        server: cached.servers.find((server) => server.alias === alias),
        stale: CorpCatalogCache.isStale(cached, Date.now()),
      }
    })

    /**
     * Статус карточки после действия витрины (S-V1, S-V6).
     *
     * Считается тем же правилом и по тем же источникам, что и `toCards`: карточка каталога берётся
     * заново (действие меняет состояние подключения в Hub), локальные данные — из `GET /mcp` и конфига.
     * Без карточки каталога сработало бы правило 1 таблицы S-V6 и статус всегда был бы `unavailable`.
     *
     * `source` — уже прочитанная карточка: им пользуются действия, которым запрещено ходить в Hub.
     */
    const cardFor = Effect.fnUntraced(function* (
      url: string,
      alias: string,
      source?: { server: CorpSchema.CatalogServer | undefined; stale: boolean },
    ) {
      const { server, stale } = source ?? (yield* serverFor(url, alias))
      const { statuses, configured } = yield* localState()
      const local = statuses[alias]
      // S-V15: наблюдение фиксируется и после отдельного действия — состояние карточки в ответе
      // действия обязано совпадать с тем, что покажет следующее открытие витрины.
      const observed = CorpConnections.observed({
        ...(local === undefined ? {} : { local: local.status }),
        ...(server?.connection === undefined ? {} : { connection: server.connection.status }),
      })
      const connections = yield* rememberConnections(yield* readConnections(url), observed ? [alias] : [])
      return CorpStatus.compute({
        alias,
        ...(server === undefined ? {} : { server }),
        configured: configured.has(alias),
        ...(local === undefined ? {} : { local: local.status }),
        ...(local && "error" in local ? { localError: local.error } : {}),
        everConnectedLocally: CorpConnections.has(connections, alias),
        stale,
      }).status
    })

    // --- Действия витрины (S-V7…S-V9) ---

    const connect = Effect.fn("CorpHttpApi.connect")(function* (ctx: {
      params: { alias: string }
      payload: { preset?: string }
    }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      const { server } = yield* serverFor(url, alias)
      if (!server)
        return {
          alias,
          status: "unavailable" as const,
          hub_error: "not_found" as const,
          // S-V19: карточки нет — значит нет ни `mcp_url`, ни режима, подключать этим способом нечем.
          error_class: CorpErrors.connectErrorClass({ code: "not_found" }),
        }

      const preset = ctx.payload.preset ?? CorpStatus.DEFAULT_PRESET
      const patch = CorpConnectors.connectPatch(server, preset)
      // Шаг 1 (D-7): персист через updateGlobal, а не через runtime-only POST /mcp/:name/connect (F17).
      yield* configSvc.updateGlobal(patch)
      yield* mcpSvc.add(alias, patch.mcp[alias])
      yield* dropMemo(url)

      // Шаг 2: штатный MCP-OAuth сервера — браузер и ожидание callback 19876 (F15/F16).
      const status = yield* mcpSvc
        .authenticate(alias)
        .pipe(Effect.catch((error) => Effect.succeed({ status: "failed" as const, error: String(error) })))
      if (status.status === "failed" || status.status === "needs_client_registration") {
        // Шаг 4: запись mcp.<alias> остаётся, чтобы повтор был в один клик. Признак «подключение
        // состоялось» (S-V15) при этом не выставляется — попытка не удалась.
        // S-V19: ошибка не остаётся необъяснённой — класс определяется всегда, в том числе `unknown`.
        return {
          alias,
          status: yield* cardFor(url, alias),
          error: status.error,
          error_class: CorpErrors.connectErrorClass({
            local: status.status,
            ...(status.error === undefined ? {} : { message: String(status.error) }),
          }),
        }
      }
      return { alias, status: yield* cardFor(url, alias) }
    })

    const disconnect = Effect.fn("CorpHttpApi.disconnect")(function* (ctx: { params: { alias: string } }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      yield* configSvc.updateGlobal(CorpConnectors.disconnectPatch(alias))
      yield* dropMemo(url)

      const key = yield* corpKey()
      let hubError: CorpErrors.Code | undefined
      if (key) {
        const hub = CorpHub.make({ hubUrl: url, key })
        const removed = yield* Effect.promise(() => hub.removeConnection(alias))
        // S-V8: отказ Hub не откатывает локальные шаги, но показывается предупреждением.
        if (!removed.ok) hubError = removed.code
      }
      return {
        alias,
        status: "not_connected" as const,
        ...(hubError === undefined ? {} : { hub_error: hubError }),
      }
    })

    /**
     * S-V17 «Убрать из списка».
     *
     * Смысл действия — «я больше не хочу видеть этот сервер подключённым у себя»: оно доводит до
     * конца отключение и **удаляет** запись `mcp.<alias>` из конфига, чего «Отключить» не делает.
     * Отказ Hub на последнем, необязательном шаге локальные шаги не откатывает: локальное состояние
     * пользователя приведено в порядок в любом случае (AC-176).
     */
    const forget = Effect.fn("CorpHttpApi.forget")(function* (ctx: { params: { alias: string } }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      // Шаг 1: те же локальные шаги, что у S-V8.
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      // Шаг 2: ключ `mcp.<alias>` удаляется целиком; прочий конфиг пользователя не трогается (S-C7).
      yield* configSvc.updateGlobal(CorpConnectors.forgetPatch(alias))
      // Шаг 3: признак «подключение состоялось» снимается — единственный способ его снять (S-V15 п.3).
      const connections = yield* readConnections(url)
      const without = CorpConnections.forget(connections, alias)
      if (without) yield* Effect.promise(() => CorpConnections.write(without))
      yield* dropMemo(url)

      // Шаг 4 необязателен: без ключа и при недоступном Hub он пропускается, а не откатывает шаги 1–3.
      const key = yield* corpKey()
      let hubError: CorpErrors.Code | undefined
      if (key) {
        const hub = CorpHub.make({ hubUrl: url, key })
        const removed = yield* Effect.promise(() => hub.removeConnection(alias))
        if (!removed.ok) hubError = removed.code
      }
      return {
        alias,
        status: "not_connected" as const,
        removed: true,
        ...(hubError === undefined ? {} : { hub_error: hubError }),
      }
    })

    /**
     * S-V21: применение режимов групп записью в раздел `permission` глобального конфига.
     *
     * Hub в этом не участвует вовсе (D-35): ни запроса, ни `oauth.scope`, ни повторной авторизации.
     * Запись — детерминированная перезапись всего блока alias двумя вызовами `updateGlobal` в
     * строго этом порядке; правило порядка ключей внутри блока держит `permissionGroupsPatch`.
     */
    const applyPermissionGroups = Effect.fnUntraced(function* (
      url: string,
      alias: string,
      modes: Record<string, CorpSchema.PermissionMode>,
    ) {
      // Словарь берётся из кэша каталога, а не из Hub: «запрос к Hub не выполняется вовсе» (S-V1)
      // относится и к чтению — экран разрешений открывается с витрины, которая кэш только что
      // перезаписала (S-V3).
      const source = yield* cachedServerFor(url, alias)
      const parsed =
        source.server === undefined ? undefined : CorpSchema.parsePermissionGroups(source.server.permission_groups)
      // Словаря нет — применять режимы не к чему: состав ключей выводится только из него.
      if (!parsed) return yield* new CorpBadRequestError({ error: "permission_groups_unavailable" })

      // Ключи берутся из **глобального** конфига: правится именно он, а гасить `undefined` имеет
      // смысл только то, что в этом файле действительно лежит.
      const globalConfig = yield* configSvc.getGlobal()
      const patch = CorpConnectors.permissionGroupsPatch(alias, {
        groups: parsed.groups,
        modes,
        existing: Object.keys(globalConfig.permission ?? {}),
      })
      yield* configSvc.updateGlobal(patch.clear)
      yield* configSvc.updateGlobal(patch.write)
      yield* dropMemo(url)

      // Состояние считается по конфигу **после** записи — и тем же правилом, что на витрине (S-V23).
      const config = yield* configSvc.get()
      return {
        alias,
        status: yield* cardFor(url, alias, source),
        reauth_required: false,
        permission_state: CorpConnectors.permissionState(alias, parsed.groups, config.permission),
      }
    })

    const permissions = Effect.fn("CorpHttpApi.permissions")(function* (ctx: {
      params: { alias: string }
      payload: { preset?: string; groups?: string[]; modes?: Record<string, CorpSchema.PermissionMode> }
    }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      // S-V1: два вида тела взаимоисключающи. Оба сразу — ошибка запроса, и ничего не записывается:
      // молча предпочесть один вид значило бы применить не то, о чём просил клиент.
      if (ctx.payload.preset !== undefined && ctx.payload.modes !== undefined)
        return yield* new CorpBadRequestError({ error: "conflicting_body" })
      // Ни того, ни другого: прежде такое тело отвергала схема (`preset` был обязателен), и оно
      // обязано отвергаться и теперь — молчаливый `readonly` по умолчанию снял бы права, о которых
      // никто не просил.
      if (ctx.payload.preset === undefined && ctx.payload.modes === undefined)
        return yield* new CorpBadRequestError({ error: "missing_body" })

      // Ветка `modes` уходит до чтения каталога из Hub: в ней Hub не участвует ни на шаг (D-35).
      if (ctx.payload.modes !== undefined) return yield* applyPermissionGroups(url, alias, ctx.payload.modes)

      const { server } = yield* serverFor(url, alias)
      const preset = ctx.payload.preset ?? CorpStatus.DEFAULT_PRESET
      const key = yield* corpKey()
      if (!key)
        return {
          alias,
          status: yield* cardFor(url, alias),
          preset,
          reauth_required: false,
          hub_error: "unauthorized" as const,
        }

      const hub = CorpHub.make({ hubUrl: url, key })
      const updated = yield* Effect.promise(() => hub.setPermissions(alias, preset, ctx.payload.groups))
      if (!updated.ok)
        return {
          alias,
          status: yield* cardFor(url, alias),
          preset,
          reauth_required: false,
          hub_error: updated.code,
        }

      const previous = server?.connection?.preset
      const reauth = CorpConnectors.needsReauth(previous, preset, updated.data.status)

      if (server) {
        const patch = CorpConnectors.permissionsPatch(server, preset)
        if (patch) yield* configSvc.updateGlobal(patch)
      }
      yield* dropMemo(url)

      if (reauth) {
        yield* mcpSvc.authenticate(alias).pipe(Effect.catch(() => Effect.void))
      }
      return {
        alias,
        status: yield* cardFor(url, alias),
        preset,
        reauth_required: reauth,
      }
    })

    return handlers
      .handle("loginStart", loginStart)
      .handle("loginPoll", loginPoll)
      .handle("loginTeam", loginTeam)
      .handle("loginCancel", loginCancel)
      .handle("status", status)
      .handle("catalog", catalog)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
      .handle("forget", forget)
      .handle("permissions", permissions)
  }),
)
