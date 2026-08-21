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

  /**
   * AC-112 (ревизия 1.6). Прежняя редакция S-B9 замораживала файл целиком, и тест требовал
   * отсутствия правок во всём `packages/desktop/`. Ревизия 1.6 заменила заморозку ограниченным
   * разрешением: корпоративная ветка канала `magnit` добавляется, а `dev`/`beta`/`prod`, общая часть
   * `getBase()` и блоки подписи остаются upstream. Проверяется теперь объём правок, а не их
   * отсутствие; значения каналов — в `packages/desktop/electron-builder.config.corp.test.ts`.
   */
  describe("AC-112: объём правок конфигурации упаковки Desktop", () => {
    const file = "packages/desktop/electron-builder.config.ts"

    test("AC-112: файл — правка upstream и перечислен в реестре", () => {
      const changed = changedUpstreamFiles(git(["diff", "--name-status", base]))
      expect(changed).toContain(file)
      expect(listedFiles(markdown)).toContain(file)
      const row = rows(markdown).find((entry) => entry.file === file)
      expect(row?.rule).toMatch(/S-B9/)
    })

    test("AC-112: подпись не изменена", () => {
      const changed = changedUpstreamFiles(git(["diff", "--name-status", base]))
      expect(changed).not.toContain("script/sign-windows.ps1")
      expect(fs.existsSync(path.join(ROOT, "script/sign-windows.ps1"))).toBe(true)
    })

    test("AC-112: из файла удалён только прежний разбор OPENCODE_CHANNEL", () => {
      const diff = git(["diff", "--unified=0", base, "--", file]).split("\n")
      const removed = diff
        .filter((line) => line.startsWith("-") && !line.startsWith("---"))
        .map((line) => line.slice(1).trim())
      // Любая правка ванильной ветки, общей части getBase() или блока подписи — это удалённая
      // строка, которой здесь быть не должно (S-B9: «иных правок в файле не вносится»).
      expect(removed).toEqual([
        'if (raw === "dev" || raw === "beta" || raw === "prod") return raw',
        'return "dev"',
      ])
    })

    test("AC-112: добавленные строки не приносят чужой адрес и не трогают подпись", () => {
      const diff = git(["diff", "--unified=0", base, "--", file]).split("\n")
      const added = diff
        .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
        .map((line) => line.slice(1))
      expect(added.length).toBeGreaterThan(0)
      for (const line of added) {
        // Адрес обновлений приходит только из переменной сборки (S-B11, D-24).
        expect(line, line).not.toMatch(/https?:\/\//)
        expect(line, line).not.toMatch(/anomalyco|provider:\s*"github"/)
        expect(line, line).not.toMatch(/notarize|signtoolOptions|hardenedRuntime|entitlements/)
      }
    })

    test("AC-112: строки идентичности, публикации и подписи upstream сохранены байт в байт", () => {
      const upstream = git(["show", `${base}:${file}`]).split("\n")
      const current = new Set(fs.readFileSync(path.join(ROOT, file), "utf8").split("\n"))
      const guarded =
        /notarize|dmg|signtoolOptions|signWindows|productName|appId|publish|packageName|legacyDesktopEntry|APP_IDS|"ai\.opencode\.desktop/
      const lines = upstream.filter((line) => guarded.test(line))
      expect(lines.length).toBeGreaterThan(10)
      for (const line of lines) expect(current.has(line), line).toBe(true)
    })
  })

  test("AC-01: базовый тег реестра берётся из corp/upstream-base и существует", () => {
    expect(base).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(git(["rev-parse", "--verify", `${base}^{commit}`]).trim()).toMatch(/^[0-9a-f]{40}$/)
    expect(markdown).toContain(base)
  })
})
