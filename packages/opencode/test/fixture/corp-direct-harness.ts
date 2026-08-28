import fs from "fs/promises"
import os from "os"
import path from "path"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "@/env"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { InstanceStore } from "@/project/instance-store"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import { ConfigApi } from "@/server/routes/instance/httpapi/groups/config"
import { CorpApi, CorpPaths } from "@/server/routes/instance/httpapi/groups/corp"
import { configGet } from "@/server/routes/instance/httpapi/handlers/config"
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
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { testInstanceStoreLayer } from "./fixture"
import { testEffect } from "../lib/effect"

/**
 * Обвязка для проверки прямого подключения (S-V25…S-V29, ревизия 1.13) через настоящий локальный
 * HTTP-сервер корп-роутов — общая для `connect-token.test.ts` и `credentials-leak.test.ts`, чтобы не
 * заводить копию обвязки `orchestration.test.ts` во второй раз.
 *
 * Отличие от обвязки `orchestration.test.ts`: Hub здесь **не поднимается вовсе** — прямой режим о
 * нём не знает и знать не должен (S-V25 п.8). Вместо Hub — один сервер «целевой системы»
 * (`DirectServer`), который тесты перепрограммируют перед каждым сценарием: он же отдаёт статический
 * каталог (если тест задал `OPENCODE_CORP_CATALOG_URL` на него), он же отвечает на `verify`,
 * `exchange`, `revoke` и на адрес `upstream.url`.
 *
 * Внешних систем, кроме этого сервера, нет: MCP замокан на границе сервиса (журнал вызовов, а не
 * сеть), браузер — пустая заглушка `open`/`xdg-open` в `PATH`, глобальный конфиг и каталог данных —
 * временные.
 */

export interface RequestLog {
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}

export interface DirectServer {
  url: string
  requests: RequestLog[]
  /** Маршруты по точному пути (`/catalog`, `/verify`, …); не найден — 404. */
  routes: Map<string, (request: Request, url: URL) => Response | Promise<Response>>
  /** Тест переопределяет перед сценарием, где путь неудобен как ключ карты; проверяется первым. */
  handler?: (request: Request, url: URL) => Response | Promise<Response> | undefined
  stop: () => void
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function startDirectServer(): DirectServer {
  const mock: DirectServer = {
    url: "",
    requests: [],
    routes: new Map(),
    stop: () => {},
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => {
        headers[name] = value
      })
      const bodyText = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text()
      mock.requests.push({
        method: request.method,
        path: url.pathname,
        headers,
        ...(bodyText === undefined ? {} : { body: bodyText }),
      })
      const custom = mock.handler?.(request, url)
      if (custom !== undefined) return custom
      const route = mock.routes.get(url.pathname)
      if (route) return route(request, url)
      return new Response("not found", { status: 404 })
    },
  })
  mock.url = `http://127.0.0.1:${server.port}`
  mock.stop = () => server.stop(true)
  return mock
}

// --- Граница MCP (F13/F14/F17): журнал вызовов вместо сети ---

export type Status = MCP.Status

export interface HarnessState {
  target: DirectServer
  directory: string
  statuses: Record<string, Status>
  addStatus: Status
  authenticate: (name: string) => Status
  calls: string[]
  added: { name: string; mcp: unknown }[]
  key?: string
}

export let state: HarnessState

const authLayer = Layer.mock(Auth.Service)({
  get: (providerID: string) =>
    Effect.succeed(
      providerID === "magnit_prod" && state.key !== undefined ? new Auth.Api({ type: "api", key: state.key }) : undefined,
    ),
  all: () => Effect.succeed({}),
  set: (key: string) => Effect.sync(() => void state.calls.push(`auth.set:${key}`)),
  remove: () => Effect.void,
})

const mcpLayer = Layer.mock(MCP.Service)({
  status: () => Effect.sync(() => ({ ...state.statuses })),
  add: (name: string, mcp: any) =>
    Effect.sync(() => {
      state.calls.push(`add:${name}`)
      state.added.push({ name, mcp })
      state.statuses[name] = state.addStatus
      return { status: { ...state.statuses } }
    }),
  authenticate: (name: string) =>
    Effect.sync(() => {
      state.calls.push(`authenticate:${name}`)
      const status = state.authenticate(name)
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

// S-Q14: `GET /config` — surface AC-326 requires checked for leak alongside the corp routes; the
// group needs `Provider.Service`, unused by any corp/leak scenario, so it is mocked bare-bones.
const providerLayer = Layer.mock(Provider.Service)({
  list: () => Effect.succeed({}),
  getProvider: () => Effect.die(new Error("providerLayer: getProvider not mocked")),
  getModel: () => Effect.die(new Error("providerLayer: getModel not mocked")),
  getLanguage: () => Effect.die(new Error("providerLayer: getLanguage not mocked")),
  closest: () => Effect.succeed(undefined),
  getSmallModel: () => Effect.succeed(undefined),
  defaultModel: () => Effect.die(new Error("providerLayer: defaultModel not mocked")),
})

/**
 * `GET /config` (S-Q14, AC-326) вызывает продуктовый `configGet` (`handlers/config.ts`, MIN-A) —
 * с ревизии 1.13.5 это экспортируемый именованный эффект, отделённый от `configHandlers` ровно
 * затем, чтобы харнесс мог позвать его без остального: сборка `handlers/config.ts` целиком
 * по-прежнему ломает вывод типов `HttpApiBuilder.group` тем же образом, что и раньше — обработчик
 * `update` вызывает `markInstanceForDisposal(yield* InstanceState.context)`, и это — единственное
 * отличие от `corpHandlers`, ни один обработчик которого через `HttpEffect.appendPreResponseHandler`
 * не проходит, — требование `Session.Service`, которое `WorkspaceRoutingMiddleware` объявляет как
 * `requires` (и которое у `corpHandlers` благополучно сворачивается охватывающим
 * `Layer.provide(Layer.mock(Session.Service)({}))`), у `configHandlers` остаётся заочно не
 * свёрнутым. Ни утечка, ни `PATCH /config` этим тестам не нужны — нужен только `GET /config` рядом
 * с корп-роутами, поэтому здесь минимальная группа `"config"` `InstanceHttpApi`, где `get` зовёт
 * продуктовую функцию, а `update`/`providers` остаются локальными заглушками без обращения к
 * `InstanceState.context`/`markInstanceForDisposal`.
 *
 * `get` не передаёт `configGet` в `.handle(...)` напрямую: сама функция заново запрашивает
 * `Config.Service` (`yield* Config.Service` внутри её тела, а не готовое значение из замыкания), и
 * это неразвёрнутое требование не сворачивается той же самой известной особенностью вывода типов,
 * что и `Session.Service` у полного `configHandlers` (см. выше) — тот же симптом, только у другого
 * тега, и всплывает он не в момент `.handle()`, а много ниже по цепочке `served`, на самом
 * `HttpApiBuilder.layer(TestHttpApi)`. Локальная обёртка вызывает **ровно** `configGet()` и тут же
 * подставляет ему уже добытый `configSvc` через `Effect.provideService` — это не переопределение
 * поведения (тело `configGet` выполняется целиком, как есть), а лишь способ отдать типам то же
 * самое значение, что и так лежит в замыкании. Утечка, внесённая в продуктовое тело `configGet`,
 * этим не маскируется: харнесс исполняет продуктовую функцию, а не свою копию.
 *
 * До этой правки `get` был локальной копией тела продукта, и сьют `credentials-leak.test.ts`
 * проверял утечку в копии, а не в продукте (сторож MIN-A на срез-сравнение исходников снят вместе
 * с этой правкой за ненадобностью — копий больше нет, сравнивать нечего).
 */
const configHandlers = HttpApiBuilder.group(InstanceHttpApi, "config", (handlers) =>
  Effect.gen(function* () {
    const configSvc = yield* Config.Service
    const providerSvc = yield* Provider.Service
    // Приём — как в `handlers/config.ts`: обработчик объявляется ИМЕНОВАННОЙ константой, а не
    // инлайном внутри `.handle(...)`, иначе контекстная типизация схемы `payload` (`readonly`
    // поля) не совпадает с мутабельным `Info`, которым живёт `Config.Service.update`.
    const update = Effect.fn("TestConfigHttpApi.update")(function* (ctx) {
      yield* configSvc.update(ctx.payload)
      return ctx.payload
    })
    const providers = Effect.fn("TestConfigHttpApi.providers")(function* () {
      const providers = yield* providerSvc.list()
      return {
        providers: Object.values(providers).map(Provider.toPublicInfo),
        default: Provider.defaultModelIDs(providers),
      }
    })
    const get = Effect.fn("TestConfigHttpApi.get")(function* () {
      return yield* configGet().pipe(Effect.provideService(Config.Service, configSvc))
    })
    return handlers.handle("get", get).handle("update", update).handle("providers", providers)
  }),
)

const TestHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(CorpApi)
  .addHttpApi(ConfigApi)
  .middleware(SchemaErrorMiddleware)

const infra = CrossSpawnSpawner.defaultLayer.pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

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

const passthroughAuthorization = Layer.succeed(Authorization, Authorization.of((effect) => effect))

const workspaceRoutingLayer = Layer.succeed(
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingMiddleware.of((effect) =>
    Effect.suspend(() =>
      effect.pipe(Effect.provideService(WorkspaceRouteContext, WorkspaceRouteContext.of({ directory: state.directory }))),
    ),
  ),
)

export const logs: { level: string; text: string }[] = []
const captureLogger = Logger.make<unknown, void>((options) => {
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
    Layer.provide(configHandlers),
    Layer.provide([passthroughAuthorization, workspaceRoutingLayer, schemaErrorLayer]),
    Layer.provide(Layer.mock(Session.Service)({})),
    Layer.provide(instanceContextLayer),
    Layer.provide(testInstanceStoreLayer),
    Layer.provide(mcpLayer),
    Layer.provide(authLayer),
    Layer.provide(configLayer),
    Layer.provide(providerLayer),
    Layer.provide(Logger.layer([captureLogger])),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(Layer.provideMerge(NodeHttpServer.layerTest), Layer.provideMerge(infra))

/** `it.live(name, () => Effect.gen(...))` — тот же приём, что в `orchestration.test.ts`. */
export const it = testEffect(served)

// --- Обвязка вокруг файловой системы и окружения ---

const tmpDirs: string[] = []
let previousGlobalConfig: string
let previousGlobalData: string
let previousPath: string | undefined
let previousBrowser: string | undefined
let previousCatalogUrl: string | undefined
let previousHubUrl: string | undefined
let browserLog: string
let stubDir: string

export async function tmp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

async function browserStub() {
  const dir = await tmp("corp-direct-open-")
  browserLog = path.join(dir, "opened.txt")
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(dir, name)
    await fs.writeFile(file, `#!/bin/sh\necho "$@" >> ${browserLog}\nexit 0\n`)
    await fs.chmod(file, 0o755)
  }
  return dir
}

/** Число строк, записанных заглушкой браузера за сеанс — «браузер не открыт ни разу» (S-V28 п.5, п.8). */
export async function browserOpenCount(): Promise<number> {
  const text = await fs.readFile(browserLog, "utf8").catch(() => "")
  return text.split("\n").filter((line) => line.trim() !== "").length
}

export async function setupHarness() {
  stubDir = await browserStub()
}

export async function beforeEachHarness() {
  const target = startDirectServer()
  const globalDir = await tmp("corp-direct-global-")
  await fs.writeFile(path.join(globalDir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
  previousGlobalConfig = Global.Path.config
  ;(Global.Path as { config: string }).config = globalDir
  previousGlobalData = Global.Path.data
  ;(Global.Path as { data: string }).data = await tmp("corp-direct-data-")
  previousPath = process.env["PATH"]
  process.env["PATH"] = `${stubDir}${path.delimiter}${previousPath ?? ""}`
  previousBrowser = process.env["BROWSER"]
  process.env["BROWSER"] = path.join(stubDir, "open")
  previousCatalogUrl = process.env["OPENCODE_CORP_CATALOG_URL"]
  previousHubUrl = process.env["OPENCODE_CORP_HUB_URL"]
  delete process.env["OPENCODE_CORP_CATALOG_URL"]
  delete process.env["OPENCODE_CORP_HUB_URL"]
  await fs.rm(browserLog, { force: true })

  logs.length = 0
  state = {
    target,
    directory: await tmp("corp-direct-work-"),
    statuses: {},
    addStatus: { status: "disabled" },
    authenticate: () => ({ status: "connected" }),
    calls: [],
    added: [],
  }
}

export function afterEachHarness() {
  state.target.stop()
  ;(Global.Path as { config: string }).config = previousGlobalConfig
  ;(Global.Path as { data: string }).data = previousGlobalData
  if (previousPath === undefined) delete process.env["PATH"]
  else process.env["PATH"] = previousPath
  if (previousBrowser === undefined) delete process.env["BROWSER"]
  else process.env["BROWSER"] = previousBrowser
  if (previousCatalogUrl === undefined) delete process.env["OPENCODE_CORP_CATALOG_URL"]
  else process.env["OPENCODE_CORP_CATALOG_URL"] = previousCatalogUrl
  if (previousHubUrl === undefined) delete process.env["OPENCODE_CORP_HUB_URL"]
  else process.env["OPENCODE_CORP_HUB_URL"] = previousHubUrl
}

export async function cleanupTmpDirs() {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    // Права могли быть намеренно сужены сценарием «хранилище недоступно для записи» (AC-324) —
    // возвращаем их перед удалением, иначе `fs.rm` откажет тем же способом.
    await fs.chmod(dir, 0o700).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** Содержимое глобального конфига пользователя после действий (S-C7, S-V25 п.6). */
export async function globalConfig(): Promise<any> {
  const file = path.join(Global.Path.config, "opencode.json")
  return JSON.parse(await fs.readFile(file, "utf8"))
}

export async function globalConfigText(): Promise<string> {
  const file = path.join(Global.Path.config, "opencode.json")
  return fs.readFile(file, "utf8")
}

export async function credentialsFileText(): Promise<string | undefined> {
  const file = path.join(Global.Path.data, "corp", "connector-credentials.json")
  return fs.readFile(file, "utf8").catch(() => undefined)
}

export const post = (route: string, payload?: unknown) =>
  payload === undefined
    ? HttpClientRequest.post(route).pipe(HttpClient.execute)
    : HttpClientRequest.post(route).pipe(HttpClientRequest.bodyJson(payload), Effect.orDie, Effect.flatMap(HttpClient.execute))

export const put = (route: string, body: unknown) =>
  HttpClientRequest.put(route).pipe(HttpClientRequest.bodyJson(body), Effect.orDie, Effect.flatMap(HttpClient.execute))

export const del = (route: string) => HttpClientRequest.delete(route).pipe(HttpClient.execute)

export const get = (route: string) => HttpClientRequest.get(route).pipe(HttpClient.execute)

export const connectRoute = (alias: string) => CorpPaths.connect.replace(":alias", alias)
export const connectTokenRoute = (alias: string) => CorpPaths.connectToken.replace(":alias", alias)
export const disconnectRoute = (alias: string) => CorpPaths.disconnect.replace(":alias", alias)
export const permissionsRoute = (alias: string) => CorpPaths.permissions.replace(":alias", alias)
export const forgetRoute = (alias: string) => CorpPaths.forget.replace(":alias", alias)
/** `GET /config` (S-Q14, AC-326) — surface checked for the leak marker alongside corp routes. */
export const configRoute = "/config"

export const body = <A>(response: { json: Effect.Effect<unknown, any, any> }) => response.json as Effect.Effect<A, any, any>

export { CorpPaths }
