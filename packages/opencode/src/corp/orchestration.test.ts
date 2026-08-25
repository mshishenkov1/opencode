import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { MCP } from "@/mcp"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { CorpApi, CorpPaths } from "@/server/routes/instance/httpapi/groups/corp"
import { corpHandlers } from "@/server/routes/instance/httpapi/handlers/corp"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { instanceContextLayer } from "@/server/routes/instance/httpapi/middleware/instance-context"
import { schemaErrorLayer, SchemaErrorMiddleware } from "@/server/routes/instance/httpapi/middleware/schema-error"
import {
  WorkspaceRouteContext,
  WorkspaceRoutingMiddleware,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { NodeFileSystem, NodeHttpServer, NodePath } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Effect, Layer, Logger } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { AccountTest } from "../../test/fake/account"
import { NpmTest } from "../../test/fake/npm"
import { testInstanceStoreLayer } from "../../test/fixture/fixture"
import { testEffect } from "../../test/lib/effect"
import * as CorpCatalogCache from "./catalog-cache"
import * as CorpConnections from "./connections"
import { liveCatalogBody, liveTagCard } from "../../test/fixture/corp-hub-live"

/**
 * Оркестрация действий витрины и входа через корп-роуты локального HTTP-сервера
 * (S-A9, S-D8, S-V1, S-V3, S-V6, S-V7, S-V8, S-V9; AC-30, AC-57…AC-65, AC-116).
 *
 * Внешних систем нет: Hub — `Bun.serve` на 127.0.0.1, MCP замокан на границе сервиса
 * (`MCP.Service`, а не сеть), браузер — пустая заглушка `open`/`xdg-open` в `PATH`,
 * глобальный конфиг и рабочий каталог — временные.
 *
 * Проверяется наблюдаемое поведение: что записано в глобальный конфиг, какие вызовы ушли в MCP и
 * в Hub (и в каком порядке) и какой статус карточки вернул роут по таблице S-V6.
 */

// --- Мок Hub (§3.1, §3.2) ---

const USER = { user_id: "u-1", email: "ivan@magnit.ru" }
const KEY = "sk-magnit-persistent"

const FACADE = {
  alias: "gitlab-platform",
  title: "GitLab Платформа",
  description: "Merge requests, pipelines",
  owner: "Платформа",
  status: "ga" as const,
  mode: "facade" as const,
  permission_model: {
    kind: "header_groups" as const,
    groups: [
      { id: "read", title: "Чтение", preset: "readonly" },
      { id: "write", title: "Запись", preset: "readwrite" },
    ],
    always: ["gitlab-platform_search"],
  },
}

const NATIVE = {
  alias: "tag",
  title: "ТЭГ",
  owner: "ТЭГ",
  status: "beta" as const,
  mode: "native" as const,
  permission_model: { kind: "consent" as const, presets: { default: "Экран согласия сервера" } },
}

interface HubRequest {
  method: string
  path: string
  body?: unknown
}

interface HubMock {
  url: string
  requests: HubRequest[]
  /**
   * Ответ `/api/catalog`: `undefined` — 502 (Hub недоступен).
   * Тип намеренно свободный: тесты S-V14 подают живую форму конверта (`version` числом) и заведомо
   * нарушенные конверты.
   */
  catalog?: unknown
  /** Ответ `PUT /api/me/connections/:alias/permissions`. */
  permissions: (alias: string, body: any) => Response
  /** Ответ `DELETE /api/me/connections/:alias`. */
  removal: (alias: string) => Response
  stop: () => void
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function catalogOf(servers: { alias: string; connection?: { status: string; preset?: string } }[], origin: string) {
  return {
    version: "2026-08-20.1",
    servers: servers.map((server) => ({
      ...(server.alias === NATIVE.alias ? NATIVE : FACADE),
      ...server,
      mcp_url: `${origin}/mcp/${server.alias}`,
    })),
  }
}

function startHub(): HubMock {
  const mock: HubMock = {
    url: "",
    requests: [],
    permissions: (alias, body) => json({ alias, status: "connected", preset: body?.preset }),
    removal: (alias) => json({ alias, status: "not_connected" }),
    stop: () => server.stop(true),
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" || request.method === "DELETE" ? undefined : await request.json()
      mock.requests.push({ method: request.method, path: url.pathname, ...(body === undefined ? {} : { body }) })

      if (url.pathname === "/health") return json({ status: "ok" })
      if (url.pathname === "/cli/start" && request.method === "POST")
        return json({
          login_id: "login-1",
          poll_secret: "secret-do-not-leak",
          browser_url: `${mock.url}/ui/login/login-1`,
          user_code: "MGNT-4271",
          expires_in: 600,
        })
      if (url.pathname.startsWith("/cli/poll/")) return json({ status: "pending" })

      if (!request.headers.get("authorization")?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401)
      if (url.pathname === "/api/me") return json({ ...USER, key_kind: "persistent" })
      if (url.pathname === "/api/catalog")
        return mock.catalog === undefined ? json({ error: "litellm_unavailable" }, 502) : json(mock.catalog)

      const permissions = url.pathname.match(/^\/api\/me\/connections\/([^/]+)\/permissions$/)
      if (permissions && request.method === "PUT") return mock.permissions(decodeURIComponent(permissions[1]!), body)

      const connection = url.pathname.match(/^\/api\/me\/connections\/([^/]+)$/)
      if (connection && request.method === "DELETE") return mock.removal(decodeURIComponent(connection[1]!))

      return json({ error: "not_found" }, 404)
    },
  })
  mock.url = `http://127.0.0.1:${server.port}`
  mock.catalog = catalogOf([{ alias: FACADE.alias }, { alias: NATIVE.alias }], mock.url)
  return mock
}

// --- Подменяемое состояние теста ---

type Status = MCP.Status

interface TestState {
  hub: HubMock
  /** Ключ `magnit_prod` в auth-store (D-3). */
  key: string | undefined
  directory: string
  /** Локальные статусы MCP (`GET /mcp`, F14). */
  statuses: Record<string, Status>
  /** Локальный статус, который даёт регистрация сервера в MCP (шаг 1 S-V7). */
  addStatus: Status
  /** Что вернёт `MCP.authenticate` и в какой статус переведёт сервер (шаг 2 S-V7). */
  authenticate: (alias: string) => Status
  /** Журнал вызовов границы MCP и записей конфига — для проверки порядка шагов S-V8. */
  calls: string[]
  added: { name: string; mcp: any }[]
}

let state: TestState

// --- Слои ---

const TestHttpApi = HttpApi.make("opencode-instance").addHttpApi(CorpApi).middleware(SchemaErrorMiddleware)

const authLayer = Layer.mock(Auth.Service)({
  get: (providerID: string) =>
    Effect.succeed(
      providerID === "magnit_prod" && state.key !== undefined
        ? new Auth.Api({ type: "api", key: state.key })
        : undefined,
    ),
  all: () => Effect.succeed({}),
  set: (key: string) => Effect.sync(() => void state.calls.push(`auth.set:${key}`)),
  remove: () => Effect.void,
})

/** Граница MCP (F13/F14/F17): вместо сети — журнал вызовов и управляемые статусы. */
const mcpLayer = Layer.mock(MCP.Service)({
  status: () => Effect.sync(() => ({ ...state.statuses })),
  add: (name: string, mcp: any) =>
    Effect.sync(() => {
      state.calls.push(`add:${name}`)
      state.added.push({ name, mcp })
      // Регистрация сервера сама по себе даёт локальный статус: `disabled` либо `needs_auth`,
      // если сервер требует OAuth (F14).
      state.statuses[name] = state.addStatus
      return { status: { ...state.statuses } }
    }),
  authenticate: (name: string) =>
    Effect.sync(() => {
      state.calls.push(`authenticate:${name}`)
      const status = state.authenticate(name)
      // Как в MCP.finishAuth (F15): локальный статус переписывается только успешной авторизацией.
      if (status.status === "connected") state.statuses[name] = status
      return status
    }),
  removeAuth: (name: string) => Effect.sync(() => void state.calls.push(`removeAuth:${name}`)),
  disconnect: (name: string) =>
    Effect.suspend(() => {
      state.calls.push(`disconnect:${name}`)
      if (!(name in state.statuses)) return Effect.fail(new MCP.NotFoundError({ name }))
      state.statuses[name] = { status: "disabled" }
      return Effect.void
    }),
})

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

/** Config без обращений в сеть: auth-записей `wellknown` нет, клиент отвечает 404. */
const offlineClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 404 }))),
)

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(authLayer),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, offlineClient)),
  Layer.provideMerge(FSUtil.defaultLayer),
  Layer.provideMerge(infra),
)

const passthroughAuthorization = Layer.succeed(
  Authorization,
  Authorization.of((effect) => effect),
)

/** Рабочий каталог запроса берётся из состояния теста — как `?directory=` у реального middleware. */
const workspaceRoutingLayer = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    Effect.suspend(() =>
      effect.pipe(
        Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: state.directory })),
      ),
    ),
  ),
)

/** Записи журнала сервера за время запроса — для проверки диагностики отброшенных карточек (S-V14 п.5). */
const logs: { level: string; text: string }[] = []
const captureLogger = Logger.make<unknown, void>((options) => {
  // Записи сервера бывают любой формы (в том числе циклической) — журнал теста не должен ронять запрос.
  let text: string
  try {
    text = JSON.stringify(options.message) ?? String(options.message)
  } catch {
    text = String(options.message)
  }
  logs.push({ level: String(options.logLevel), text })
})

const served = HttpRouter.serve(
  HttpApiBuilder.layer(TestHttpApi).pipe(
    Layer.provide(corpHandlers),
    Layer.provide([passthroughAuthorization, workspaceRoutingLayer, schemaErrorLayer]),
    // Тип middleware маршрутизации объявляет зависимость от Session; наш проходной вариант её не трогает.
    Layer.provide(Layer.mock(Session.Service)({})),
    Layer.provide(instanceContextLayer),
    Layer.provide(testInstanceStoreLayer),
    Layer.provide(mcpLayer),
    Layer.provide(authLayer),
    Layer.provide(configLayer),
    Layer.provide(Logger.layer([captureLogger])),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(infra))

const it = testEffect(served)

// --- Обвязка ---

const tmpDirs: string[] = []
let previousGlobalConfig: string
let previousGlobalData: string
let previousPath: string | undefined
let previousBrowser: string | undefined
let browserLog: string

async function tmp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Заглушка браузера: пакет `open` ищет команду в `PATH` и пишет аргументы в файл (S-D8). */
async function browserStub() {
  const dir = await tmp("corp-open-")
  browserLog = path.join(dir, "opened.txt")
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(dir, name)
    await fs.writeFile(file, `#!/bin/sh\necho "$@" >> ${browserLog}\nexit 0\n`)
    await fs.chmod(file, 0o755)
  }
  return dir
}

const stubDir = await browserStub()

beforeEach(async () => {
  const hub = startHub()
  const globalDir = await tmp("corp-global-")
  await fs.writeFile(
    path.join(globalDir, "opencode.json"),
    JSON.stringify({ $schema: "https://opencode.ai/config.json" }),
  )
  previousGlobalConfig = Global.Path.config
  ;(Global.Path as { config: string }).config = globalDir
  // Ревизия 1.9: витрина пишет признак «подключение состоялось» в `Global.Path.data/corp`
  // (S-V15 п.2) — каталог данных тоже временный, настоящий профиль пользователя не задействуется.
  previousGlobalData = Global.Path.data
  ;(Global.Path as { data: string }).data = await tmp("corp-data-")
  previousPath = process.env["PATH"]
  process.env["PATH"] = `${stubDir}${path.delimiter}${previousPath ?? ""}`
  // На linux пакет `open` предпочитает встроенный `xdg-open`, который открывает `$BROWSER`.
  previousBrowser = process.env["BROWSER"]
  process.env["BROWSER"] = path.join(stubDir, "open")
  process.env["OPENCODE_CORP_HUB_URL"] = hub.url
  await fs.rm(browserLog, { force: true })

  logs.length = 0
  state = {
    hub,
    key: KEY,
    directory: await tmp("corp-work-"),
    statuses: {},
    addStatus: { status: "disabled" },
    authenticate: () => ({ status: "connected" }),
    calls: [],
    added: [],
  }
})

afterEach(() => {
  state.hub.stop()
  ;(Global.Path as { config: string }).config = previousGlobalConfig
  ;(Global.Path as { data: string }).data = previousGlobalData
  if (previousPath === undefined) delete process.env["PATH"]
  else process.env["PATH"] = previousPath
  if (previousBrowser === undefined) delete process.env["BROWSER"]
  else process.env["BROWSER"] = previousBrowser
  delete process.env["OPENCODE_CORP_HUB_URL"]
})

afterAll(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

/** Содержимое глобального конфига пользователя после действий витрины (S-C7, S-V7, S-V8). */
async function globalConfig(): Promise<any> {
  const file = path.join(Global.Path.config, "opencode.json")
  return JSON.parse(await fs.readFile(file, "utf8"))
}

const post = (route: string, payload?: unknown) =>
  payload === undefined
    ? HttpClientRequest.post(route).pipe(HttpClient.execute)
    : HttpClientRequest.post(route).pipe(
        HttpClientRequest.bodyJson(payload),
        Effect.orDie,
        Effect.flatMap(HttpClient.execute),
      )

const put = (route: string, body: unknown) =>
  HttpClientRequest.put(route).pipe(HttpClientRequest.bodyJson(body), Effect.orDie, Effect.flatMap(HttpClient.execute))

const del = (route: string) => HttpClientRequest.delete(route).pipe(HttpClient.execute)

const get = (route: string) => HttpClientRequest.get(route).pipe(HttpClient.execute)

const connectRoute = (alias: string) => CorpPaths.connect.replace(":alias", alias)
const disconnectRoute = (alias: string) => CorpPaths.disconnect.replace(":alias", alias)
const permissionsRoute = (alias: string) => CorpPaths.permissions.replace(":alias", alias)
/** «Убрать из списка» (S-V17): DELETE самой записи коннектора, а не подчинённого ресурса. */
const forgetRoute = (alias: string) => CorpPaths.forget.replace(":alias", alias)

const body = <A>(response: { json: Effect.Effect<unknown, any, any> }) => response.json as Effect.Effect<A, any, any>

// --- Подключение (S-V7) ---

describe("оркестрация витрины — «Подключить» (AC-57, AC-58, AC-59, AC-61, AC-116)", () => {
  it.live("AC-57, AC-61: facade без пресета пишет mcp.<alias> с scope readonly и запускает authenticate", () =>
    Effect.gen(function* () {
      const response = yield* post(connectRoute(FACADE.alias), {})
      expect(response.status).toBe(200)

      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias]).toEqual({
        type: "remote",
        url: `${state.hub.url}/mcp/${FACADE.alias}`,
        enabled: true,
        oauth: { scope: `${FACADE.alias}:readonly` },
      })
      // Шаг 1 (запись конфига + регистрация в MCP) строго до шага 2 (OAuth).
      expect(state.calls).toEqual([`add:${FACADE.alias}`, `authenticate:${FACADE.alias}`])
      expect(state.added[0]!.mcp.oauth).toEqual({ scope: `${FACADE.alias}:readonly` })
    }),
  )

  it.live("AC-116, S-V6 строка 5: после успешного OAuth роут отдаёт статус connected, а не unavailable", () =>
    Effect.gen(function* () {
      const response = yield* post(connectRoute(FACADE.alias), { preset: "readwrite" })
      const result = yield* body<{ alias: string; status: string; error?: string }>(response)

      expect(result).toEqual({ alias: FACADE.alias, status: "connected" })
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias].oauth).toEqual({ scope: `${FACADE.alias}:readwrite` })
    }),
  )

  it.live("AC-58: native-карточка подключается без ключа oauth в конфиге", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(NATIVE.alias), {})

      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[NATIVE.alias]).toEqual({
        type: "remote",
        url: `${state.hub.url}/mcp/${NATIVE.alias}`,
        enabled: true,
      })
      expect(config.mcp[NATIVE.alias].oauth).toBeUndefined()
      expect(state.calls).toContain(`authenticate:${NATIVE.alias}`)
    }),
  )

  it.live("AC-59: отказ OAuth оставляет запись в конфиге, статус карточки needs_auth и текст ошибки", () =>
    Effect.gen(function* () {
      // Сервер требует OAuth, пользователь отказал: локальный статус остаётся `needs_auth` (F14/F15).
      state.addStatus = { status: "needs_auth" }
      state.authenticate = () => ({ status: "failed", error: "access_denied" })

      const response = yield* post(connectRoute(FACADE.alias), {})
      const result = yield* body<{ status: string; error?: string }>(response)

      expect(result.error).toBe("access_denied")
      // Правило 4 таблицы S-V6: повтор доступен одним действием «Подключить».
      expect(result.status).toBe("needs_auth")
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias].enabled).toBe(true)
    }),
  )

  it.live("S-V7: alias вне каталога не пишется в конфиг и отдаёт unavailable/not_found", () =>
    Effect.gen(function* () {
      const response = yield* post(connectRoute("unknown-alias"), {})
      const result = yield* body<{ status: string; hub_error?: string }>(response)

      expect(result.status).toBe("unavailable")
      expect(result.hub_error).toBe("not_found")
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp?.["unknown-alias"]).toBeUndefined()
      expect(state.calls).toEqual([])
    }),
  )

  it.live("S-V3, S-V7: отказ Hub во время подключения не портит конфиг и не запускает OAuth", () =>
    Effect.gen(function* () {
      state.hub.catalog = undefined
      const response = yield* post(connectRoute(FACADE.alias), {})
      const result = yield* body<{ status: string; hub_error?: string }>(response)

      expect(result.status).toBe("unavailable")
      expect(result.hub_error).toBe("not_found")
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp).toBeUndefined()
      expect(state.calls).toEqual([])
    }),
  )
})

// --- Отключение (S-V8) ---

describe("оркестрация витрины — «Отключить» (AC-62, AC-63)", () => {
  it.live("AC-62: три локальных шага по порядку, затем DELETE подключения в Hub", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      state.calls = []

      const response = yield* post(disconnectRoute(FACADE.alias))
      const result = yield* body<{ alias: string; status: string; hub_error?: string }>(response)

      expect(result).toEqual({ alias: FACADE.alias, status: "not_connected" })
      expect(state.calls).toEqual([`removeAuth:${FACADE.alias}`, `disconnect:${FACADE.alias}`])

      const config = yield* Effect.promise(() => globalConfig())
      // Запись не удалена — повтор подключения остаётся в один клик (S-V8).
      expect(config.mcp[FACADE.alias].enabled).toBe(false)
      expect(config.mcp[FACADE.alias].url).toBe(`${state.hub.url}/mcp/${FACADE.alias}`)

      const removal = state.hub.requests.filter((request) => request.method === "DELETE")
      expect(removal.map((request) => request.path)).toEqual([`/api/me/connections/${FACADE.alias}`])
    }),
  )

  it.live("AC-63: отказ Hub не откатывает локальные шаги и приходит предупреждением hub_error", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      state.calls = []
      // 502 без тела: наружу уходит стабильный код S-A5, а не текст Hub.
      state.hub.removal = () => json({}, 502)

      const response = yield* post(disconnectRoute(FACADE.alias))
      const result = yield* body<{ status: string; hub_error?: string }>(response)

      expect(result.status).toBe("not_connected")
      expect(result.hub_error).toBe("hub_unavailable")
      expect(state.calls).toEqual([`removeAuth:${FACADE.alias}`, `disconnect:${FACADE.alias}`])
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias].enabled).toBe(false)
    }),
  )

  it.live("S-V8: повторное «Отключить» идемпотентно — тот же ответ и та же запись конфига", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      yield* post(disconnectRoute(FACADE.alias))
      const before = yield* Effect.promise(() => globalConfig())
      state.calls = []

      const response = yield* post(disconnectRoute(FACADE.alias))
      const result = yield* body<{ alias: string; status: string }>(response)

      expect(response.status).toBe(200)
      expect(result).toEqual({ alias: FACADE.alias, status: "not_connected" })
      expect(state.calls).toEqual([`removeAuth:${FACADE.alias}`, `disconnect:${FACADE.alias}`])
      expect(yield* Effect.promise(() => globalConfig())).toEqual(before)
    }),
  )

  it.live("S-V8: без ключа magnit_prod локальные шаги выполняются, в Hub запрос не уходит", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      state.key = undefined
      state.hub.requests.length = 0

      const response = yield* post(disconnectRoute(FACADE.alias))
      const result = yield* body<{ status: string; hub_error?: string }>(response)

      expect(result.status).toBe("not_connected")
      expect(state.hub.requests.filter((request) => request.method === "DELETE")).toEqual([])
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias].enabled).toBe(false)
    }),
  )
})

// --- Права (S-V9) ---

describe("оркестрация витрины — «Права» (AC-64, AC-65)", () => {
  it.live("AC-64: facade — PUT в Hub, новый oauth.scope в конфиге и повторная авторизация", () =>
    Effect.gen(function* () {
      state.hub.catalog = catalogOf(
        [{ alias: FACADE.alias, connection: { status: "connected", preset: "readonly" } }],
        state.hub.url,
      )
      yield* post(connectRoute(FACADE.alias), {})
      state.calls = []
      state.hub.requests.length = 0
      state.hub.permissions = (alias, payload) => json({ alias, status: "needs_reauth", preset: payload.preset })

      const response = yield* put(permissionsRoute(FACADE.alias), { preset: "readwrite" })
      const result = yield* body<{ preset: string; reauth_required: boolean; status: string }>(response)

      expect(result.preset).toBe("readwrite")
      expect(result.reauth_required).toBe(true)
      const sent = state.hub.requests.find((request) => request.method === "PUT")
      expect(sent?.path).toBe(`/api/me/connections/${FACADE.alias}/permissions`)
      expect(sent?.body).toEqual({ preset: "readwrite" })

      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias].oauth).toEqual({ scope: `${FACADE.alias}:readwrite` })
      expect(state.calls).toEqual([`authenticate:${FACADE.alias}`])
    }),
  )

  it.live("AC-65: native — локальный oauth.scope не появляется, права меняются только в Hub", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(NATIVE.alias), {})
      state.calls = []

      const response = yield* put(permissionsRoute(NATIVE.alias), { preset: "extended" })
      const result = yield* body<{ preset: string; reauth_required: boolean }>(response)

      expect(result.preset).toBe("extended")
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[NATIVE.alias].oauth).toBeUndefined()
      expect(state.hub.requests.some((request) => request.method === "PUT")).toBe(true)
    }),
  )

  it.live("S-V9: тот же пресет и статус connected не требуют повторной авторизации", () =>
    Effect.gen(function* () {
      state.hub.catalog = catalogOf(
        [{ alias: FACADE.alias, connection: { status: "connected", preset: "readonly" } }],
        state.hub.url,
      )
      yield* post(connectRoute(FACADE.alias), {})
      state.calls = []

      const response = yield* put(permissionsRoute(FACADE.alias), { preset: "readonly" })
      const result = yield* body<{ reauth_required: boolean }>(response)

      expect(result.reauth_required).toBe(false)
      expect(state.calls).toEqual([])
    }),
  )

  it.live("S-V9: отказ Hub на PUT не меняет oauth.scope в конфиге и приходит кодом hub_error", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      const before = yield* Effect.promise(() => globalConfig())
      state.calls = []
      state.hub.permissions = () => json({ error: "invalid_request" }, 400)

      const response = yield* put(permissionsRoute(FACADE.alias), { preset: "readwrite" })
      const result = yield* body<{ hub_error?: string; reauth_required: boolean }>(response)

      expect(result.hub_error).toBe("invalid_request")
      expect(result.reauth_required).toBe(false)
      expect(yield* Effect.promise(() => globalConfig())).toEqual(before)
      expect(state.calls).toEqual([])
    }),
  )

  it.live("S-V4, S-V9: без ключа права не меняются ни в Hub, ни в конфиге", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      const before = yield* Effect.promise(() => globalConfig())
      state.key = undefined
      state.hub.requests.length = 0
      state.calls = []

      const response = yield* put(permissionsRoute(FACADE.alias), { preset: "readwrite" })
      const result = yield* body<{ hub_error?: string; reauth_required: boolean }>(response)

      expect(result.hub_error).toBe("unauthorized")
      expect(result.reauth_required).toBe(false)
      expect(state.hub.requests.some((request) => request.method === "PUT")).toBe(false)
      expect(yield* Effect.promise(() => globalConfig())).toEqual(before)
    }),
  )
})

// --- Каталог: memo и протухший кэш (S-V3, S-V6) ---

// --- «Убрать из списка» и признак «подключение состоялось» (S-V15, S-V17) ---

/** Признак «подключение состоялось» с диска (S-V15 п.2) — тот же файл, что читает витрина. */
const everConnected = (alias: string) =>
  Effect.promise(async () => {
    const { entry } = await CorpConnections.read(state.hub.url)
    return CorpConnections.has(entry, alias)
  })

/** Карточка витрины по alias — то, что оболочка получает из `GET /corp/catalog`. */
const cardOf = (alias: string) =>
  Effect.gen(function* () {
    const response = yield* get(CorpPaths.catalog)
    const view = yield* body<{
      servers: {
        alias: string
        status: string
        actions: string[]
        state: string
        ever_connected: boolean
        error?: string
        error_class?: string
      }[]
    }>(response)
    return view.servers.find((server) => server.alias === alias)!
  })

describe("оркестрация витрины — «Убрать из списка» (AC-175, AC-176, AC-188)", () => {
  it.live("AC-175: локальные шаги, удаление ключа mcp.<alias> и DELETE подключения в Hub — по порядку", () =>
    Effect.gen(function* () {
      // Посторонние ключи конфига пользователя, которые действие трогать не имеет права (S-C7).
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(Global.Path.config, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            autoupdate: false,
            mcp: { "keep-alias": { type: "remote", url: "https://keep.test/mcp", enabled: false } },
          }),
        ),
      )
      yield* post(connectRoute(FACADE.alias), {})
      expect(yield* everConnected(FACADE.alias)).toBe(true)
      state.calls = []
      state.hub.requests.length = 0

      const response = yield* del(forgetRoute(FACADE.alias))
      const result = yield* body<{ alias: string; status: string; removed: boolean; hub_error?: string }>(response)

      expect(result).toEqual({ alias: FACADE.alias, status: "not_connected", removed: true })
      // Шаги 1: те же локальные шаги, что у «Отключить».
      expect(state.calls).toEqual([`removeAuth:${FACADE.alias}`, `disconnect:${FACADE.alias}`])
      // Шаг 2: ключ удалён целиком, а не переведён в enabled:false.
      const config = yield* Effect.promise(() => globalConfig())
      expect(FACADE.alias in (config.mcp ?? {})).toBe(false)
      // Прочие ключи пользователя не изменены.
      expect(config.autoupdate).toBe(false)
      expect(config.mcp["keep-alias"]).toEqual({ type: "remote", url: "https://keep.test/mcp", enabled: false })
      // Шаг 3: признак «подключение состоялось» снят.
      expect(yield* everConnected(FACADE.alias)).toBe(false)
      // Шаг 4: подключение снято и в Hub.
      expect(state.hub.requests.filter((request) => request.method === "DELETE").map((request) => request.path)).toEqual(
        [`/api/me/connections/${FACADE.alias}`],
      )
    }),
  )

  it.live("AC-175: карточка после «Убрать из списка» — «Не подключён» и остаётся в витрине", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      yield* del(forgetRoute(FACADE.alias))
      state.statuses = {}

      const card = yield* cardOf(FACADE.alias)
      expect(card.state).toBe("never")
      expect(card.ever_connected).toBe(false)
      expect(card.actions).toEqual(["connect", "open_hub"])
      expect(card.actions).not.toContain("disconnect")
      expect(card.actions).not.toContain("forget")
    }),
  )

  it.live("AC-176: недоступный Hub не откатывает локальные шаги — hub_error рядом с removed:true", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      // Hub недоступен на шаге 4: соединения нет вовсе (тот же наблюдаемый исход, что у таймаута).
      state.hub.stop()
      state.calls = []

      const response = yield* del(forgetRoute(FACADE.alias))
      const result = yield* body<{ status: string; removed: boolean; hub_error?: string }>(response)

      expect(result.removed).toBe(true)
      expect(result.hub_error).toBe("hub_unavailable")
      // Локальные шаги выполнены и не откачены.
      expect(state.calls).toEqual([`removeAuth:${FACADE.alias}`, `disconnect:${FACADE.alias}`])
      const config = yield* Effect.promise(() => globalConfig())
      expect(FACADE.alias in (config.mcp ?? {})).toBe(false)
      expect(yield* everConnected(FACADE.alias)).toBe(false)
    }),
  )

  it.live("AC-176: без ключа magnit_prod шаг обращения к Hub пропускается, локальные — выполняются", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      state.key = undefined
      state.hub.requests.length = 0

      const response = yield* del(forgetRoute(FACADE.alias))
      const result = yield* body<{ removed: boolean }>(response)

      expect(result.removed).toBe(true)
      expect(state.hub.requests.filter((request) => request.method === "DELETE")).toEqual([])
      const config = yield* Effect.promise(() => globalConfig())
      expect(FACADE.alias in (config.mcp ?? {})).toBe(false)
    }),
  )

  it.live("AC-188: «Отключить» признак не снимает, «Убрать из списка» — снимает", () =>
    Effect.gen(function* () {
      yield* post(connectRoute(FACADE.alias), {})
      expect(yield* everConnected(FACADE.alias)).toBe(true)

      yield* post(disconnectRoute(FACADE.alias))
      // Пользователь отключил то, что у него работало: признак остаётся (S-V15 п.3, AC-178).
      expect(yield* everConnected(FACADE.alias)).toBe(true)
      const disconnected = yield* cardOf(FACADE.alias)
      expect(disconnected.ever_connected).toBe(true)
      expect(disconnected.state).toBe("disconnected")
      expect(disconnected.actions).toEqual(["reconnect", "forget", "open_hub"])
      expect(disconnected.actions).not.toContain("disconnect")

      yield* del(forgetRoute(FACADE.alias))
      expect(yield* everConnected(FACADE.alias)).toBe(false)
    }),
  )

  it.live("AC-188: признак выставляется и по записи подключения Hub, без локальной истории", () =>
    Effect.gen(function* () {
      state.hub.catalog = catalogOf(
        [{ alias: FACADE.alias, connection: { status: "connected", preset: "readonly" } }],
        state.hub.url,
      )

      const card = yield* cardOf(FACADE.alias)
      expect(card.ever_connected).toBe(true)
      // И тот же признак остался на диске — следующее открытие витрины его уже не потеряет.
      expect(yield* everConnected(FACADE.alias)).toBe(true)
    }),
  )
})

// --- Классы ошибок подключения (S-V19) ---

describe("оркестрация витрины — классы ошибок подключения (AC-172, AC-180…AC-183)", () => {
  /** Неудачная авторизация с заданным текстом ошибки MCP-OAuth. */
  const failWith = (message: string) => {
    state.addStatus = { status: "needs_auth" }
    state.authenticate = () => ({ status: "failed", error: message })
  }

  it.live("AC-180: отказ авторизации даёт token_rejected во всех трёх видах, секретов в ответе нет", () =>
    Effect.gen(function* () {
      for (const message of [
        "OAuth error: invalid_grant",
        "MCP proxy responded 401 Unauthorized",
        'jsonrpc error: {"data":{"reason":"needs_reauth"}}',
      ]) {
        failWith(message)
        const response = yield* post(connectRoute(FACADE.alias), {})
        const result = yield* body<{ error?: string; error_class?: string }>(response)
        expect(result.error_class, message).toBe("token_rejected")
        const text = JSON.stringify(result)
        expect(text, message).not.toContain(KEY)
        expect(text, message).not.toContain("secret-do-not-leak")
      }
    }),
  )

  it.live("AC-181: отказ регистрации клиента даёт method_unavailable", () =>
    Effect.gen(function* () {
      state.addStatus = { status: "needs_auth" }
      state.authenticate = () => ({ status: "needs_client_registration", error: "dynamic client registration failed" })

      const response = yield* post(connectRoute(FACADE.alias), {})
      const result = yield* body<{ error_class?: string }>(response)
      expect(result.error_class).toBe("method_unavailable")
    }),
  )

  it.live("AC-181: карточки нет в каталоге — подключать этим способом нечем", () =>
    Effect.gen(function* () {
      const response = yield* post(connectRoute("нет-такого-alias"), {})
      const result = yield* body<{ hub_error?: string; error_class?: string }>(response)
      expect(result.hub_error).toBe("not_found")
      expect(result.error_class).toBe("method_unavailable")
    }),
  )

  it.live("AC-182: сеть и Hub дают hub_unreachable", () =>
    Effect.gen(function* () {
      for (const message of ["fetch failed: ETIMEDOUT", "connect ECONNREFUSED 127.0.0.1:8080", "HTTP 502 Bad Gateway"]) {
        failWith(message)
        const response = yield* post(connectRoute(FACADE.alias), {})
        const result = yield* body<{ error_class?: string }>(response)
        expect(result.error_class, message).toBe("hub_unreachable")
      }
    }),
  )

  it.live("AC-183: неотнесённая ошибка получает unknown, но объяснение и код остаются", () =>
    Effect.gen(function* () {
      failWith("непонятная ошибка сервера коннектора")
      const response = yield* post(connectRoute(FACADE.alias), {})
      const result = yield* body<{ error?: string; error_class?: string }>(response)
      expect(result.error_class).toBe("unknown")
      expect(result.error).toContain("непонятная ошибка сервера коннектора")
    }),
  )

  it.live("AC-172: после неудачи запись конфига осталась, признак не выставлен, «Отключить» нет", () =>
    Effect.gen(function* () {
      failWith("OAuth error: invalid_grant")

      const response = yield* post(connectRoute(FACADE.alias), {})
      const result = yield* body<{ status: string; error?: string; error_class?: string }>(response)
      expect(result.error_class).toBe("token_rejected")

      // Шаг 4 S-V7: запись `mcp.<alias>` остаётся — повтор в один клик.
      const config = yield* Effect.promise(() => globalConfig())
      expect(config.mcp[FACADE.alias].url).toBe(`${state.hub.url}/mcp/${FACADE.alias}`)
      // Признак «подключение состоялось» не выставлен: попытка не удалась.
      expect(yield* everConnected(FACADE.alias)).toBe(false)

      const card = yield* cardOf(FACADE.alias)
      expect(card.ever_connected).toBe(false)
      expect(card.state).toBe("failed")
      expect(card.actions).toEqual(["connect", "open_hub"])
      // Слово «Отключить» на карточке не появляется ни в каком виде.
      expect(JSON.stringify(card)).not.toContain("disconnect")
      expect(JSON.stringify(card)).not.toContain("forget")
      // Объяснение ошибки у карточки есть — «ошибки без объяснения» не существует (D-32).
      const errorClass = card.error_class
      if (errorClass === undefined) throw new Error("карточка осталась без класса ошибки подключения (S-V19, D-32)")
      expect(["token_rejected", "method_unavailable", "hub_unreachable", "unknown"]).toContain(errorClass)
    }),
  )
})

describe("витрина — каталог по инстансам и протухший кэш (S-V3, S-V6)", () => {
  it.live("S-V3: memo каталога не отдаёт второму рабочему каталогу карточки первого", () =>
    Effect.gen(function* () {
      const first = yield* get(`${CorpPaths.catalog}`)
      expect((yield* body<{ version: string }>(first)).version).toBe("2026-08-20.1")

      state.hub.catalog = { ...catalogOf([{ alias: FACADE.alias }], state.hub.url), version: "2026-08-20.2" }
      state.directory = yield* Effect.promise(() => tmp("corp-work-2-"))

      const second = yield* get(`${CorpPaths.catalog}`)
      const view = yield* body<{ version: string; servers: unknown[] }>(second)
      expect(view.version).toBe("2026-08-20.2")
      expect(view.servers).toHaveLength(1)
    }),
  )

  it.live("S-V6 строка 2: на протухшем кэше карточка failed не предлагает «Переподключить»", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        CorpCatalogCache.write({
          hubUrl: state.hub.url,
          fetchedAt: Date.now() - 25 * 60 * 60 * 1000,
          version: "stale.1",
          servers: catalogOf([{ alias: FACADE.alias }], state.hub.url).servers as any,
        }),
      )
      state.hub.catalog = undefined
      state.statuses[FACADE.alias] = { status: "failed", error: "connection refused" }

      const response = yield* get(`${CorpPaths.catalog}`)
      const view = yield* body<{
        stale: boolean
        source: string
        servers: { alias: string; actions: string[]; blocked: boolean; status: string }[]
      }>(response)

      expect(view.source).toBe("cache")
      expect(view.stale).toBe(true)
      const card = view.servers.find((server) => server.alias === FACADE.alias)!
      expect(card.status).toBe("unavailable")
      expect(card.blocked).toBe(true)
      expect(card.actions).not.toContain("reconnect")
      expect(card.actions).not.toContain("connect")
      expect(card.actions).not.toContain("permissions")
    }),
  )
})

// --- Вход: отмена сессии и открытие браузера (S-A9, S-D8) ---

describe("вход — отмена сессии и открытие браузера (AC-30, AC-91)", () => {
  it.live("S-D8: POST /corp/login/start открывает browser_url серверной частью", () =>
    Effect.gen(function* () {
      const response = yield* post(CorpPaths.loginStart)
      const started = yield* body<{ login_id: string; browser_url: string; user_code: string }>(response)
      expect(started.user_code).toBe("MGNT-4271")

      const opened = yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const text = await fs.readFile(browserLog, "utf8").catch(() => "")
          if (text.includes(started.browser_url)) return text
          await Bun.sleep(50)
        }
        return await fs.readFile(browserLog, "utf8").catch(() => "")
      })
      expect(opened).toContain(started.browser_url)
      expect(opened).not.toContain("secret-do-not-leak")
    }),
  )

  it.live("AC-30: DELETE /corp/login/poll/:id освобождает сессию, повторный опрос даёт login_expired", () =>
    Effect.gen(function* () {
      const started = yield* body<{ login_id: string }>(yield* post(CorpPaths.loginStart))
      const route = CorpPaths.loginCancel.replace(":loginID", started.login_id)

      const pollBefore = yield* body<{ status: string }>(yield* get(route))
      expect(pollBefore.status).toBe("pending")

      const cancelled = yield* body<{ cancelled: boolean }>(yield* del(route))
      expect(cancelled.cancelled).toBe(true)

      const pollAfter = yield* body<{ status: string; error?: string }>(yield* get(route))
      expect(pollAfter.status).toBe("error")
      expect(pollAfter.error).toBe("login_expired")

      // Повторная отмена безопасна: сессии уже нет.
      expect((yield* body<{ cancelled: boolean }>(yield* del(route))).cancelled).toBe(false)
    }),
  )
})

// --- Терпимый разбор каталога через корп-роут (S-V14; AC-160, AC-161, AC-165, AC-168) ---

describe("витрина — устойчивость разбора каталога (AC-160, AC-161, AC-165, AC-168)", () => {
  /** Карточка живого Hub с адресом мока: ядро то же, форма полей — снятая с живого стенда. */
  const liveCard = (url: string) => ({ ...liveTagCard(), mcp_url: `${url}/mcp/tag` })
  const withoutAlias = { title: "Без alias", mode: "facade", mcp_url: "https://hub.test/mcp/x" }
  const brokenMode = { alias: "gitlab", title: "GitLab", mode: "proxy", mcp_url: "https://hub.test/mcp/gitlab" }

  it.live("AC-165: GET /corp/catalog отдаёт принятые карточки и dropped, а в лог уходит alias с полем", () =>
    Effect.gen(function* () {
      state.hub.catalog = {
        version: 1,
        servers: [liveCard(state.hub.url), withoutAlias, brokenMode, { ...FACADE, mcp_url: `${state.hub.url}/mcp/g` }],
      }

      const response = yield* get(`${CorpPaths.catalog}`)
      const view = yield* body<{
        servers: { alias: string }[]
        dropped?: { alias?: string; reason: string }[]
        hub_error?: string
      }>(response)

      expect(view.hub_error).toBeUndefined()
      expect(view.servers.map((server) => server.alias)).toEqual(["tag", FACADE.alias])
      expect(view.dropped).toEqual([{ reason: "alias" }, { alias: "gitlab", reason: "mode" }])

      const warnings = logs.filter((entry) => entry.text.includes("cards dropped"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]!.level).toBe("Warn")
      // В журнале — alias и путь к полю; тела ответа Hub, ключа и poll_secret там нет (S-V14 п.5).
      expect(warnings[0]!.text).toContain("gitlab")
      expect(warnings[0]!.text).toContain("mode")
      const journal = logs.map((entry) => entry.text).join("\n")
      expect(journal).not.toContain(KEY)
      expect(journal).not.toContain("secret-do-not-leak")
      expect(journal).not.toContain("mcp_url")
      expect(journal).not.toContain(liveTagCard()["description"] as string)
    }),
  )

  it.live("AC-161: все карточки отброшены — витрина получает пустой список и число отброшенных", () =>
    Effect.gen(function* () {
      state.hub.catalog = { version: 1, servers: [withoutAlias, brokenMode] }

      const view = yield* body<{
        servers: unknown[]
        dropped?: unknown[]
        hub_error?: string
        source: string
      }>(yield* get(`${CorpPaths.catalog}`))

      // Отличие от «Hub недоступен»: ответ пришёл, источник — Hub, ошибки нет.
      expect(view.source).toBe("hub")
      expect(view.hub_error).toBeUndefined()
      expect(view.servers).toEqual([])
      // Отличие от «Каталог пуст»: карточки были, но ни одна не разобрана.
      expect(view.dropped).toHaveLength(2)
    }),
  )

  it.live("AC-161: Hub ответил servers:[] — «Каталог пуст», поля dropped в ответе нет", () =>
    Effect.gen(function* () {
      state.hub.catalog = { version: 1, servers: [] }

      const view = yield* body<{ servers: unknown[]; dropped?: unknown[]; hub_error?: string }>(
        yield* get(`${CorpPaths.catalog}`),
      )

      expect(view.servers).toEqual([])
      expect(view.dropped).toBeUndefined()
      expect(view.hub_error).toBeUndefined()
    }),
  )

  it.live("AC-168: живой конверт с version числом принимается, наружу и в кэш уходит строка", () =>
    Effect.gen(function* () {
      const live = liveCatalogBody()
      live["servers"] = [liveCard(state.hub.url)]
      expect(live["version"]).toBe(1)
      state.hub.catalog = live

      const view = yield* body<{ version: string; source: string; servers: { alias: string; mode: string }[] }>(
        yield* get(`${CorpPaths.catalog}`),
      )

      expect(view.source).toBe("hub")
      expect(view.version).toBe("1")
      expect(view.servers.map((server) => server.alias)).toEqual(["tag"])

      const cached = yield* Effect.promise(() => CorpCatalogCache.read(state.hub.url))
      expect(cached?.version).toBe("1")
      expect(cached?.servers.map((server) => server.alias)).toEqual(["tag"])

      // `catalog_version` статуса читается из того же кэша (S-A11).
      const status = yield* body<{ catalog_version?: string }>(yield* get(CorpPaths.status))
      expect(status.catalog_version).toBe("1")
    }),
  )

  it.live("AC-160: нарушенный конверт — hub_invalid_response, кэш не перезаписан", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        CorpCatalogCache.write({
          hubUrl: state.hub.url,
          fetchedAt: Date.now(),
          version: "кэш до сбоя",
          servers: [{ alias: "tag", title: "ТЭГ", mode: "facade", mcp_url: `${state.hub.url}/mcp/tag` }],
        }),
      )
      // Конверт нарушен: `version` недопустимого типа, карточка при этом валидна.
      state.hub.catalog = { version: null, servers: [liveCard(state.hub.url)] }

      const view = yield* body<{ hub_error?: string; source: string; version: string; servers: { alias: string }[] }>(
        yield* get(`${CorpPaths.catalog}`),
      )

      expect(view.hub_error).toBe("hub_invalid_response")
      // Витрина ведёт себя как при недоступном Hub: карточки — из кэша, который не перезаписан.
      expect(view.source).toBe("cache")
      expect(view.version).toBe("кэш до сбоя")
      const cached = yield* Effect.promise(() => CorpCatalogCache.read(state.hub.url))
      expect(cached?.version).toBe("кэш до сбоя")
    }),
  )
})
