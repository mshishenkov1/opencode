import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

/**
 * Скрипт сборки корпоративных артефактов (S-B1…S-B4; AC-100, AC-102, AC-103, AC-104).
 *
 * Реальная сборка не запускается: проверяется разбор версии, целей и ветвлений скрипта с `--skip-cli`.
 *
 * Запуск: `bun --cwd packages/opencode test ../../corp/build.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const SCRIPT = path.join(ROOT, "corp/build.ts")

async function build(args: string[], env: Record<string, string | undefined> = {}) {
  const childEnv: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1", CI: "1" }
  delete childEnv["CORP_HUB_URL"]
  delete childEnv["CORP_BUILD"]
  delete childEnv["OPENCODE_CHANNEL"]
  delete childEnv["CORP_DESKTOP_UPDATE_URL"]
  delete childEnv["CORP_CLI_UPDATE_URL"]
  delete childEnv["CORP_ARTIFACTS_ENDPOINT"]
  delete childEnv["CORP_ARTIFACTS_TOKEN"]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  const proc = Bun.spawn({
    // Сам скрипт всегда запускается настоящим bun: PATH в тестах соответствия каналов подменён.
    cmd: [process.execPath, "run", SCRIPT, ...args],
    cwd: ROOT,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: stdout + stderr }
}

const upstreamVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/opencode/package.json"), "utf8"))
  .version as string

describe("corp/build.ts — версия (AC-100)", () => {
  test("AC-100: CORP_BUILD задаёт номер корп-сборки", async () => {
    const result = await build(["--skip-cli"], { CORP_BUILD: "2" })
    expect(result.out).toContain(`версия сборки: ${upstreamVersion}-magnit.2`)
    expect(result.code).toBe(0)
  }, 60_000)

  test("AC-100: без CORP_BUILD номер берётся из corp/version", async () => {
    const fromFile = fs.readFileSync(path.join(ROOT, "corp/version"), "utf8").trim()
    const result = await build(["--skip-cli"])
    expect(result.out).toContain(`версия сборки: ${upstreamVersion}-magnit.${fromFile}`)
    expect(result.code).toBe(0)
  }, 60_000)
})

/**
 * Автотег после мержа upstream (S-B16).
 *
 * `--print-version` — единственный источник имени тега для `corp-release.yml`: версию тега печатает
 * тот же код, который проставит её артефактам, поэтому разойтись они не могут. Здесь проверяется
 * контракт вывода (ровно одна строка, ничего не собирается) и стык двух workflow: сообщение,
 * которым `upstream-sync.yml` коммитит мерж, обязано попадать под условие запуска `corp-release.yml`.
 */
describe("corp/build.ts — --print-version и автотег (S-B16)", () => {
  test("--print-version печатает ровно версию сборки и выходит с кодом 0", async () => {
    const result = await build(["--print-version"], { CORP_BUILD: "7" })
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe(`${upstreamVersion}-magnit.7`)
  }, 60_000)

  test("--print-version ничего не собирает и не требует переменных окружения", async () => {
    const result = await build(["--print-version"])
    expect(result.code).toBe(0)
    // Ни предупреждения о ванильной сборке, ни шагов сборки: печать идёт до разбора настроек.
    expect(result.out).not.toContain("ванильная сборка")
    expect(result.out).not.toContain("сборка CLI")
    expect(result.out).not.toContain("канал сборки")
  }, 60_000)

  test("--print-version не отвергается вместе с неизвестным каналом: тег считается без настроек", async () => {
    const result = await build(["--print-version", "--channel", "stable"])
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe(
      `${upstreamVersion}-magnit.${fs.readFileSync(path.join(ROOT, "corp/version"), "utf8").trim()}`,
    )
  }, 60_000)

  test("S-B16: corp-release.yml берёт версию тега из --print-version, а не набирает её сам", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github/workflows/corp-release.yml"), "utf8")
    expect(workflow).toContain("corp/build.ts --print-version")
    // Номер сборки пишется в corp/version — единственный источник N для corpVersion().
    expect(workflow).toContain("corp/version")
    // Идемпотентность: уже помеченный коммит завершает задание успехом.
    expect(workflow).toContain("--points-at HEAD")
  })

  test("S-B16: условие автотега совпадает с сообщением мержа, которым коммитит upstream-sync.yml", () => {
    const release = fs.readFileSync(path.join(ROOT, ".github/workflows/corp-release.yml"), "utf8")
    const sync = fs.readFileSync(path.join(ROOT, ".github/workflows/upstream-sync.yml"), "utf8")
    // Сообщение мержа задаётся в upstream-sync.yml: git merge --no-ff "$TAG" -m "corp: слить upstream $TAG"
    const message = /-m "([^"$]+)\$TAG"/.exec(sync)?.[1]
    expect(message).toBe("corp: слить upstream ")
    expect(release).toContain(`startsWith(github.event.head_commit.message, '${message}')`)
    // Коммит самого автотега под это условие не подходит — цикла запусков нет.
    expect(release).toContain('git commit -m "corp: версия сборки')
    expect("corp: версия сборки 2".startsWith(message!)).toBe(false)
  })
})

describe("corp/build.ts — адрес Hub (AC-101, AC-102)", () => {
  test("AC-102: без CORP_HUB_URL печатается предупреждение о ванильной сборке, код выхода 0", async () => {
    const result = await build(["--skip-cli"])
    expect(result.out).toContain("ванильная сборка")
    expect(result.code).toBe(0)
  }, 60_000)

  test("AC-101: с CORP_HUB_URL печатается адрес Hub и предупреждения нет", async () => {
    const result = await build(["--skip-cli"], { CORP_HUB_URL: "https://hub.test" })
    expect(result.out).toContain("адрес Hub: https://hub.test")
    expect(result.out).not.toContain("ванильная сборка")
    expect(result.code).toBe(0)
  }, 60_000)
})

describe("corp/build.ts — цели сборки (AC-101)", () => {
  test("AC-101: неизвестная цель отвергается с перечислением доступных", async () => {
    const result = await build(["--targets", "solaris-sparc"])
    expect(result.code).not.toBe(0)
    expect(result.out).toContain("неизвестные цели: solaris-sparc")
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) {
      expect(result.out).toContain(target)
    }
  }, 60_000)

  test("AC-101: перечень целей по умолчанию — четыре платформы", async () => {
    const source = fs.readFileSync(SCRIPT, "utf8")
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) {
      expect(source).toContain(target)
    }
  })
})

describe("corp/build.ts — Desktop и публикация (AC-103, AC-104)", () => {
  test.skipIf(process.platform === "win32")(
    "AC-103: сборка Desktop win-x64 вне Windows завершается понятной ошибкой, а не пропуском",
    async () => {
      const result = await build(["--skip-cli", "--desktop", "--win"])
      expect(result.code).toBe(1)
      expect(result.out).toContain("требует Windows")
    },
    60_000,
  )

  test("AC-104: без --publish публикация не выполняется", async () => {
    const result = await build(["--skip-cli"], { CORP_HUB_URL: "https://hub.test" })
    expect(result.out).not.toContain("публикация релиза")
    expect(result.out).toContain("артефактов нет")
    expect(result.code).toBe(0)
  }, 60_000)
})

/**
 * Соответствие каналов сборки (S-B3, S-B10; AC-143, AC-144).
 *
 * Настоящая сборка Desktop не запускается: в PATH подставляется `bun`-заглушка, которая вместо
 * `prebuild`/`build`/`package:*` записывает свои аргументы, рабочий каталог и значение
 * `OPENCODE_CHANNEL`. Так виден именно тот канал, который скрипт передаёт сборке Desktop.
 */
async function buildWithFakeBun(args: string[], env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corp-build-channel-"))
  const log = path.join(dir, "calls.log")
  const shim = path.join(dir, "bun")
  fs.writeFileSync(shim, `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$OPENCODE_CHANNEL" "$PWD" >> ${log}\nexit 0\n`)
  fs.chmodSync(shim, 0o755)
  try {
    const result = await build(args, { ...env, PATH: `${dir}${path.delimiter}${process.env["PATH"]}` })
    const calls = fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [args = "", channel = "", cwd = ""] = line.split("|")
            return { args, channel, cwd }
          })
      : []
    return { ...result, calls }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("corp/build.ts — соответствие каналов (AC-143, AC-144)", () => {
  test("AC-143: канал latest печатается как «latest (Desktop: magnit)» и уходит в Desktop как magnit", async () => {
    const result = await buildWithFakeBun(["--skip-cli", "--desktop"], { CORP_HUB_URL: "https://hub.test" })
    expect(result.out).toContain("канал сборки: latest (Desktop: magnit)")

    const desktop = result.calls.filter((call) => call.cwd.endsWith("packages/desktop"))
    expect(desktop.length).toBeGreaterThan(0)
    expect(desktop.map((call) => call.channel)).toEqual(desktop.map(() => "magnit"))
    expect(desktop.some((call) => call.args.includes("prebuild"))).toBe(true)
    for (const call of result.calls) expect(call.channel, call.args).not.toBe("prod")
  }, 120_000)

  test("AC-143: явный канал magnit печатается без пометки и уходит в Desktop как magnit", async () => {
    const result = await buildWithFakeBun(["--skip-cli", "--desktop", "--channel", "magnit"], {
      CORP_HUB_URL: "https://hub.test",
    })
    expect(result.out).toContain("канал сборки: magnit")
    expect(result.out).not.toContain("(Desktop:")

    const desktop = result.calls.filter((call) => call.cwd.endsWith("packages/desktop"))
    expect(desktop.length).toBeGreaterThan(0)
    expect(desktop.map((call) => call.channel)).toEqual(desktop.map(() => "magnit"))
    for (const call of result.calls) expect(call.channel, call.args).not.toBe("prod")
  }, 120_000)

  test("AC-143: канал CLI остаётся latest — в Desktop переводится только он", async () => {
    const result = await buildWithFakeBun(["--desktop", "--skip-embed-web-ui"], { CORP_HUB_URL: "https://hub.test" })
    const cli = result.calls.filter((call) => call.cwd.endsWith("packages/opencode"))
    expect(cli.length).toBeGreaterThan(0)
    for (const call of cli) expect(call.channel, call.args).toBe("latest")
  }, 120_000)

  test("AC-144: неизвестный канал завершает скрипт кодом 1, ничего не собирая", async () => {
    const result = await buildWithFakeBun(["--channel", "stable", "--desktop"], { CORP_HUB_URL: "https://hub.test" })
    expect(result.code).toBe(1)
    expect(result.out).toContain("неизвестный канал сборки: stable; допустимые: latest, magnit, dev, beta, prod")
    expect(result.calls).toEqual([])
    expect(result.out).not.toContain("сборка CLI")
    expect(result.out).not.toContain("Desktop: prebuild")
  }, 120_000)

  test("AC-144: канал из окружения проверяется так же, как аргумент", async () => {
    const result = await buildWithFakeBun(["--skip-cli"], { OPENCODE_CHANNEL: "stable" })
    expect(result.code).toBe(1)
    expect(result.out).toContain("неизвестный канал сборки: stable")
    expect(result.calls).toEqual([])
  }, 120_000)
})

/**
 * Публикация на внутренний сервер (S-B16).
 *
 * Настоящая сборка не запускается: артефакты подкладываются в каталоги сборки, а скрипт вызывается
 * с `--from-dist`. Приёмник — локальный сервер, который записывает порядок, пути, заголовки и тела
 * запросов: проверяется именно то, что видит клиент раздачи.
 */
describe("corp/build.ts — публикация internal (S-B16)", () => {
  const PUBLISH_BUILD = "999"
  const publishVersion = `${upstreamVersion}-magnit.${PUBLISH_BUILD}`
  const dirs: string[] = []

  function put(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  /**
   * Каталог скачанных артефактов в том виде, в каком его оставляет `actions/download-artifact`:
   * по подкаталогу на задание сборки. Настоящие каталоги сборки репозитория не трогаются — иначе
   * прогон зависел бы от того, лежит ли рядом чья-то локальная сборка Desktop.
   */
  function fixtures() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "corp-publish-"))
    dirs.push(root)
    const cli = path.join(root, "opencode-cli-linux-x64")
    const desktop = path.join(root, "opencode-desktop-mac")
    put(path.join(cli, `opencode-linux-x64-${publishVersion}.zip`), "CLI linux-x64")
    put(path.join(root, "opencode-cli-darwin-arm64", `opencode-darwin-arm64-${publishVersion}.zip`), "CLI darwin-arm64")
    put(path.join(desktop, "opencode-magnit-desktop-mac-arm64.dmg"), "DMG arm64")
    put(path.join(desktop, "opencode-magnit-desktop-mac-arm64.zip"), "ZIP arm64")
    put(path.join(desktop, "opencode-magnit-desktop-mac-arm64.zip.blockmap"), "BLOCKMAP arm64")
    put(path.join(desktop, "opencode-magnit-desktop-mac-x64.zip"), "ZIP x64")
    put(path.join(desktop, "builder-debug.yml"), "конфигурация electron-builder — не фид")
    put(path.join(desktop, "magnit-mac.yml"), "version: x\nfiles:\n  - url: opencode-magnit-desktop-mac-arm64.zip\n")
    return root
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  /** Фид раздачи и «последняя версия» CLI: их выкладка обязана идти последней. */
  const isFeed = (value: string) => value.endsWith("/magnit-mac.yml") || value.endsWith("/latest")

  type Received = { method: string; path: string; auth: string | null; body: string; type: string | null }

  /** Локальный приёмник записи: собирает запросы в порядке поступления. */
  async function withServer(run: (endpoint: string) => Promise<unknown>) {
    const received: Received[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        received.push({
          method: request.method,
          path: url.pathname,
          auth: request.headers.get("authorization"),
          type: request.headers.get("content-type"),
          body: await request.text(),
        })
        return new Response("ok")
      },
    })
    try {
      await run(`http://localhost:${server.port}`)
    } finally {
      server.stop(true)
    }
    return received
  }

  test("S-B16: раскладка сервера — архивы CLI по версии, Desktop плоско, фиды на своих местах", async () => {
    const root = fixtures()
    const received = await withServer(async (endpoint) => {
      const result = await build(["--from-dist", root, "--publish", "--publish-to", "internal"], {
        CORP_BUILD: PUBLISH_BUILD,
        CORP_ARTIFACTS_ENDPOINT: endpoint,
        CORP_ARTIFACTS_TOKEN: "ci-secret-token",
        CORP_CLI_UPDATE_URL: "https://updates.example.corp/opencode/cli",
        CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode/desktop",
      })
      expect(result.out, result.out).toContain("опубликовано")
      expect(result.code).toBe(0)
    })

    const paths = received.map((request) => request.path)
    // Имя архива CLI обязано совпадать с тем, что строит artifactUrl() в corp/upgrade.ts (S-B14):
    // версия — каталогом, имя файла — без версии.
    expect(paths).toContain(`/opencode/cli/${publishVersion}/opencode-linux-x64.zip`)
    expect(paths).toContain(`/opencode/cli/${publishVersion}/opencode-darwin-arm64.zip`)
    expect(paths).toContain("/opencode/cli/latest")
    expect(paths).toContain("/opencode/desktop/opencode-magnit-desktop-mac-arm64.dmg")
    expect(paths).toContain("/opencode/desktop/opencode-magnit-desktop-mac-arm64.zip.blockmap")
    expect(paths).toContain("/opencode/desktop/magnit-mac.yml")

    const latest = received.find((request) => request.path.endsWith("/latest"))!
    expect(JSON.parse(latest.body)).toEqual({ version: publishVersion })
    for (const request of received) {
      expect(request.method).toBe("PUT")
      expect(request.auth).toBe("Bearer ci-secret-token")
    }
  }, 60_000)

  test("S-B16: фиды выкладываются ПОСЛЕ артефактов — клиент не увидит версию, которой ещё нет", async () => {
    const root = fixtures()
    const received = await withServer(async (endpoint) => {
      const result = await build(["--from-dist", root, "--publish", "--publish-to", "internal"], {
        CORP_BUILD: PUBLISH_BUILD,
        CORP_ARTIFACTS_ENDPOINT: endpoint,
        CORP_CLI_UPDATE_URL: "https://updates.example.corp/opencode/cli",
        CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode/desktop",
      })
      expect(result.code).toBe(0)
    })

    const paths = received.map((request) => request.path)
    const feeds = paths.map((value, index) => ({ value, index })).filter((entry) => isFeed(entry.value))
    const payload = paths.map((value, index) => ({ value, index })).filter((entry) => !isFeed(entry.value))
    expect(payload.length).toBeGreaterThan(0)
    expect(feeds.map((entry) => entry.value).sort()).toEqual([
      "/opencode/cli/latest",
      "/opencode/desktop/magnit-mac.yml",
    ])
    const lastPayload = Math.max(...payload.map((entry) => entry.index))
    for (const feed of feeds) {
      expect(feed.index, `фид ${feed.value} выложен раньше артефактов`).toBeGreaterThan(lastPayload)
    }
    // Отладочный дамп electron-builder на сервер раздачи не уезжает.
    expect(paths.join("\n")).not.toContain("builder-debug.yml")
  }, 60_000)

  test("S-B16: без CORP_ARTIFACTS_ENDPOINT публикация отказывает, а не уходит в GitHub", async () => {
    const root = fixtures()
    const result = await build(["--from-dist", root, "--publish", "--publish-to", "internal"], {
      CORP_BUILD: PUBLISH_BUILD,
      CORP_CLI_UPDATE_URL: "https://updates.example.corp/opencode/cli",
      CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode/desktop",
    })
    expect(result.code).toBe(1)
    expect(result.out).toContain("CORP_ARTIFACTS_ENDPOINT")
    expect(result.out).not.toContain("публикация релиза")
  }, 60_000)

  test("S-B16: без CORP_CLI_UPDATE_URL архивы CLI не выкладываются наугад", async () => {
    const root = fixtures()
    const received = await withServer(async (endpoint) => {
      const result = await build(["--from-dist", root, "--publish", "--publish-to", "internal"], {
        CORP_BUILD: PUBLISH_BUILD,
        CORP_ARTIFACTS_ENDPOINT: endpoint,
        CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode/desktop",
      })
      expect(result.code).toBe(1)
      expect(result.out).toContain("CORP_CLI_UPDATE_URL")
    })
    expect(received).toEqual([])
  }, 60_000)

  test("AC-104, S-B16: неизвестный режим публикации отвергается до сборки", async () => {
    const result = await build(["--skip-cli", "--publish", "--publish-to", "nowhere"])
    expect(result.code).toBe(1)
    expect(result.out).toContain("неизвестный режим публикации: nowhere; допустимые: github, internal")
    expect(result.out).not.toContain("версия сборки")
  }, 60_000)

  test("S-B16: --from-dist ничего не собирает", async () => {
    const root = fixtures()
    const result = await build(["--from-dist", root], { CORP_BUILD: PUBLISH_BUILD })
    expect(result.code).toBe(0)
    expect(result.out).toContain("--from-dist")
    expect(result.out).not.toContain("сборка CLI")
    expect(result.out).toContain("magnit-mac.yml")
  }, 60_000)
})

/**
 * Матрица сборки и публикация в корп-CI (S-B16, решения ревизии 1.10).
 *
 * Проверяется не YAML ради YAML, а решения, которые в нём закодированы и которые легко потерять
 * при следующей правке: Windows убран из матрицы тегов (но конфигурация NSIS не тронута), macOS
 * собирается обеими архитектурами одним заданием (иначе фидов будет два), фид попадает в артефакты,
 * а задание публикации гейтится наличием секрета и зовёт именно режим `internal`.
 */
describe("corp-ci.yml — матрица Desktop и публикация (S-B16)", () => {
  const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/corp-ci.yml"), "utf8")
  const matrix = /include: \$\{\{ fromJSON\((.+?)\) \}\}/.exec(ci)?.[1] ?? ""

  test("S-B16: в матрице тегов нет win-x64 — Windows возвращается флагом, а не восстановлением кода", () => {
    expect(matrix).not.toContain("win-x64")
    expect(matrix).not.toContain("--win")
    // Конфигурация NSIS остаётся на месте: убрана площадка сборки, а не поддержка Windows.
    const builder = fs.readFileSync(path.join(ROOT, "packages/desktop/electron-builder.config.ts"), "utf8")
    expect(builder).toContain('target: ["nsis"]')
    expect(builder).toContain("nsis: {")
  })

  test("S-B16: по тегу macOS собирается обеими архитектурами одним заданием", () => {
    const tagMatrix = matrix.slice(0, matrix.indexOf("||"))
    expect(tagMatrix).toContain("--arm64 --x64")
    expect((tagMatrix.match(/"runner":"macos-latest"/g) ?? []).length).toBe(1)
  })

  test("S-B16: фид апдейтера попадает в артефакты задания сборки", () => {
    expect(ci).toContain("packages/desktop/dist/*.yml")
  })

  test("S-B16: задание publish зависит от обеих сборок, гейтится секретом и публикует internal", () => {
    const publish = ci.slice(ci.indexOf("\n  publish:"), ci.indexOf("\n  release:"))
    expect(publish).toContain("needs: [build-cli, build-desktop]")
    expect(publish).toContain("secrets.CORP_ARTIFACTS_ENDPOINT")
    expect(publish).toContain("--publish --publish-to internal")
    // Скип обязан называть причину: «нечего публиковать» ≠ «внутренний хост не заведён».
    expect(publish).toContain("ready=false")
    expect(publish).toContain("публикация на внутренний сервер пропущена")
  })

  test("S-B16: на теге номер сборки берётся из corp/version, а не из переменной репозитория", () => {
    // Иначе имя тега (его считает corp-release.yml по corp/version) разошлось бы с версией внутри
    // артефактов — ровно тот класс дефекта, что «канал сборки молча откатился в dev».
    const guarded = ci.match(/CORP_BUILD: \$\{\{ startsWith\(github\.ref, 'refs\/tags\/v'\) && '' \|\| vars\.CORP_BUILD \}\}/g)
    expect(guarded?.length).toBe(2)
  })
})
