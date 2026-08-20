import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

/**
 * Корпоративная модель после входа: адрес из корп-конфига, ключ из auth-store
 * (S-C4a, S-C4b, S-C9, S-A3; AC-134, AC-135, AC-136).
 *
 * Внешние системы не задействуются: LiteLLM и Hub — `Bun.serve` на 127.0.0.1, каталоги XDG
 * временные, браузер подменён пустым `open` в PATH. Вход и запрос к модели идут в **одном**
 * процессе `opencode serve` — так проверяется требование «без перезапуска» (S-C4b).
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const ENTRY = path.join(ROOT, "packages/opencode/src/index.ts")

/** Ключ, который корпоративный LiteLLM выдаёт при входе; попадает в auth-store (S-A3). */
const HUB_KEY = "sk-hub-issued"
/** Значение переменной MAGNIT_COPILOT_KEY: источником ключа она больше не является (S-C4b, D-21). */
const ENV_KEY = "sk-env-must-not-be-used"
const ANSWER = "ОТВЕТ-КОРПОРАТИВНОЙ-МОДЕЛИ"
const USER = { user_id: "u1" }
const POLL_SECRET = "poll-secret-do-not-leak"

/** Сообщения S-C4b и S-C9 §3: их формулировки — часть контракта. */
const MESSAGES = {
  noKey: "Вход через корпоративный SSO не выполнен: нет ключа для Magnit Copilot",
  noKeyAction: "Войти через корпоративный SSO",
  noKeyCliHint: "выполните opencode corp login",
  providerDisabled: "Провайдер Magnit Copilot выключен в вашем конфиге",
} as const

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
  const dir = await mkdtemp("corp-model-bin-")
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
  model?: string
}

/** Мок корпоративного LiteLLM: отдаёт SSE-ответ формата OpenAI и записывает все обращения. */
function startLiteLLM() {
  const hits: LiteLLMHit[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json().catch(() => ({}) as any) : ({} as any)
      hits.push({
        method: request.method,
        path: url.pathname,
        authorization: request.headers.get("authorization"),
        model: body?.model,
      })
      if (!url.pathname.endsWith("/chat/completions")) return json({ error: "not_found" }, 404)
      const chunks = [
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: ANSWER } }],
        },
        {
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      const text = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
      return new Response(text, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, port: server.port, hits, stop: () => server.stop(true) }
}

/** Мок Hub: вход завершается сразу выдачей постоянного ключа (S-A3). */
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
          poll_secret: POLL_SECRET,
          browser_url: `${url.origin}/ui/login/login-1`,
          user_code: "MGNT-0001",
          expires_in: 120,
        })
      if (/^\/cli\/poll\/[^/]+$/.test(url.pathname))
        return json({ status: "ready", key: HUB_KEY, key_kind: "persistent", user: USER })
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
  const home = await mkdtemp("corp-model-")
  for (const sub of ["data", "config", "cache", "state"]) await fs.mkdir(path.join(home, sub), { recursive: true })
  const project = path.join(home, "project")
  await fs.mkdir(project, { recursive: true })
  await fs.writeFile(path.join(project, "README.md"), "проект для теста")

  const globalFile = path.join(home, "config", "opencode", "opencode.json")
  if (input.global) {
    await fs.mkdir(path.dirname(globalFile), { recursive: true })
    await fs.writeFile(
      globalFile,
      JSON.stringify({ $schema: "https://opencode.ai/config.json", ...input.global }, null, 2),
    )
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

/** Корп-слой ровно того же вида, что `corp/config/opencode.corp.json`, но с адресом мока (S-C4). */
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

const childEnv = (input: { home: string; corp: object; hub: string; extra?: Record<string, string> }) => ({
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
  ...input.extra,
})

/** Свободный порт: `opencode serve` требует явного номера. */
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

/**
 * Один долгоживущий процесс `opencode serve`: вход и запрос к модели идут в нём без перезапуска.
 */
async function serve(input: { home: string; project: string; corp: object; hub: string; extra?: Record<string, string> }) {
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

/** Один запрос к корпоративной модели через уже работающий сервер. */
const prompt = async (api: Awaited<ReturnType<typeof serve>>["api"], text = "скажи привет") => {
  const session = (await api("POST", "/session", {})).json()
  return api("POST", `/session/${session.id}/message`, {
    parts: [{ type: "text", text }],
    model: { providerID: "magnit_prod", modelID: "MagnitCopilot" },
  })
}

/** `opencode run` — неинтерактивный режим (S-C4b п. 3). */
async function run(input: {
  home: string
  project: string
  corp: object
  hub: string
  extra?: Record<string, string>
  args: string[]
}) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "--conditions=browser", ENTRY, ...input.args],
    cwd: input.project,
    env: childEnv(input),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: stdout + stderr }
}

// --- AC-134: после входа чат работает без правки конфигов и без перезапуска ---

describe("корп-модель после входа (AC-134)", () => {
  test(
    "AC-134: первый запрос после входа уходит на адрес корп-конфига с ключом из auth-store",
    async () => {
      const llm = startLiteLLM()
      const hub = startHub()
      try {
        const { home, project, globalFile } = await makeHome()
        const corp = corpConfig(`${llm.url}/v1`)
        const { api } = await serve({ home, project, corp, hub: hub.url })

        // До входа ключа нет: auth-store пуст.
        const authFile = path.join(home, "data", "opencode", "auth.json")
        expect(await Bun.file(authFile).exists()).toBe(false)

        // Вход по корпоративному SSO в том же процессе сервера (S-A2…S-A3).
        const started = (await api("POST", "/corp/login/start", {})).json()
        const polled = (await api("GET", `/corp/login/poll/${started.login_id}`)).json()
        expect(polled.status).toBe("ready")

        const auth = JSON.parse(await fs.readFile(authFile, "utf8"))
        expect(auth["magnit_prod"]).toMatchObject({ type: "api", key: HUB_KEY })

        // Первый же запрос к модели — без единой правки конфигов и без перезапуска.
        expect(llm.hits).toHaveLength(0)
        const answer = await prompt(api)
        expect(answer.status).toBe(200)

        const first = llm.hits[0]
        expect(first, "запрос к LiteLLM не ушёл").toBeDefined()
        expect(first!.method).toBe("POST")
        expect(first!.path).toBe("/v1/chat/completions")
        expect(first!.authorization).toBe(`Bearer ${HUB_KEY}`)
        expect(first!.model).toBe("MagnitCopilot")

        // Ответ модели показан пользователю.
        expect(answer.text).toContain(ANSWER)

        // Конфиги пользователя и проекта не появились и не изменились (S-C7).
        expect(await Bun.file(globalFile).exists()).toBe(false)
        expect(await Bun.file(path.join(project, "opencode.json")).exists()).toBe(false)

        // Обращений к прежнему нерабочему адресу нет.
        expect(JSON.stringify(corp)).not.toContain("copilot.magnit.ru")
        expect(answer.text).not.toContain("copilot.magnit.ru")
      } finally {
        llm.stop()
        hub.stop()
      }
    },
    180_000,
  )
})

// --- AC-135: ключа нет — запрос не отправляется, причина названа ---

/**
 * ОЖИДАЕМО КРАСНЫЕ (BUG-I4-005): при пустом auth-store запрос всё равно уходит в LiteLLM —
 * без заголовка `Authorization`; сообщения о невыполненном входе нет, код выхода `opencode run` — 0.
 * Тесты — минимальное воспроизведение; удалять и ослаблять их нельзя.
 */
describe("корп-модель без ключа (AC-135)", () => {
  test(
    "AC-135: без записи в auth-store к LiteLLM не уходит ни одного запроса, названа причина",
    async () => {
      const llm = startLiteLLM()
      const hub = startHub()
      try {
        const { home, project } = await makeHome()
        const corp = corpConfig(`${llm.url}/v1`)
        const { api } = await serve({
          home,
          project,
          corp,
          hub: hub.url,
          extra: { MAGNIT_COPILOT_KEY: ENV_KEY },
        })

        const answer = await prompt(api)

        expect(llm.hits, "к LiteLLM ушёл запрос без ключа").toHaveLength(0)
        expect(answer.text).toContain(MESSAGES.noKey)
        expect(answer.text).toContain(MESSAGES.noKeyAction)
      } finally {
        llm.stop()
        hub.stop()
      }
    },
    180_000,
  )

  test(
    "AC-135: `opencode run` печатает причину и подсказку, код выхода 1, MAGNIT_COPILOT_KEY не ключ",
    async () => {
      const llm = startLiteLLM()
      const hub = startHub()
      try {
        const { home, project } = await makeHome()
        const corp = corpConfig(`${llm.url}/v1`)
        const result = await run({
          home,
          project,
          corp,
          hub: hub.url,
          extra: { MAGNIT_COPILOT_KEY: ENV_KEY },
          args: ["run", "скажи привет"],
        })

        expect(llm.hits, "к LiteLLM ушёл запрос без ключа").toHaveLength(0)
        expect(llm.hits.map((hit) => hit.authorization)).not.toContain(`Bearer ${ENV_KEY}`)
        expect(result.out).toContain(MESSAGES.noKey)
        expect(result.out).toContain(MESSAGES.noKeyCliHint)
        expect(result.out).not.toContain(ENV_KEY)
        expect(result.code).toBe(1)
      } finally {
        llm.stop()
        hub.stop()
      }
    },
    180_000,
  )
})

// --- AC-136: выключенный провайдер в чате называется по имени ---

/**
 * ОЖИДАЕМО КРАСНЫЙ (BUG-I4-006): при `"disabled_providers": ["magnit_prod"]` обращение к модели
 * даёт upstream-ошибку `ProviderModelNotFoundError` («Unexpected server error»), а не сообщение
 * о выключенном провайдере с путём к файлу.
 */
describe("корп-модель при выключенном провайдере (AC-136)", () => {
  test(
    "AC-136: чат называет выключенный провайдер и файл конфига вместо «модель не найдена»",
    async () => {
      const llm = startLiteLLM()
      const hub = startHub()
      try {
        const { home, project, globalFile } = await makeHome({
          global: { disabled_providers: ["magnit_prod"] },
          key: HUB_KEY,
        })
        const before = await fs.readFile(globalFile, "utf8")
        const corp = corpConfig(`${llm.url}/v1`)
        const { api } = await serve({ home, project, corp, hub: hub.url })

        const answer = await prompt(api)

        expect(llm.hits).toHaveLength(0)
        expect(answer.text).toContain(MESSAGES.providerDisabled)
        expect(answer.text).toContain("disabled_providers")
        expect(answer.text).toContain(globalFile)
        // S-C9/D-22: диагностика не правит чужой конфиг.
        expect(await fs.readFile(globalFile, "utf8")).toBe(before)
      } finally {
        llm.stop()
        hub.stop()
      }
    },
    180_000,
  )
})
