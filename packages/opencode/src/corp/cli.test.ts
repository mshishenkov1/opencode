import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as CatalogCache from "./catalog-cache"

/**
 * Команды `opencode corp login|status` против мока Hub (S-A4, S-A10, S-A11, S-A12, S-Q8;
 * AC-19…AC-23, AC-31…AC-37, AC-120).
 *
 * Внешние системы не задействуются: Hub — `Bun.serve` на 127.0.0.1, браузер подменён пустым
 * `open` в PATH, каталоги XDG — временные.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const ENTRY = path.join(ROOT, "packages/opencode/src/index.ts")

const USER = { user_id: "u1", email: "u@m.ru" }
const KEY = "sk-test-persistent"
const POLL_SECRET = "secret-do-not-leak"

const tmpDirs: string[] = []

async function makeHome() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corp-cli-"))
  tmpDirs.push(dir)
  for (const sub of ["data", "config", "cache", "state"]) await fs.mkdir(path.join(dir, sub), { recursive: true })
  return dir
}

/** Пустая заглушка браузера: пакет `open` ищет команду `open` в PATH (darwin). */
async function browserStub() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "corp-cli-bin-"))
  tmpDirs.push(dir)
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(dir, name)
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n")
    await fs.chmod(file, 0o755)
  }
  return dir
}

const stubPath = await browserStub()

afterAll(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

interface Script {
  /** Ответы на последовательные `GET /cli/poll/:id`. */
  polls: (() => Response)[]
  teams?: { team_id: string; team_alias: string }[]
  start?: () => Response
  health?: boolean
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

const READY = () => json({ status: "ready", key: KEY, key_kind: "persistent", user: USER })
const PENDING = () => json({ status: "pending" })
const BAD_GATEWAY = () => json({ error: "litellm_unavailable" }, 502)

function startHub(script: Script) {
  const pollTimes: number[] = []
  const requests: string[] = []
  let index = 0
  let teamSent: string | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)

      if (url.pathname === "/health")
        return script.health === false ? new Response("", { status: 503 }) : json({ status: "ok" })

      if (url.pathname === "/cli/start" && request.method === "POST") {
        if (script.start) return script.start()
        return json({
          login_id: "login-1",
          poll_secret: POLL_SECRET,
          browser_url: `${url.origin}/ui/login/login-1`,
          user_code: "MGNT-4271",
          expires_in: 120,
        })
      }

      if (/^\/cli\/poll\/[^/]+$/.test(url.pathname)) {
        if (request.headers.get("x-hub-poll-secret") !== POLL_SECRET) return json({ error: "forbidden" }, 403)
        pollTimes.push(Date.now())
        const next = script.polls[Math.min(index, script.polls.length - 1)]!
        index += 1
        return next()
      }

      if (/^\/cli\/poll\/[^/]+\/team$/.test(url.pathname) && request.method === "POST") {
        return request.json().then((body: any) => {
          if (!script.teams?.some((team) => team.team_id === body.team_id)) return json({ error: "invalid_team" }, 400)
          teamSent = body.team_id
          return json({ status: "pending" })
        }) as unknown as Response
      }

      if (!request.headers.get("authorization")?.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401)
      if (url.pathname === "/api/me") return json({ ...USER, key_kind: "persistent" })
      return json({ error: "not_found" }, 404)
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    pollTimes,
    requests,
    team: () => teamSent,
  }
}

async function run(home: string, args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const proc = Bun.spawn({
    cmd: ["bun", "run", "--conditions=browser", ENTRY, ...args],
    cwd: options.cwd ?? ROOT,
    env: {
      ...process.env,
      PATH: `${stubPath}:${process.env["PATH"] ?? ""}`,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_CORP_HUB_URL: "",
      NO_COLOR: "1",
      CI: "1",
      ...options.env,
    },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  return { code, out: stdout + stderr }
}

async function writeKey(home: string) {
  const file = path.join(home, "data", "opencode", "auth.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      magnit_prod: { type: "api", key: KEY, metadata: { hub: "https://hub.test", key_kind: "persistent" } },
    }),
    { mode: 0o600 },
  )
}

async function readAuth(home: string) {
  return JSON.parse(await fs.readFile(path.join(home, "data", "opencode", "auth.json"), "utf8"))
}

/**
 * Построчный контракт вывода `opencode corp status` (S-A11a, ревизия 1.1).
 *
 * Единственный источник ожидаемых подстрок для AC-33, AC-35, AC-122 и дымовой проверки
 * `corp-ci.yml` (AC-120): формулировки строк — часть контракта, расхождение между таблицей S-A11a,
 * тестом и `grep` в CI считается дефектом (BUG-I4-001).
 */
const STATUS_LINES = {
  hub: (url: string) => `Hub: ${url}`,
  hubUp: "Доступность Hub: доступен (ok)",
  hubDown: "Доступность Hub: недоступен",
  keyPresent: "Корпоративный ключ: есть",
  keyMissing: "Корпоративный ключ: нет",
  catalog: "Каталог: ",
  catalogMissing: "Каталог: кэша нет",
  keyHint: "Ключ не найден: выполните opencode corp login",
  // Ревизия 1.5 (S-C4a, S-C9): адрес модели и диагностика конфликтов личного конфига.
  model: (model: string, baseURL: string) => `Модель: ${model} на ${baseURL}`,
  providerDisabled: (file: string) =>
    `Провайдер magnit_prod: выключен в конфиге пользователя (disabled_providers): ${file}`,
  connectorsOverridden: (aliases: string, file: string) =>
    `Коннекторы, переопределённые локально: ${aliases}: ${file}`,
} as const

/** Все строки контракта S-A11a одним списком — для проверки совпадения с `grep` дымовой проверки. */
const CONTRACT = [
  "Hub: ",
  STATUS_LINES.hubUp,
  STATUS_LINES.hubDown,
  STATUS_LINES.keyPresent,
  STATUS_LINES.keyMissing,
  STATUS_LINES.catalog,
  STATUS_LINES.catalogMissing,
  STATUS_LINES.keyHint,
  "Пользователь: ",
  "Тип ключа: ",
  "Модель: ",
  "Провайдер magnit_prod: выключен в конфиге пользователя (disabled_providers): ",
  "Коннекторы, переопределённые локально: ",
]

const hubs: { stop: () => void }[] = []
afterEach(() => {
  while (hubs.length) hubs.pop()!.stop()
})
const hub = (script: Script) => {
  const started = startHub(script)
  hubs.push(started)
  return started
}

describe("opencode corp status (AC-33, AC-34, AC-35, AC-120)", () => {
  test("AC-33: без ключа печатает строки контракта S-A11a и завершается кодом 1", async () => {
    const server = hub({ polls: [PENDING] })
    const home = await makeHome()
    const result = await run(home, ["corp", "status", "--hub", server.url])

    expect(result.out).toContain(STATUS_LINES.hub(server.url))
    expect(result.out).toContain(STATUS_LINES.hubUp)
    expect(result.out).toContain(STATUS_LINES.keyMissing)
    expect(result.out).toContain(STATUS_LINES.catalog)
    expect(result.out).toContain(STATUS_LINES.keyHint)
    expect(result.code).toBe(1)
  })

  test("AC-34: с ключом печатает пользователя, тип ключа и кэш каталога, ключ не печатается", async () => {
    const server = hub({ polls: [PENDING] })
    const home = await makeHome()
    await writeKey(home)
    await CatalogCache.write(
      { hubUrl: server.url, fetchedAt: Date.now(), version: "2026-08-19.1", servers: [] },
      path.join(home, "data", "opencode"),
    )

    const result = await run(home, ["corp", "status", "--hub", server.url])

    expect(result.out.toLowerCase()).toContain("ключ: есть")
    expect(result.out).toContain(USER.email)
    expect(result.out).toContain(USER.user_id)
    expect(result.out).toContain("persistent")
    expect(result.out).toContain("2026-08-19.1")
    expect(result.out).not.toContain(KEY)
    expect(result.code).toBe(0)
  })

  test("AC-34: протухший кэш каталога помечается", async () => {
    const server = hub({ polls: [PENDING] })
    const home = await makeHome()
    await writeKey(home)
    await CatalogCache.write(
      { hubUrl: server.url, fetchedAt: Date.now() - 25 * 60 * 60 * 1000, version: "old.1", servers: [] },
      path.join(home, "data", "opencode"),
    )

    const result = await run(home, ["corp", "status", "--hub", server.url])
    expect(result.out).toContain("протух")
    expect(result.code).toBe(0)
  })

  test("AC-35: ключ есть и Hub недоступен — код выхода 0, доступность Hub на него не влияет", async () => {
    const server = hub({ polls: [PENDING] })
    const url = server.url
    server.stop()
    const home = await makeHome()
    await writeKey(home)

    const result = await run(home, ["corp", "status", "--hub", url])
    expect(result.out).toContain(STATUS_LINES.hubDown)
    expect(result.out).toContain(STATUS_LINES.keyPresent)
    expect(result.out).toContain(STATUS_LINES.catalog)
    expect(result.out).not.toContain(KEY)
    expect(result.code).toBe(0)
  }, 60_000)

  test("AC-122: ключа нет и Hub недоступен — код выхода 1", async () => {
    const server = hub({ polls: [PENDING] })
    const url = server.url
    server.stop()
    const home = await makeHome()

    const result = await run(home, ["corp", "status", "--hub", url])
    expect(result.out).toContain(STATUS_LINES.hubDown)
    expect(result.out).toContain(STATUS_LINES.keyMissing)
    expect(result.out).toContain(STATUS_LINES.keyHint)
    expect(result.code).toBe(1)
  }, 60_000)

  test("AC-120: вывод `corp status` без ключа удовлетворяет дымовой проверке corp-ci", async () => {
    // S-Q8/AC-120: CI грепает вывод команды; строка проверки и строка вывода должны совпадать.
    const workflow = await fs.readFile(path.join(ROOT, ".github/workflows/corp-ci.yml"), "utf8")
    const patterns = [...workflow.matchAll(/grep -q "([^"]+)" status\.txt/g)].map((match) => match[1]!)
    expect(patterns.length).toBeGreaterThan(0)
    // S-A11a: подстрока дымовой проверки берётся из контракта, а не набирается независимо.
    for (const pattern of patterns)
      expect(CONTRACT.some((line) => line.includes(pattern)), `${pattern} нет в контракте S-A11a`).toBe(true)

    const server = hub({ polls: [PENDING] })
    const home = await makeHome()
    const result = await run(home, ["corp", "status", "--hub", server.url])

    expect(result.code).toBe(1)
    for (const pattern of patterns) expect(result.out, pattern).toContain(pattern)
  }, 60_000)

  test("AC-37: без адреса Hub команда сообщает о ненастроенном режиме и завершается с кодом 1", async () => {
    const home = await makeHome()
    const result = await run(home, ["corp", "status"])
    expect(result.out).toContain("Корпоративный режим не настроен")
    expect(result.code).toBe(1)
  })
})

describe("opencode corp login (AC-19…AC-23, AC-31, AC-32, AC-37)", () => {
  test("AC-31: полный успешный флоу печатает адрес, код и email, сохраняет ключ, код выхода 0", async () => {
    const server = hub({ polls: [PENDING, READY] })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])

    expect(result.out).toContain(server.url)
    expect(result.out).toContain("MGNT-4271")
    expect(result.out).toContain(USER.email)
    expect(result.out).toContain("persistent")
    expect(result.code).toBe(0)

    const auth = await readAuth(home)
    expect(auth["magnit_prod"]).toMatchObject({ type: "api", key: KEY })
    expect(auth["magnit_prod"].metadata).toMatchObject({
      hub: server.url,
      key_kind: "persistent",
      user_id: USER.user_id,
    })
  }, 60_000)

  test("AC-115: ни ключ, ни poll_secret не попадают в вывод", async () => {
    const server = hub({ polls: [READY] })
    const home = await makeHome()
    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.out).not.toContain(KEY)
    expect(result.out).not.toContain(POLL_SECRET)
    expect(result.code).toBe(0)
  }, 60_000)

  test("AC-31: выбор команды по --team отправляется в Hub и завершается успехом", async () => {
    const teams = [
      { team_id: "t1", team_alias: "A" },
      { team_id: "t2", team_alias: "B" },
    ]
    const server = hub({
      polls: [() => json({ status: "team_selection_required", teams }), READY],
      teams,
    })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url, "--team", "t2"])
    expect(server.team()).toBe("t2")
    expect(result.out).toContain(USER.email)
    expect(result.code).toBe(0)
    expect(server.requests).toContain("POST /cli/poll/login-1/team")
  }, 60_000)

  test("AC-29: повторный вход перезаписывает запись magnit_prod в auth-store", async () => {
    const server = hub({ polls: [READY] })
    const home = await makeHome()
    await writeKey(home)
    const before = await readAuth(home)
    expect(before["magnit_prod"].metadata.hub).toBe("https://hub.test")

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.code).toBe(0)

    const after = await readAuth(home)
    expect(after["magnit_prod"].type).toBe("api")
    expect(after["magnit_prod"].metadata.hub).toBe(server.url)
    expect(after["magnit_prod"].metadata.user_id).toBe(USER.user_id)
  }, 60_000)

  test("AC-32: две команды и неинтерактивный ввод — подсказка про --team и код выхода 1", async () => {
    const teams = [
      { team_id: "t1", team_alias: "A" },
      { team_id: "t2", team_alias: "B" },
    ]
    const server = hub({ polls: [() => json({ status: "team_selection_required", teams })], teams })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.out).toContain("--team")
    expect(result.out).toContain("t1")
    expect(result.code).toBe(1)
  }, 60_000)

  test("AC-26: неизвестная команда в --team не завершает вход", async () => {
    const teams = [{ team_id: "t1", team_alias: "A" }]
    const server = hub({ polls: [() => json({ status: "team_selection_required", teams })], teams })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url, "--team", "t9"])
    expect(result.out).toContain("t9")
    expect(result.code).toBe(1)
    await expect(readAuth(home)).rejects.toThrow()
  }, 60_000)

  test("AC-19: четыре 502 подряд не прекращают опрос, интервал между запросами ≥ 2 с", async () => {
    const server = hub({ polls: [BAD_GATEWAY, BAD_GATEWAY, BAD_GATEWAY, BAD_GATEWAY, READY] })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.code).toBe(0)
    expect(result.out).toContain(USER.email)
    expect(server.pollTimes.length).toBeGreaterThanOrEqual(5)

    const gaps = server.pollTimes.slice(1).map((at, index) => at - server.pollTimes[index]!)
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1900)
  }, 120_000)

  test("AC-20: пять 502 подряд прекращают опрос с ошибкой «Hub недоступен»", async () => {
    const server = hub({ polls: [BAD_GATEWAY] })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.code).toBe(1)
    expect(result.out).toContain("Hub недоступен")
    expect(server.pollTimes).toHaveLength(5)
  }, 120_000)

  test("AC-21: 404 login_expired прекращает опрос немедленно с русским сообщением", async () => {
    const server = hub({ polls: [() => json({ error: "login_expired" }, 404)] })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.code).toBe(1)
    expect(result.out).toContain("Сессия входа истекла")
    expect(server.pollTimes).toHaveLength(1)
  }, 60_000)

  test("AC-23: 502 litellm_invalid_response отдаёт свой русский текст", async () => {
    const server = hub({ polls: [() => json({ error: "litellm_invalid_response" }, 502)] })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.code).toBe(1)
    expect(result.out).toContain("Сервис ключей вернул неожиданный ответ")
    expect(server.pollTimes).toHaveLength(1)
  }, 60_000)

  test("AC-22: 429 на /cli/start — русский текст ограничения, тело Hub не пересылается", async () => {
    const server = hub({
      polls: [PENDING],
      start: () => json({ error: "rate_limited", message: "внутренняя деталь sk-leak" }, 429, { "retry-after": "30" }),
    })
    const home = await makeHome()

    const result = await run(home, ["corp", "login", "--hub", server.url])
    expect(result.code).toBe(1)
    expect(result.out).toContain("Слишком много попыток")
    expect(result.out).not.toContain("sk-leak")
  }, 60_000)

  test("AC-37: без адреса Hub вход не запускается", async () => {
    const home = await makeHome()
    const result = await run(home, ["corp", "login"])
    expect(result.out).toContain("Корпоративный режим не настроен")
    expect(result.code).toBe(1)
  })
})

describe("группа команд (AC-36)", () => {
  test("AC-36: `opencode corp` без подкоманды печатает справку с login и status", async () => {
    const home = await makeHome()
    const result = await run(home, ["corp"])
    expect(result.out).toContain("login")
    expect(result.out).toContain("status")
    expect(result.code).not.toBe(0)
  })
})

// --- Диагностика конфликтов личного конфига (S-C9, S-A11a; AC-136, AC-137) ---

const MODEL_BASE_URL = "https://llm.test/v1"
const MODEL_REF = "magnit_prod/MagnitCopilot"

/** Корп-слой того же вида, что `corp/config/opencode.corp.json` (S-C4). */
const CORP_CONFIG = JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  autoupdate: false,
  share: "disabled",
  enabled_providers: ["magnit_prod"],
  model: MODEL_REF,
  provider: {
    magnit_prod: {
      npm: "@ai-sdk/openai-compatible",
      name: "Magnit Copilot",
      options: { baseURL: MODEL_BASE_URL },
      models: {
        MagnitCopilot: { name: "Magnit Copilot", tool_call: true, limit: { context: 200000, output: 32000 } },
      },
    },
  },
})

/** Пустой каталог проекта: `corp status` не должен зависеть от конфига репозитория. */
async function makeProject(home: string) {
  const directory = path.join(home, "project")
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, "README.md"), "проект для теста")
  return directory
}

/** Глобальный конфиг пользователя; возвращает путь — он входит в строки контракта S-A11a. */
async function writeGlobalConfig(home: string, config: object) {
  const file = path.join(home, "config", "opencode", "opencode.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify({ $schema: "https://opencode.ai/config.json", ...config }, null, 2))
  return file
}

/**
 * ОЖИДАЕМО КРАСНЫЕ (BUG-I4-004, BUG-I4-006): `corp status` не печатает ни строки «Модель: …»,
 * ни диагностики конфликтов личного конфига и завершается кодом 0 там, где S-C9 требует 1.
 * Тесты — минимальное воспроизведение; удалять и ослаблять их нельзя.
 */
describe("opencode corp status — адрес модели и конфликты личного конфига (AC-136, AC-137)", () => {
  test(
    "S-A11a: строка «Модель: <model> на <baseURL>» печатается всегда (AC-132)",
    async () => {
      const server = hub({ polls: [PENDING] })
      const home = await makeHome()
      const directory = await makeProject(home)
      await writeKey(home)

      const result = await run(home, ["corp", "status", "--hub", server.url], {
        cwd: directory,
        env: { OPENCODE_CORP_CONFIG: CORP_CONFIG },
      })

      expect(result.out).toContain(STATUS_LINES.model(MODEL_REF, MODEL_BASE_URL))
    },
    60_000,
  )

  test(
    "AC-136: выключенный в конфиге пользователя провайдер назван в выводе, код выхода 1",
    async () => {
      const server = hub({ polls: [PENDING] })
      const home = await makeHome()
      const directory = await makeProject(home)
      await writeKey(home)
      const file = await writeGlobalConfig(home, { disabled_providers: ["magnit_prod"] })
      const before = await fs.readFile(file, "utf8")

      const result = await run(home, ["corp", "status", "--hub", server.url], {
        cwd: directory,
        env: { OPENCODE_CORP_CONFIG: CORP_CONFIG },
      })

      expect(result.out).toContain(STATUS_LINES.providerDisabled(file))
      expect(result.code).toBe(1)
      // S-C9/D-22: диагностика не правит чужой конфиг.
      expect(await fs.readFile(file, "utf8")).toBe(before)
    },
    60_000,
  )

  test(
    "AC-137: локально переопределённый alias назван в выводе с путём к файлу, код выхода 1",
    async () => {
      const server = hub({ polls: [PENDING] })
      const home = await makeHome()
      const directory = await makeProject(home)
      await writeKey(home)
      // Каталог Hub знает alias tag как удалённый коннектор Hub…
      await CatalogCache.write(
        {
          hubUrl: server.url,
          fetchedAt: Date.now(),
          version: "2026-08-21.1",
          servers: [
            { alias: "tag", title: "Tag", status: "ga", mode: "facade", mcp_url: `${server.url}/mcp/tag` },
          ],
        },
        path.join(home, "data", "opencode"),
      )
      // …а личный конфиг задаёт свой mcp.tag: слияние идёт по полям (F38), коннектор Hub ломается.
      const file = await writeGlobalConfig(home, {
        mcp: { tag: { type: "local", command: ["echo", "hi"], enabled: true } },
      })
      const before = await fs.readFile(file, "utf8")

      const result = await run(home, ["corp", "status", "--hub", server.url], {
        cwd: directory,
        env: { OPENCODE_CORP_CONFIG: CORP_CONFIG },
      })

      expect(result.out).toContain(STATUS_LINES.connectorsOverridden("tag", file))
      expect(result.code).toBe(1)
      expect(await fs.readFile(file, "utf8")).toBe(before)
    },
    60_000,
  )
})
