import { describe, expect, test } from "bun:test"
import fs from "fs"
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
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  const proc = Bun.spawn({
    cmd: ["bun", "run", SCRIPT, ...args],
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
