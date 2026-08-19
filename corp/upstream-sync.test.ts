import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Скрипт синхронизации с upstream (S-B5; AC-107).
 *
 * Проверяются только ветки, которые останавливают скрипт до `git fetch` и `git rebase`:
 * запуск без тега и запуск на грязном рабочем дереве. Ветки с настоящим rebase (AC-105, AC-106)
 * меняют историю репозитория и выполняются вручную — процедура в отчёте.
 *
 * Запуск: `bun --cwd packages/opencode test ../../corp/upstream-sync.test.ts`.
 */

const ROOT = path.resolve(import.meta.dirname, "..")
const SCRIPT = path.join(ROOT, "corp/upstream-sync.sh")
const DIRTY = path.join(ROOT, "corp/.upstream-sync-test-dirty")

function sh(args: string[]) {
  const proc = Bun.spawnSync({
    cmd: ["bash", SCRIPT, ...args],
    cwd: ROOT,
    env: { ...process.env, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
}

function git(args: string[]) {
  const proc = Bun.spawnSync({ cmd: ["git", ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  return proc.stdout.toString()
}

afterEach(() => {
  fs.rmSync(DIRTY, { force: true })
})

describe("corp/upstream-sync.sh (AC-107)", () => {
  test("AC-107: грязное рабочее дерево — скрипт отказывается работать и ничего не меняет", () => {
    // Неотслеживаемый файл гарантирует «грязное дерево» независимо от состояния ветки.
    fs.writeFileSync(DIRTY, "грязь\n")
    const headBefore = git(["rev-parse", "HEAD"])
    const statusBefore = git(["status", "--porcelain"])

    const result = sh(["v1.17.9"])

    expect(result.code).toBe(1)
    expect(result.out).toContain("рабочее дерево не чистое")
    // До fetch и rebase скрипт не дошёл.
    expect(result.out).not.toContain("git rebase")
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore)
    expect(git(["status", "--porcelain"])).toBe(statusBefore)
  })

  test("AC-107: без тега скрипт печатает подсказку и завершается с кодом 2", () => {
    const result = sh([])
    expect(result.code).toBe(2)
    expect(result.out).toContain("укажите тег upstream")
  })

  test("AC-105: скрипт ничего не пушит", () => {
    const source = fs.readFileSync(SCRIPT, "utf8")
    expect(source).not.toMatch(/^\s*git push/m)
  })
})
