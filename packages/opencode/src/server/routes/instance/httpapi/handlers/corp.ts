import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import * as CorpCatalogCache from "@/corp/catalog-cache"
import * as CorpConfig from "@/corp/config"
import * as CorpConnectors from "@/corp/connectors"
import type * as CorpErrors from "@/corp/errors"
import * as CorpHub from "@/corp/hub"
import * as CorpLogin from "@/corp/login"
import * as CorpSchema from "@/corp/schema"
import * as CorpStatus from "@/corp/status"
import { CORP_PROVIDER_ID } from "@opencode-ai/core/corp/constants"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { CorpDisabledError, CorpHubError } from "../groups/corp"

/**
 * Обработчики корп-роутов (S-A1…S-A5, S-V1…S-V10).
 *
 * Все обращения к Hub выполняются здесь, на серверной стороне бинарника (D-2). Ключ провайдера и
 * `poll_secret` наружу не отдаются и в логи не пишутся.
 */

/** Свежесть внутрипроцессного memo каталога (S-V3). */
const CATALOG_MEMO_MS = 60_000

let memo: { hubUrl: string; at: number; view: CorpSchema.CatalogView } | undefined

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
      return CorpLogin.publicView(session, started.data.user_code, started.data.browser_url)
    })

    /** Общая обработка ответа Hub на опрос: сохранение ключа при `ready` (S-A3). */
    const handlePoll = Effect.fnUntraced(function* (
      session: CorpLogin.Session,
      result: CorpHub.Result<CorpSchema.CliPoll>,
    ) {
      if (!result.ok) {
        if (result.code === "hub_unavailable" || result.code === "litellm_unavailable") {
          session.hubErrors += 1
          if (session.hubErrors < CorpLogin.MAX_CONSECUTIVE_HUB_ERRORS) return { status: "pending" as const }
        }
        if (result.code === "login_expired" || result.code === "forbidden") CorpLogin.store.drop(session.loginId)
        return {
          status: "error" as const,
          error: result.code,
          message: `hub responded with ${result.code}`,
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
      return { status: "ready" as const, user: data.user, key_kind: data.key_kind }
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
        user: { user_id: me.data.user_id, email: me.data.email },
        ...(me.data.key_kind === undefined ? {} : { key_kind: me.data.key_kind }),
      }
    })

    // --- Витрина (S-V1…S-V6) ---

    /** Локальные статусы MCP и записи `mcp.<alias>` действующего конфига (S-V5). */
    const localState = Effect.fnUntraced(function* () {
      const statuses = yield* mcpSvc.status()
      const config = yield* configSvc.get()
      return { statuses, configured: new Set(Object.keys(config.mcp ?? {})) }
    })

    const toCards = Effect.fnUntraced(function* (url: string, servers: CorpSchema.CatalogServer[], stale: boolean) {
      const { statuses, configured } = yield* localState()
      const known = new Set(servers.map((server) => server.alias))
      const cards: CorpSchema.CatalogCard[] = servers.map((server) => {
        const local = statuses[server.alias]
        const card = CorpStatus.compute({
          alias: server.alias,
          server,
          configured: configured.has(server.alias),
          ...(local === undefined ? {} : { local: local.status }),
          ...(local && "error" in local ? { localError: local.error } : {}),
          stale,
        })
        return {
          alias: server.alias,
          title: server.title,
          ...(server.description === undefined ? {} : { description: server.description }),
          ...(server.owner === undefined ? {} : { owner: server.owner }),
          ...(server.contact === undefined ? {} : { contact: server.contact }),
          ...(server.docs_url === undefined ? {} : { docs_url: server.docs_url }),
          server_status: server.status,
          mode: server.mode,
          mcp_url: server.mcp_url,
          ...(server.permission_model === undefined ? {} : { permission_model: server.permission_model }),
          ...(server.connection === undefined ? {} : { connection_status: server.connection.status }),
          ...(server.connection?.preset === undefined ? {} : { preset: server.connection.preset }),
          status: card.status,
          actions: card.actions,
          deprecated: card.deprecated,
          blocked: card.blocked,
          configured: configured.has(server.alias),
          ...(card.error === undefined ? {} : { error: card.error }),
          hub_url: CorpConnectors.hubServerUrl(url, server.alias),
        }
      })
      // Правило 1 S-V6: alias есть в конфиге, но пропал из каталога — карточку всё равно показываем.
      for (const alias of configured) {
        if (known.has(alias)) continue
        const local = statuses[alias]
        const card = CorpStatus.compute({ alias, configured: true, stale, ...(local ? { local: local.status } : {}) })
        cards.push({
          alias,
          title: alias,
          server_status: "deprecated",
          mode: "native",
          mcp_url: "",
          status: card.status,
          actions: card.actions,
          deprecated: false,
          blocked: card.blocked,
          configured: true,
          hub_url: CorpConnectors.hubServerUrl(url, alias),
        })
      }
      return cards
    })

    const catalog = Effect.fn("CorpHttpApi.catalog")(function* (ctx: { query: { refresh?: string } }) {
      const url = yield* requireHub()
      const refresh = ctx.query.refresh === "true"
      const now = Date.now()
      if (!refresh && memo && memo.hubUrl === url && now - memo.at < CATALOG_MEMO_MS) return memo.view

      const key = yield* corpKey()
      if (!key) {
        // S-V4: без ключа витрина показывает состояние «Требуется вход».
        return { version: "", source: "cache" as const, stale: true, servers: [], hub_error: "unauthorized" as const }
      }

      const hub = CorpHub.make({ hubUrl: url, key })
      const fresh = yield* Effect.promise(() => hub.catalog())
      if (fresh.ok) {
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
          servers: yield* toCards(url, fresh.data.servers, false),
        }
        memo = { hubUrl: url, at: now, view }
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
      return {
        version: cached.version,
        source: "cache" as const,
        cached_at: cached.fetchedAt,
        stale,
        servers: yield* toCards(url, cached.servers, stale),
        hub_error: fresh.code,
      }
    })

    /** Карточка каталога по alias — из свежего ответа Hub, иначе из кэша. */
    const serverFor = Effect.fnUntraced(function* (url: string, alias: string) {
      const key = yield* corpKey()
      if (key) {
        const hub = CorpHub.make({ hubUrl: url, key })
        const fresh = yield* Effect.promise(() => hub.catalog())
        if (fresh.ok) return fresh.data.servers.find((server) => server.alias === alias)
      }
      const cached = yield* Effect.promise(() => CorpCatalogCache.read(url))
      return cached?.servers.find((server) => server.alias === alias)
    })

    const cardFor = Effect.fnUntraced(function* (alias: string) {
      const { statuses, configured } = yield* localState()
      const local = statuses[alias]
      return CorpStatus.compute({
        alias,
        configured: configured.has(alias),
        ...(local === undefined ? {} : { local: local.status }),
        stale: false,
        server: undefined,
      }).status
    })

    // --- Действия витрины (S-V7…S-V9) ---

    const connect = Effect.fn("CorpHttpApi.connect")(function* (ctx: {
      params: { alias: string }
      payload: { preset?: string }
    }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      const server = yield* serverFor(url, alias)
      if (!server) return { alias, status: "unavailable" as const, hub_error: "not_found" as const }

      const preset = ctx.payload.preset ?? CorpStatus.DEFAULT_PRESET
      const patch = CorpConnectors.connectPatch(server, preset)
      // Шаг 1 (D-7): персист через updateGlobal, а не через runtime-only POST /mcp/:name/connect (F17).
      yield* configSvc.updateGlobal(patch)
      yield* mcpSvc.add(alias, patch.mcp[alias])
      memo = undefined

      // Шаг 2: штатный MCP-OAuth сервера — браузер и ожидание callback 19876 (F15/F16).
      const status = yield* mcpSvc
        .authenticate(alias)
        .pipe(Effect.catch((error) => Effect.succeed({ status: "failed" as const, error: String(error) })))
      if (status.status === "failed" || status.status === "needs_client_registration") {
        // Шаг 4: запись mcp.<alias> остаётся, чтобы повтор был в один клик.
        return { alias, status: yield* cardFor(alias), error: status.error }
      }
      return { alias, status: yield* cardFor(alias) }
    })

    const disconnect = Effect.fn("CorpHttpApi.disconnect")(function* (ctx: { params: { alias: string } }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      yield* mcpSvc.removeAuth(alias)
      yield* mcpSvc.disconnect(alias).pipe(Effect.catch(() => Effect.void))
      yield* configSvc.updateGlobal(CorpConnectors.disconnectPatch(alias))
      memo = undefined

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

    const permissions = Effect.fn("CorpHttpApi.permissions")(function* (ctx: {
      params: { alias: string }
      payload: { preset: string; groups?: string[] }
    }) {
      const url = yield* requireHub()
      const alias = ctx.params.alias
      const server = yield* serverFor(url, alias)
      const key = yield* corpKey()
      if (!key)
        return {
          alias,
          status: yield* cardFor(alias),
          preset: ctx.payload.preset,
          reauth_required: false,
          hub_error: "unauthorized" as const,
        }

      const hub = CorpHub.make({ hubUrl: url, key })
      const updated = yield* Effect.promise(() => hub.setPermissions(alias, ctx.payload.preset, ctx.payload.groups))
      if (!updated.ok)
        return {
          alias,
          status: yield* cardFor(alias),
          preset: ctx.payload.preset,
          reauth_required: false,
          hub_error: updated.code,
        }

      const previous = server?.connection?.preset
      const reauth = CorpConnectors.needsReauth(previous, ctx.payload.preset, updated.data.status)

      if (server) {
        const patch = CorpConnectors.permissionsPatch(server, ctx.payload.preset)
        if (patch) yield* configSvc.updateGlobal(patch)
      }
      memo = undefined

      if (reauth) {
        yield* mcpSvc.authenticate(alias).pipe(Effect.catch(() => Effect.void))
      }
      return {
        alias,
        status: yield* cardFor(alias),
        preset: ctx.payload.preset,
        reauth_required: reauth,
      }
    })

    return handlers
      .handle("loginStart", loginStart)
      .handle("loginPoll", loginPoll)
      .handle("loginTeam", loginTeam)
      .handle("status", status)
      .handle("catalog", catalog)
      .handle("connect", connect)
      .handle("disconnect", disconnect)
      .handle("permissions", permissions)
  }),
)
