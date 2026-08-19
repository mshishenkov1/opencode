import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Реестр правок upstream (S-B6, S-B9, S-Q7; AC-13, AC-108, AC-112, AC-119).
 *
 * Множество upstream-файлов, изменённых относительно базового тега, должно совпадать с таблицей
 * `corp/patches.md`. Новые корп-файлы в таблицу не входят — они добавлены, а не изменены.
 *
 * Запуск: `bun --cwd packages/opencode test ../../corp/patches.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "..")

function git(args: string[]) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
  return proc.stdout.toString()
}

const base = fs.readFileSync(path.join(ROOT, "corp/upstream-base"), "utf8").trim()

/** Файлы upstream, изменённые относительно базового тега (добавленные корп-файлы не в счёт). */
export function changedUpstreamFiles(nameStatus: string): string[] {
  return nameStatus
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([status]) => status !== undefined && status[0] !== "A")
    .map((parts) => parts[parts.length - 1]!)
    .sort()
}

/** Пути из таблицы `corp/patches.md` (первая колонка, в обратных кавычках). */
export function listedFiles(markdown: string): string[] {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .map((cells) => cells[1] ?? "")
    .map((cell) => /^`([^`]+)`$/.exec(cell)?.[1])
    .filter((value): value is string => value !== undefined)
    .sort()
}

/** Строки таблицы: файл, правило, причина, коммит. */
export function rows(markdown: string) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    )
    .filter((cells) => /^`[^`]+`$/.test(cells[0] ?? ""))
    .map((cells) => ({
      file: cells[0]!.slice(1, -1),
      rule: cells[1] ?? "",
      reason: cells[2] ?? "",
      commit: cells[3] ?? "",
    }))
}

/** Файлы, изменённые в upstream, но не попавшие в реестр (S-Q7). */
export function unlisted(changed: string[], listed: string[]) {
  const known = new Set(listed)
  return changed.filter((file) => !known.has(file)).sort()
}

/** Файлы реестра, которых больше нет среди изменённых (реестр устарел). */
export function stale(changed: string[], listed: string[]) {
  const known = new Set(changed)
  return listed.filter((file) => !known.has(file)).sort()
}

const markdown = fs.readFileSync(path.join(ROOT, "corp/patches.md"), "utf8")

describe("corp/patches.md — реестр правок upstream (AC-13, AC-108, AC-119)", () => {
  test("AC-119: сравнение реестра называет отсутствующий файл", () => {
    const changed = ["packages/opencode/src/index.ts", "packages/tui/src/app.tsx"]
    const listed = ["packages/tui/src/app.tsx"]
    expect(unlisted(changed, listed)).toEqual(["packages/opencode/src/index.ts"])
    expect(unlisted(changed, changed)).toEqual([])
    expect(stale(changed, [...listed, "packages/app/src/app.tsx"])).toEqual(["packages/app/src/app.tsx"])
  })

  test("AC-119: добавленные файлы не считаются правками upstream", () => {
    const nameStatus = [
      "A\tpackages/opencode/src/corp/hub.ts",
      "M\tpackages/opencode/src/index.ts",
      "D\tpackages/opencode/src/legacy.ts",
      "R100\tpackages/old.ts\tpackages/new.ts",
    ].join("\n")
    expect(changedUpstreamFiles(nameStatus)).toEqual([
      "packages/new.ts",
      "packages/opencode/src/index.ts",
      "packages/opencode/src/legacy.ts",
    ])
  })

  test("AC-108: каждая строка таблицы содержит файл, правило, причину и коммит", () => {
    const table = rows(markdown)
    expect(table.length).toBeGreaterThan(0)
    for (const row of table) {
      expect(row.file, row.file).toMatch(/^[\w./@-]+$/)
      expect(row.rule, row.file).not.toBe("")
      expect(row.reason.length, row.file).toBeGreaterThan(10)
      expect(row.commit, row.file).toMatch(/`[0-9a-f]{7,40}`/)
    }
  })

  test("AC-108: у каждой строки, кроме служебных, указано правило спецификации", () => {
    for (const row of rows(markdown)) {
      if (row.rule === "—") continue
      expect(row.rule, row.file).toMatch(/S-[A-Z]\d/)
    }
  })

  test("AC-13, S-Q7: множество изменённых upstream-файлов совпадает с реестром", () => {
    const changed = changedUpstreamFiles(git(["diff", "--name-status", base]))
    const listed = listedFiles(markdown)
    expect(unlisted(changed, listed)).toEqual([])
    expect(stale(changed, listed)).toEqual([])
  })

  test("AC-13: каждый коммит ветки имеет заголовок с префиксом `corp: `", () => {
    const log = git(["log", "--format=%s", `${base}..HEAD`])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    expect(log.length).toBeGreaterThan(0)
    for (const subject of log) expect(subject, subject).toStartWith("corp: ")
  })

  test("AC-112: packages/desktop/electron-builder.config.ts не изменён", () => {
    const changed = changedUpstreamFiles(git(["diff", "--name-status", base]))
    expect(changed).not.toContain("packages/desktop/electron-builder.config.ts")
    expect(changed.filter((file) => file.startsWith("packages/desktop/"))).toEqual([])
    expect(changed).not.toContain("packages/opencode/script/sign-windows.ps1")
  })

  test("AC-01: базовый тег реестра берётся из corp/upstream-base и существует", () => {
    expect(base).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(git(["rev-parse", "--verify", `${base}^{commit}`]).trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(markdown).toContain(base)
  })
})
