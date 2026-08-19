import { describe, expect, test } from "bun:test"
import path from "path"
import { hasCorpKey, setCorpKey } from "./state"

/**
 * Признак корпоративного ключа для подсветки команды входа (S-T2; AC-74).
 *
 * `suggested` команды `corp.login` опирается на отсутствие ключа `magnit_prod`, а не на
 * upstream-признак «есть хоть какой-то подключённый провайдер»: при подключённом стороннем
 * провайдере и отсутствии корп-ключа подсказка должна оставаться.
 */

const TUI = path.resolve(import.meta.dirname, "../..")

describe("tui/corp — признак корп-ключа (S-T2, AC-74)", () => {
  test("AC-74: до ответа GET /corp/status ключа нет, команда входа подсвечена", () => {
    setCorpKey(false)
    expect(hasCorpKey()).toBe(false)
    // Так значение читает app.tsx: `suggested: !hasCorpKey()`.
    expect(!hasCorpKey()).toBe(true)
  })

  test("AC-74: после успешного входа подсказка снимается, а выход из аккаунта её возвращает", () => {
    setCorpKey(true)
    expect(hasCorpKey()).toBe(true)
    expect(!hasCorpKey()).toBe(false)

    setCorpKey(false)
    expect(hasCorpKey()).toBe(false)
  })
})

describe("tui/corp — источник признака (S-T2)", () => {
  test("AC-74: команда corp.login берёт suggested из hasCorpKey(), а признак — из поля authenticated", async () => {
    const source = await Bun.file(path.join(TUI, "src/app.tsx")).text()

    const login = source.slice(source.indexOf('name: "corp.login"'))
    expect(login.slice(0, login.indexOf("run:"))).toContain("suggested: !hasCorpKey()")
    // Значение приходит только из GET /corp/status (S-A11): поле authenticated, не connected().
    expect(source).toContain("setCorpKey(result.data?.authenticated === true)")
    expect(login.slice(0, login.indexOf("run:"))).not.toContain("suggested: !connected()")
  })
})
