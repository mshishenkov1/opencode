import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import * as CorpUpgrade from "./upgrade"

/**
 * Явный апгрейд CLI в корпоративной сборке (S-B14, S-Q11; AC-193…AC-196, AC-199).
 *
 * Наружу команда не ходит ни при каком исходе. Проверяется наблюдаемое поведение процесса
 * `opencode upgrade`: какие запросы ушли (журнал перехватчика `test/fixture/corp-upgrade-interceptor.ts`
 * подключается через `bun --preload`), какие менеджеры пакетов запустились (заглушки в `PATH`
 * пишут своё имя в файл), что напечатано и какой код выхода.
 *
 * Список запрещённых хостов задан здесь явно и проверяется по **всем** перехваченным запросам.
 *
 * Запуск: `bun --cwd packages/opencode test src/corp/upgrade.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "../../../..")
const ENTRY = path.join(ROOT, "packages/opencode/src/index.ts")
const INTERCEPTOR = path.join(ROOT, "packages/opencode/test/fixture/corp-upgrade-interceptor.ts")

/**
 * Хосты, к которым корпоративный апгрейд не обращается ни на одном шаге (S-B14, AC-193).
 * Перечень задан в тесте явно и сверяется с перечнем модуля: расхождение — дефект.
 */
const FORBIDDEN_HOSTS = [
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "formulae.brew.sh",
  "community.chocolatey.org",
  "objects.githubusercontent.com",
  "opencode.ai",
] as const

/** Менеджеры пакетов, запуск любого из которых корпоративный апгрейд не выполняет (AC-193). */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "brew", "choco", "scoop", "curl"] as const

const tmpDirs: string[] = []

async function tmp(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterAll(async () => {
  while (tmpDirs.length) await fs.rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

/** Заглушки менеджеров пакетов в `PATH`: каждый запуск дописывает своё имя в журнал. */
async function packageManagerStubs(logFile: string) {
  const dir = await tmp("corp-upgrade-bin-")
  for (const name of PACKAGE_MANAGERS) {
    const file = path.join(dir, name)
    await fs.writeFile(file, `#!/bin/sh\necho "${name} $@" >> ${logFile}\nexit 0\n`)
    await fs.chmod(file, 0o755)
  }
  return dir
}

interface RunResult {
  code: number | null
  out: string
  /** Все перехваченные исходящие запросы: `fetch <url>`. */
  requests: string[]
  /** Все запуски менеджеров пакетов. */
  managers: string[]
}

async function runUpgrade(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const home = await tmp("corp-upgrade-home-")
  const netLog = path.join(home, "net.log")
  const pmLog = path.join(home, "pm.log")
  await fs.writeFile(netLog, "")
  await fs.writeFile(pmLog, "")
  const stubs = await packageManagerStubs(pmLog)

  const proc = Bun.spawn({
    cmd: ["bun", "--conditions=browser", "--preload", INTERCEPTOR, ENTRY, "upgrade", ...args],
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${stubs}${path.delimiter}${process.env["PATH"] ?? ""}`,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      CORP_NET_LOG: netLog,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      NO_COLOR: "1",
      CI: "1",
      ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  const lines = (file: string) =>
    fs
      .readFile(file, "utf8")
      .then((text) => text.split("\n").filter(Boolean))
      .catch(() => [])
  return { code, out: stdout + stderr, requests: await lines(netLog), managers: await lines(pmLog) }
}

/** Ни один перехваченный запрос не ушёл на запрещённый хост — проверяется весь журнал. */
function expectNoForbiddenHosts(requests: string[]) {
  for (const request of requests)
    for (const host of FORBIDDEN_HOSTS) expect(request, `запрос на запрещённый хост: ${request}`).not.toContain(host)
}

/** Мок внутреннего источника обновлений на 127.0.0.1: наружу запросов нет. */
function startSource(script: { latest?: () => Response; artifact?: () => Response }) {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push(`${request.method} ${url.pathname}`)
      if (url.pathname === "/opencode/latest")
        return script.latest?.() ?? new Response("{}", { status: 404 })
      if (url.pathname.startsWith("/opencode/")) return script.artifact?.() ?? new Response("", { status: 404 })
      return new Response("", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/opencode`, requests, stop: () => server.stop(true) }
}

const sources: { stop: () => void }[] = []
afterEach(() => {
  while (sources.length) sources.pop()!.stop()
})
const source = (script: Parameters<typeof startSource>[0]) => {
  const started = startSource(script)
  sources.push(started)
  return started
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

// --- Чистые функции плана (S-B14) ---

describe("corp/upgrade — план команды по сборке (AC-193, AC-194, AC-196)", () => {
  test("AC-196: без корп-функций план — upstream", () => {
    expect(CorpUpgrade.plan({ enabled: false })).toEqual({ mode: "upstream" })
    expect(CorpUpgrade.plan({ enabled: false, url: "https://dist.test/opencode" })).toEqual({ mode: "upstream" })
  })

  test("AC-193: корп-функции включены, адрес не задан — апгрейд выключен", () => {
    expect(CorpUpgrade.plan({ enabled: true, url: undefined as unknown as string })).toEqual({ mode: "disabled" })
    expect(CorpUpgrade.plan({ enabled: true, url: "" })).toEqual({ mode: "disabled" })
  })

  test("AC-194: адрес задан — источник только внутренний, хвостовые слэши отброшены", () => {
    expect(CorpUpgrade.plan({ enabled: true, url: "https://dist.test/opencode//" })).toEqual({
      mode: "internal",
      url: "https://dist.test/opencode",
    })
    expect(CorpUpgrade.latestUrl("https://dist.test/opencode")).toBe("https://dist.test/opencode/latest")
    expect(CorpUpgrade.artifactUrl("https://dist.test/opencode", "1.17.9-magnit.2", "darwin", "arm64")).toBe(
      "https://dist.test/opencode/1.17.9-magnit.2/opencode-darwin-arm64.zip",
    )
  })

  test("AC-199: перечень запрещённых хостов объявлен модулем и совпадает с перечнем теста", () => {
    // Перечень модуля — кортеж литералов; сравниваем его как обычный список строк, чтобы
    // отсутствующий хост давал падение теста с именем хоста, а не ошибку типов.
    const declared: string[] = [...CorpUpgrade.FORBIDDEN_HOSTS]
    for (const host of [
      "api.github.com",
      "registry.npmjs.org",
      "formulae.brew.sh",
      "community.chocolatey.org",
      "raw.githubusercontent.com",
    ])
      expect(declared, host).toContain(host)
  })
})

// --- Определение версии и скачивание артефакта (S-B14) ---

describe("corp/upgrade — версия и артефакт берутся только с внутреннего адреса (AC-194, AC-195)", () => {
  test("AC-194: единственный запрос определения версии — GET <адрес>/latest", async () => {
    const requested: string[] = []
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requested.push(url)
      return json({ version: "1.17.9-magnit.2" })
    }) as unknown as typeof fetch

    const result = await CorpUpgrade.latest("https://dist.test/opencode", { fetch: stub })
    expect(result).toEqual({ ok: true, data: "1.17.9-magnit.2" })
    expect(requested).toEqual(["https://dist.test/opencode/latest"])
    expectNoForbiddenHosts(requested)
  })

  test("AC-195: ответ не по схеме даёт понятную ошибку источника, а не падение и не запасной источник", async () => {
    const requested: string[] = []
    const respond = (body: string) =>
      (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        requested.push(url)
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } })
      }) as unknown as typeof fetch

    for (const body of ["не json", "[]", "{}", JSON.stringify({ version: 17 }), JSON.stringify({ version: "" })]) {
      const result = await CorpUpgrade.latest("https://dist.test/opencode", { fetch: respond(body) })
      expect(result.ok, body).toBe(false)
      if (result.ok) throw new Error("ожидалась ошибка источника")
      expect(result.error, body).toBe("invalid_response")
      expect(CorpUpgrade.sourceErrorMessage("https://dist.test/opencode", result.error)).toContain(
        "https://dist.test/opencode/latest",
      )
    }
    // Запасного публичного источника нет ни в одном случае.
    expectNoForbiddenHosts(requested)
  })

  test("AC-182, AC-195: недоступный источник отличим от неразобранного ответа", async () => {
    const failing = (async () => {
      throw new Error("fetch failed")
    }) as unknown as typeof fetch
    expect(await CorpUpgrade.latest("https://dist.test/opencode", { fetch: failing })).toEqual({
      ok: false,
      error: "unreachable",
    })
    expect(CorpUpgrade.sourceErrorMessage("https://dist.test/opencode", "unreachable")).toContain("недоступен")
  })

  test("AC-194: артефакт скачивается с того же хоста и заменяет бинарник", async () => {
    const dir = await tmp("corp-upgrade-bin-target-")
    const binary = path.join(dir, "opencode")
    await fs.writeFile(binary, "старый бинарник")

    const requested: string[] = []
    const stub = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      requested.push(url)
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as unknown as typeof fetch

    const result = await CorpUpgrade.install("http://dist.test/opencode", "1.17.9-magnit.2", {
      fetch: stub,
      binary,
      platform: "darwin",
      arch: "arm64",
      // Распаковщик подменён: настоящий запускает unzip/tar, а нам важен адрес и замена файла.
      extract: async (_archive, into) => {
        await fs.mkdir(path.join(into, "bin"), { recursive: true })
        await fs.writeFile(path.join(into, "bin", "opencode"), "новый бинарник")
      },
    })

    expect(result).toEqual({ ok: true, data: "1.17.9-magnit.2" })
    expect(requested).toEqual(["http://dist.test/opencode/1.17.9-magnit.2/opencode-darwin-arm64.zip"])
    expectNoForbiddenHosts(requested)
    expect(await fs.readFile(binary, "utf8")).toBe("новый бинарник")
  })
})

// --- Команда целиком (S-Q11) ---

describe("opencode upgrade — корп-сборка без адреса источника (AC-193)", () => {
  test("AC-193: ни одного сетевого запроса, ни одного менеджера пакетов, сообщение и код выхода 1", async () => {
    const result = await runUpgrade([], { OPENCODE_CORP_HUB_URL: "https://hub.magnit.test" })

    expect(result.requests).toEqual([])
    expect(result.managers).toEqual([])
    expectNoForbiddenHosts(result.requests)
    expect(result.out).toContain("Обновление корпоративной сборки выполняется централизованно")
    expect(result.code).toBe(1)
  })

  test("AC-193: молчаливого «уже последняя версия» не бывает — команда прямо говорит о причине", async () => {
    const result = await runUpgrade([], { OPENCODE_CORP_HUB_URL: "https://hub.magnit.test" })
    expect(result.out).not.toContain("already installed")
    expect(result.out).toContain(CorpUpgrade.DISABLED_MESSAGE)
  })
})

describe("opencode upgrade — корп-сборка с внутренним адресом (AC-194, AC-195)", () => {
  test("AC-194: версия берётся с <адрес>/latest; совпадение с текущей пропускает апгрейд без установки", async () => {
    // Целевая версия равна текущей: сетевой установки не происходит, артефакт не запрашивается.
    const current = "local"
    const feed = source({ latest: () => json({ version: current }) })

    const result = await runUpgrade([], {
      OPENCODE_CORP_HUB_URL: "https://hub.magnit.test",
      OPENCODE_CORP_CLI_UPDATE_URL: feed.url,
    })

    expect(feed.requests).toEqual(["GET /opencode/latest"])
    expect(result.requests).toEqual([`fetch ${feed.url}/latest`])
    expectNoForbiddenHosts(result.requests)
    expect(result.managers).toEqual([])
    expect(result.out).toContain(`${current} is already installed`)
    expect(result.code).toBe(0)
  })

  test("AC-195: ответ источника не по схеме — понятная ошибка, код 1, запасного источника нет", async () => {
    const feed = source({ latest: () => json({ latest_version: "1.17.9-magnit.2" }) })

    const result = await runUpgrade([], {
      OPENCODE_CORP_HUB_URL: "https://hub.magnit.test",
      OPENCODE_CORP_CLI_UPDATE_URL: feed.url,
    })

    expect(result.out).toContain("Источник обновлений")
    expect(result.out).toContain(`${feed.url}/latest`)
    expect(result.code).toBe(1)
    // Бинарник не заменён: артефакт не запрашивался ни у источника, ни где-либо ещё.
    expect(feed.requests).toEqual(["GET /opencode/latest"])
    expect(result.requests).toEqual([`fetch ${feed.url}/latest`])
    expectNoForbiddenHosts(result.requests)
    expect(result.managers).toEqual([])
  })

  test("AC-195: недоступный источник тоже даёт код 1 и не идёт на api.github.com", async () => {
    const feed = source({ latest: () => new Response("", { status: 503 }) })

    const result = await runUpgrade([], {
      OPENCODE_CORP_HUB_URL: "https://hub.magnit.test",
      OPENCODE_CORP_CLI_UPDATE_URL: feed.url,
    })

    expect(result.code).toBe(1)
    expect(result.out).toContain("Источник обновлений")
    expectNoForbiddenHosts(result.requests)
    expect(result.managers).toEqual([])
  })
})

describe("opencode upgrade — ванильная сборка (AC-196)", () => {
  test("AC-196: без корп-функций версия определяется прежним путём, корп-сообщение не печатается", async () => {
    const result = await runUpgrade(["--method", "curl"], {
      OPENCODE_CORP_HUB_URL: "",
      // Перехватчик отвечает вместо api.github.com: ванильный путь доходит до конца, наружу не выходя.
      CORP_STUB_GITHUB: JSON.stringify({ tag_name: "vlocal" }),
    })

    expect(result.requests.some((request) => request.includes("api.github.com/repos/anomalyco/opencode"))).toBe(true)
    expect(result.out).not.toContain(CorpUpgrade.DISABLED_MESSAGE)
    expect(result.out).not.toContain("Источник обновлений")
    // Прежний код выхода: цель совпала с установленной версией, апгрейд пропущен.
    expect(result.out).toContain("already installed")
    expect(result.code).toBe(0)
  })
})
