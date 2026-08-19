import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { dict as en } from "../i18n/en"
import { dict as ru } from "../i18n/ru"

/**
 * Словари корпоративного слоя Desktop/web (S-I1, S-I3, S-I5; AC-93, AC-98, AC-99).
 */

const APP_SRC = path.resolve(import.meta.dirname, "..")

const corpKeys = (dict: Record<string, string>) =>
  Object.keys(dict)
    .filter((key) => key.startsWith("corp."))
    .sort()

/** Коды ошибок корп-роутов (S-A5). */
const ERROR_CODES = [
  "corp_disabled",
  "hub_unavailable",
  "hub_invalid_response",
  "login_expired",
  "forbidden",
  "invalid_team",
  "team_selection_not_required",
  "rate_limited",
  "litellm_unavailable",
  "litellm_invalid_response",
  "unauthorized",
]

describe("i18n corp.* (AC-93, AC-99)", () => {
  test("AC-93: множества ключей corp.* в en.ts и ru.ts совпадают", () => {
    const enKeys = corpKeys(en as Record<string, string>)
    const ruKeys = corpKeys(ru as Record<string, string>)
    expect(enKeys.length).toBeGreaterThan(0)
    expect(ruKeys).toEqual(enKeys)
  })

  test("AC-93: ни одно значение corp.* в ru.ts не равно значению en.ts", () => {
    for (const key of corpKeys(en as Record<string, string>)) {
      const enValue = (en as Record<string, string>)[key]!
      const ruValue = (ru as Record<string, string>)[key]!
      expect(ruValue, key).not.toBe(enValue)
    }
  })

  test("AC-99: для каждого кода ошибки S-A5 есть русский и английский текст", () => {
    for (const code of ERROR_CODES) {
      const key = `corp.error.${code}`
      expect((en as Record<string, string>)[key], key).toBeString()
      expect((ru as Record<string, string>)[key], key).toBeString()
    }
    expect((en as Record<string, string>)["corp.error.unknown"]).toBeString()
    expect((ru as Record<string, string>)["corp.error.unknown"]).toBeString()
  })

  test("AC-93: тексты витрины, входа и пресетов есть в обоих словарях", () => {
    for (const key of [
      "corp.login.title",
      "corp.login.code",
      "corp.login.waiting",
      "corp.login.teamTitle",
      "corp.connectors.title",
      "corp.connectors.empty",
      "corp.connectors.hubDown",
      "corp.connectors.needsLogin",
      "corp.connectors.connect",
      "corp.connectors.disconnect",
      "corp.connectors.permissions",
      "corp.connectors.openHub",
      "corp.status.connected",
      "corp.status.needs_auth",
      "corp.status.not_connected",
      "corp.status.unavailable",
      "corp.preset.readonly",
      "corp.preset.readwrite",
    ]) {
      expect((en as Record<string, string>)[key], key).toBeString()
      expect((ru as Record<string, string>)[key], key).toBeString()
    }
  })
})

describe("корп-экраны Desktop/web (AC-85, AC-98)", () => {
  test("AC-98: в корп-экранах нет строковых литералов с кириллицей", () => {
    for (const file of [
      path.join(APP_SRC, "corp/enabled.ts"),
      path.join(APP_SRC, "context/corp.ts"),
      path.join(APP_SRC, "components/corp/dialog-connectors.tsx"),
      path.join(APP_SRC, "components/corp/dialog-corp-login.tsx"),
    ]) {
      const source = fs.readFileSync(file, "utf8")
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
      const literals = withoutComments.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
      expect(
        literals.filter((literal) => /[А-Яа-яЁё]/.test(literal)),
        path.basename(file),
      ).toEqual([])
    }
  })

  test("AC-85: маршрут /connectors в роутер не добавлен, порядок upstream-маршрутов прежний", () => {
    const source = fs.readFileSync(path.join(APP_SRC, "app.tsx"), "utf8")
    expect(source).not.toContain('path="/connectors"')
    const routes = [...source.matchAll(/path="([^"]+)"/g)].map((match) => match[1])
    expect(routes).toEqual(["/", "/:dir", "/", "/session/:id?", "/new-session"])
  })
})
