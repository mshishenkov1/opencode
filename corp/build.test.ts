import { describe, expect, test } from "bun:test"
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
