import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fsSync from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Инвалидация провайдера после смены ключа в живом процессе (S-A3, S-A14 п.4, S-C11 п.4; BUG-I12-002).
 *
 * `Config.invalidate()` сбрасывает только кэш глобального конфига. Список провайдеров и их ключи
 * живут в состоянии инстанса (`InstanceState` в `provider/provider.ts`): ключ читается из
 * auth-store **один раз**, при построении состояния, и после этого живой процесс держит его,
 * сколько живёт инстанс. Три места роняли ровно это (`server/routes/instance/httpapi/handlers/corp.ts`):
 * вход (`handlePoll`, ready), выход (`logout`, `keyRemoved`) и возврат провайдера (`providerEnable`).
 * Правильный ответ — не «запрос заблокирован», а именно очищенное состояние: охранник S-C4b
 * (`corp/model.ts::guard`) читает auth-store НАПРЯМУЮ на каждое обращение и после выхода блокирует
 * запрос независимо от состояния провайдера — это маскирует дефект (см. ниже).
 *
 * Проверяется через настоящий `opencode serve` (тем же приёмом, что `model.test.ts`, AC-134/AC-135):
 * вход/выход/возврат провайдера идут по HTTP тех же роутов, что использует продукт, а состояние
 * провайдера читается роутом `GET /provider` (поле `key` — сырое значение из auth-store,
 * `provider/provider.ts` строка «load apikeys») — в обход охранника, поэтому маскировка не мешает
 * увидеть настоящий дефект.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const ENTRY = path.join(ROOT, "packages/opencode/src/index.ts")

const HUB_KEY = "sk-hub-issued-invalidation"
const USER = { user_id: "u1" }
const ANSWER = "ОТВЕТ-КОРПОРАТИВНОЙ-МОДЕЛИ"

const MESSAGES = {
  noKey: "Вход через корпоративный SSO не выполнен: нет ключа для Magnit Copilot",
}

const tmpDirs: string[] = []
afterAll(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function mkdtemp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Пустая заглушка браузера: серверная часть открывает `browser_url` пакетом `open` (S-D8). */
async function browserStub() {
  const dir = await mkdtemp("corp-invalidation-bin-")
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(dir, name)
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n")
    await fs.chmod(file, 0o755)
  }
  return dir
}

const stubPath = await browserStub()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface LiteLLMHit {
  method: string
  path: string
  authorization: string | null
}

/** Мок корпоративного LiteLLM (как в `model.test.ts`): SSE-ответ формата OpenAI, журнал обращений. */
function startLiteLLM() {
  const hits: LiteLLMHit[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      hits.push({ method: request.method, path: url.pathname, authorization: request.headers.get("authorization") })
      if (!url.pathname.endsWith("/chat/completions")) return json({ error: "not_found" }, 404)
      const chunks = [
        { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: ANSWER } }] },
        { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]
      const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(text, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) }
}

/** Мок Hub: вход выдаёт постоянный ключ сразу, DELETE /api/me/key отвечает успешным отзывом. */
function startHub() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/health") return json({ status: "ok" })
      if (url.pathname === "/cli/start" && request.method === "POST")
        return json({
          login_id: "login-1",
          poll_secret: "poll-secret-do-not-leak",
          browser_url: `${url.origin}/ui/login/login-1`,
          user_code: "MGNT-0001",
          expires_in: 120,
        })
      if (/^\/cli\/poll\/[^/]+$/.test(url.pathname))
        return json({ status: "ready", key: HUB_KEY, key_kind: "persistent", user: USER })
      if (url.pathname === "/api/me/key" && request.method === "DELETE") return json({ revoked: true })
      if (url.pathname === "/api/me") return json({ ...USER, key_kind: "persistent" })
      return json({ error: "not_found" }, 404)
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

interface HomeInput {
  /** Глобальный конфиг пользователя; без него файла нет вовсе. */
  global?: object
  /** Запись auth-store `magnit_prod`; без неё вход не выполнен. */
  key?: string
}

async function makeHome(input: HomeInput = {}) {
  const home = await mkdtemp("corp-invalidation-")
  for (const sub of ["data", "config", "cache", "state"]) await fs.mkdir(path.join(home, sub), { recursive: true })
  const project = path.join(home, "project")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "README.md"), "проект для теста")

  const globalFile = path.join(home, "config", "opencode", "opencode.json")
  if (input.global) {
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.writeFile(globalFile, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...input.global }, null, 2))
  }
  if (input.key) {
    const authFile = path.join(home, "data", "opencode", "auth.json")
    await fs.mkdir(path.dirname(authFile), { recursive: true })
    await fs.writeFile(
      authFile,
      JSON.stringify({ magnit_prod: { type: "api", key: input.key, metadata: { hub: "http://hub.test" } } }),
      { mode: 0o600 },
    )
  }
  return { home, project, globalFile }
}

/** Корп-слой ровно того же вида, что `corp/config/opencode.corp.json` (S-C4), но с адресом мока. */
const corpConfig = (baseURL: string) => ({
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  enabled_providers: ["magnit_prod"],
  model: "magnit_prod/MagnitCopilot",
  provider: {
    magnit_prod: {
      npm: "@ai-sdk/openai-compatible",
      name: "Magnit Copilot",
      options: { baseURL },
      models: {
        MagnitCopilot: { name: "Magnit Copilot", tool_call: true, limit: { context: 200000, output: 32000 } },
      },
    },
  },
})

const childEnv = (input: { home: string; corp: object; hub: string }) => ({
  ...process.env,
  PATH: `${stubPath}:${process.env["PATH"] ?? ""}`,
  XDG_DATA_HOME: path.join(input.home, "data"),
  XDG_CONFIG_HOME: path.join(input.home, "config"),
  XDG_CACHE_HOME: path.join(input.home, "cache"),
  XDG_STATE_HOME: path.join(input.home, "state"),
  OPENCODE_CORP_CONFIG: JSON.stringify(input.corp),
  OPENCODE_CORP_HUB_URL: input.hub,
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  NO_COLOR: "1",
  CI: "1",
})

function freePort() {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = probe.port
  probe.stop(true)
  return port
}

const running: { kill: () => void }[] = []
afterEach(() => {
  while (running.length) running.pop()!.kill()
})

/** Один долгоживущий процесс `opencode serve` — вход/выход/возврат провайдера идут в нём без перезапуска. */
async function serve(input: { home: string; project: string; corp: object; hub: string }) {
  const port = freePort()
  const proc = Bun.spawn({
    cmd: ["bun", "run", "--conditions=browser", ENTRY, "serve", "--port", String(port), "--hostname", "127.0.0.1"],
    cwd: input.project,
    env: childEnv(input),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  running.push({ kill: () => proc.kill() })
  const base = `http://127.0.0.1:${port}`
  const headers = { "content-type": "application/json", "x-opencode-directory": input.project }

  for (let attempt = 0; ; attempt++) {
    if (attempt > 120) throw new Error("сервер не поднялся")
    try {
      const probe = await fetch(`${base}/corp/status`, { headers })
      if (probe.status < 500) break
    } catch {}
    await Bun.sleep(500)
  }

  const api = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    return { status: response.status, text, json: () => JSON.parse(text) }
  }
  return { base, api }
}

/** Один запрос к корпоративной модели через уже работающий сервер (как в `model.test.ts`). */
const prompt = async (api: Awaited<ReturnType<typeof serve>>["api"], text = "скажи привет") => {
  const session = (await api("POST", "/session", {})).json()
  return api("POST", `/session/${session.id}/message`, {
    parts: [{ type: "text", text }],
    model: { providerID: "magnit_prod", modelID: "MagnitCopilot" },
  })
}

/** Запись `magnit_prod` из `GET /provider` — сырое состояние провайдера, в обход охранника S-C4b. */
function providerEntry(list: { all: { id: string; key?: string }[] }) {
  return list.all.find((provider) => provider.id === "magnit_prod")
}

// --- S-A3: вход в уже запущенном процессе (BUG-I12-002) ---

describe("вход в уже запущенном процессе доводит ключ до провайдера (S-A3; AC-17, AC-18, AC-134)", () => {
  test(
    "AC-18, AC-134: после входа ключ появляется в состоянии провайдера без перезапуска — одного Config.invalidate() для этого мало",
    async () => {
      const hub = startHub()
      try {
        const { home, project } = await makeHome()
        const corp = corpConfig("http://llm.invalid")
        const { api } = await serve({ home, project, corp, hub: hub.url })

        // Форсирует построение состояния инстанса ДО входа: без этого шага регрессия не
        // проявляется, кэш строится лениво при первом обращении и подхватил бы ключ сам.
        // Это ровно то, что воспроизвёл dev-агент: «старт без ключа -> Provider.list() -> key===undefined».
        const before = providerEntry((await api("GET", "/provider")).json())
        expect(before, "провайдер magnit_prod отсутствует в списке до входа").toBeDefined()
        expect(before!.key).toBeUndefined()

        const started = (await api("POST", "/corp/login/start", {})).json()
        const polled = (await api("GET", `/corp/login/poll/${started.login_id}`)).json()
        expect(polled.status).toBe("ready")

        // Тот же процесс, без перезапуска (S-A3, AC-18): состояние провайдера обязано обновиться.
        const after = providerEntry((await api("GET", "/provider")).json())
        expect(after?.key, "ключ не дошёл до провайдера без перезапуска — BUG-I12-002 (S-A3)").toBe(HUB_KEY)
      } finally {
        hub.stop()
      }
    },
    180_000,
  )

  test(
    "AC-134: первый же запрос к модели после входа уходит с заголовком Authorization из auth-store",
    async () => {
      const llm = startLiteLLM()
      const hub = startHub()
      try {
        const { home, project } = await makeHome()
        const corp = corpConfig(`${llm.url}/v1`)
        const { api } = await serve({ home, project, corp, hub: hub.url })

        // Тот же форсирующий шаг, что выше: без него сценарий не отличает «состояние построено
        // заново» от «состояние никогда не строилось».
        providerEntry((await api("GET", "/provider")).json())

        const started = (await api("POST", "/corp/login/start", {})).json()
        const polled = (await api("GET", `/corp/login/poll/${started.login_id}`)).json()
        expect(polled.status).toBe("ready")

        expect(llm.hits).toHaveLength(0)
        const answer = await prompt(api)
        expect(answer.status).toBe(200)

        const first = llm.hits[0]
        expect(first, "запрос к LiteLLM не ушёл").toBeDefined()
        expect(first!.authorization).toBe(`Bearer ${HUB_KEY}`)
        expect(answer.text).toContain(ANSWER)
      } finally {
        llm.stop()
        hub.stop()
      }
    },
    180_000,
  )
})

// --- S-A14 п.4: выход инвалидирует провайдера, а не только блокирует запрос (BUG-I12-002) ---

describe("выход инвалидирует провайдера без перезапуска (S-A14 п.4; AC-279)", () => {
  test(
    "AC-279: после выхода ключ уходит из состояния провайдера — маскировка охранником S-C4b не подменяет эту проверку",
    async () => {
      const llm = startLiteLLM()
      const hub = startHub()
      try {
        const { home, project } = await makeHome({ key: HUB_KEY })
        const corp = corpConfig(`${llm.url}/v1`)
        const { api } = await serve({ home, project, corp, hub: hub.url })

        // Построение состояния с ключом — обычный рабочий процесс до выхода.
        const before = providerEntry((await api("GET", "/provider")).json())
        expect(before?.key).toBe(HUB_KEY)

        const logout = (await api("POST", "/corp/logout", {})).json()
        expect(logout.key_removed).toBe(true)

        // Наблюдение 1 (то, что видно снаружи, через модель): охранник S-C4b читает auth-store
        // НАПРЯМУЮ на каждое обращение, поэтому запрос блокируется независимо от того, очищено ли
        // состояние провайдера. Само по себе это НЕ доказывает исправность — ровно это и маскировало
        // BUG-I12-002 на возврате входа: см. следующую проверку.
        const answer = await prompt(api)
        expect(llm.hits).toHaveLength(0)
        expect(answer.text).toContain(MESSAGES.noKey)

        // Наблюдение 2 (настоящая проверка S-A14 п.4): состояние провайдера читается в обход
        // охранника (`GET /provider`). Ключ обязан исчезнуть без перезапуска — если бы инвалидация
        // на выходе не выполнялась, здесь остался бы прежний ключ, а охранник продолжал бы
        // маскировать дефект тем же способом, что описан в BUG-I12-002.
        const after = providerEntry((await api("GET", "/provider")).json())
        expect(after?.key, "ключ остался в состоянии провайдера после выхода — BUG-I12-002 (S-A14 п.4)").toBeUndefined()
      } finally {
        llm.stop()
        hub.stop()
      }
    },
    180_000,
  )
})

// --- S-C11 п.4: возврат выключенного провайдера доступен без перезапуска (BUG-I12-002) ---

describe("возврат провайдера доступен без перезапуска (S-C11 п.4)", () => {
  test(
    "провайдер, снятый с disabled_providers, появляется в списке и получает ключ без перезапуска",
    async () => {
      const hub = startHub()
      try {
        const { home, project, globalFile } = await makeHome({
          global: { disabled_providers: ["magnit_prod"] },
          key: HUB_KEY,
        })
        const corp = corpConfig("http://llm.invalid")
        const { api } = await serve({ home, project, corp, hub: hub.url })

        // Выключенный disabled_providers провайдер целиком отсутствует в списке (provider.ts:
        // «delete providers[providerID]» для неразрешённых).
        const before = providerEntry((await api("GET", "/provider")).json())
        expect(before, "провайдер не должен быть виден, пока выключен disabled_providers").toBeUndefined()

        const enabled = (await api("POST", "/corp/provider/enable", {})).json()
        expect(enabled.changed).toBe(true)

        // Тот же процесс, без перезапуска: провайдер обязан вернуться в список сразу с ключом.
        const after = providerEntry((await api("GET", "/provider")).json())
        expect(after, "провайдер не появился в списке без перезапуска — BUG-I12-002 (S-C11 п.4)").toBeDefined()
        expect(after!.key).toBe(HUB_KEY)

        const global = JSON.parse(await fs.readFile(globalFile, "utf8"))
        expect(global.disabled_providers ?? []).not.toContain("magnit_prod")
      } finally {
        hub.stop()
      }
    },
    180_000,
  )
})

// --- Быстрый структурный сторож: все три места зовут invalidateProviders() (BUG-I12-002) ---

/**
 * Дополняет три HTTP-теста выше быстрой и точной диагностикой: если один из трёх вызовов пропадёт
 * (тот же приём, что `logout-route.test.ts::handlerBlock`), этот тест укажет, в какой именно ветке
 * — быстрее, чем ждать сценарий с реальным подпроцессом. Сам по себе он не заменяет три теста выше:
 * текст может звать функцию, которая ничего не делает, — только их поведенческая проверка (в том
 * числе через реальный `disposeAllInstancesAndEmitGlobalDisposed`) доказывает, что вызов
 * действительно чистит состояние провайдера.
 */
describe("все три места фикса зовут invalidateProviders() (S-A3, S-A14 п.4, S-C11 п.4; BUG-I12-002)", () => {
  const HANDLER = path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/handlers/corp.ts")
  const handlerSource = fsSync.readFileSync(HANDLER, "utf8")

  function handlerBlock(marker: string) {
    const at = handlerSource.indexOf(marker)
    expect(at, `не найдено объявление ${marker} в обработчике корп-роутов`).toBeGreaterThan(-1)
    const args = handlerSource.indexOf("(", handlerSource.indexOf("function*", at))
    let round = 0
    let body = -1
    for (let index = args; index < handlerSource.length; index++) {
      if (handlerSource[index] === "(") round += 1
      else if (handlerSource[index] === ")") {
        round -= 1
        if (round === 0) {
          body = handlerSource.indexOf("{", index)
          break
        }
      }
    }
    expect(body, `не найдено тело ${marker}`).toBeGreaterThan(-1)
    let depth = 0
    for (let index = body; index < handlerSource.length; index++) {
      if (handlerSource[index] === "{") depth += 1
      else if (handlerSource[index] === "}") {
        depth -= 1
        if (depth === 0) return handlerSource.slice(body + 1, index)
      }
    }
    throw new Error(`блок ${marker} не закрыт`)
  }

  test("S-A3: ready-ветка handlePoll зовёт invalidateProviders() после configSvc.invalidate()", () => {
    const body = handlerBlock("const handlePoll = Effect.fnUntraced(function* (")
    const configAt = body.indexOf("yield* configSvc.invalidate()")
    const providersAt = body.indexOf("yield* invalidateProviders()")
    expect(configAt, body).toBeGreaterThan(-1)
    expect(providersAt, body).toBeGreaterThan(-1)
    expect(configAt).toBeLessThan(providersAt)
  })

  test("S-A14 п.4: logout зовёт invalidateProviders() при keyRemoved, тем же условием, что configSvc.invalidate()", () => {
    const body = handlerBlock('const logout = Effect.fn("CorpHttpApi.logout")')
    expect(body).toContain("if (outcome.keyRemoved) yield* configSvc.invalidate()")
    expect(body).toContain("if (outcome.keyRemoved) yield* invalidateProviders()")
  })

  test("S-C11 п.4: providerEnable зовёт invalidateProviders() после updateGlobal и до пересчёта providerDisabled()", () => {
    const body = handlerBlock('const providerEnable = Effect.fn("CorpHttpApi.providerEnable")')
    const updateAt = body.indexOf("configSvc.updateGlobal(patch)")
    const providersAt = body.indexOf("yield* invalidateProviders()")
    const afterAt = body.indexOf("const after = yield* providerDisabled()")
    expect(updateAt, body).toBeGreaterThan(-1)
    expect(providersAt, body).toBeGreaterThan(-1)
    expect(afterAt, body).toBeGreaterThan(-1)
    expect(updateAt).toBeLessThan(providersAt)
    expect(providersAt).toBeLessThan(afterAt)
  })
})
