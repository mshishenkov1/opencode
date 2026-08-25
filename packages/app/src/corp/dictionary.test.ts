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

/**
 * Ключи ревизии 1.7 (S-I1, S-I3, S-I5; AC-166): экран прав недоступен, состав среза инструментов,
 * предупреждение о неполном каталоге и четвёртое пустое состояние витрины.
 */
const REVISION_17_KEYS = [
  "corp.connectors.permissionsUnavailable",
  "corp.connectors.toolsPreview",
  "corp.connectors.partial",
  "corp.empty.unparsed",
]

describe("i18n corp.* — тексты устойчивого разбора каталога (AC-166)", () => {
  test("AC-166: четыре новых ключа есть в en.ts и ru.ts, значения не совпадают", () => {
    for (const key of REVISION_17_KEYS) {
      const enValue = (en as Record<string, string>)[key]
      const ruValue = (ru as Record<string, string>)[key]
      expect(enValue, key).toBeString()
      expect(ruValue, key).toBeString()
      expect(enValue, key).not.toBe("")
      expect(ruValue, key).not.toBe("")
      expect(ruValue, key).not.toBe(enValue)
    }
  })

  test("AC-166: тексты витрины подставляются из словаря, а не захардкожены в коде", () => {
    const source = fs.readFileSync(path.join(APP_SRC, "components/corp/dialog-connectors.tsx"), "utf8")
    for (const key of REVISION_17_KEYS) {
      // Ключ используется экраном...
      expect(source, key).toContain(key)
      // ...а его тексты в исходнике не встречаются ни на одном языке.
      expect(source, key).not.toContain((ru as Record<string, string>)[key]!)
      expect(source, key).not.toContain((en as Record<string, string>)[key]!)
    }
  })

  test("AC-166: пустое состояние «Каталог не разобран» отличается текстом от «Каталог пуст»", () => {
    for (const dict of [en, ru] as Record<string, string>[]) {
      expect(dict["corp.empty.unparsed"]).not.toBe(dict["corp.connectors.empty"])
      expect(dict["corp.empty.unparsed"]).not.toBe(dict["corp.connectors.hubDown"])
      // Число отброшенных карточек — часть текста (S-V12).
      expect(dict["corp.empty.unparsed"]).toContain("{{dropped}}")
      expect(dict["corp.connectors.partial"]).toContain("{{dropped}}")
      expect(dict["corp.connectors.toolsPreview"]).toContain("{{preset}}")
    }
  })
})

/**
 * Словари состояний карточки, классов ошибок подключения и отключённого апгрейда
 * (S-I1, S-I3, S-I4, S-V19; AC-187).
 *
 * Ключи обязаны быть в обоих словарях Desktop/web, значения `ru` не равны значениям `en`, и те же
 * тексты есть в словаре TUI: обе оболочки говорят пользователю одно и то же (S-T10).
 */
describe("i18n corp.* — состояния карточки и классы ошибок (AC-187)", () => {
  /** Ключи, добавленные ревизией 1.9. */
  const KEYS = [
    "corp.connectors.connected",
    "corp.connectors.retry",
    "corp.connectors.forget",
    "corp.connectors.forgetConfirm",
    "corp.connectors.forgetHubFailed",
    "corp.connectors.neverConnected",
    "corp.connectors.lost",
    "corp.connectors.disconnected",
    "corp.error.connect.token_rejected",
    "corp.error.connect.method_unavailable",
    "corp.error.connect.hub_unreachable",
    "corp.error.connect.unknown",
    "corp.upgrade.disabled",
  ] as const

  const dictEn = en as Record<string, string>
  const dictRu = ru as Record<string, string>

  test("AC-187: все тринадцать ключей есть в en.ts и в ru.ts", () => {
    for (const key of KEYS) {
      expect(dictEn[key], `${key} отсутствует в en.ts`).toBeDefined()
      expect(dictRu[key], `${key} отсутствует в ru.ts`).toBeDefined()
      expect(String(dictEn[key]).trim().length, key).toBeGreaterThan(0)
      expect(String(dictRu[key]).trim().length, key).toBeGreaterThan(0)
    }
  })

  test("AC-187: значения ru не равны значениям en — перевод не забыт", () => {
    for (const key of KEYS) expect(dictRu[key], key).not.toBe(dictEn[key])
  })

  test("AC-187: те же тексты есть в словаре TUI", async () => {
    const tui = (await import("../../../tui/src/corp/i18n")) as {
      dictionaries: { ru: Record<string, string>; en: Record<string, string> }
    }
    /** Ключ TUI получается из ключа Desktop снятием префикса `corp.` (S-I4). */
    const tuiKey = (key: string) => key.replace(/^corp\./, "")
    /** Сравнение по смыслу: регистр подписи действия и подстановки `{{…}}` у оболочек свои. */
    const normalize = (value: string) =>
      value
        .replace(/\{\{[^}]+\}\}/g, "")
        .replace(/[«»"“”:.,\s]+/g, " ")
        .trim()
        .toLowerCase()

    for (const key of KEYS) {
      const short = tuiKey(key)
      expect(tui.dictionaries.ru[short], `${short} отсутствует в словаре TUI (ru)`).toBeDefined()
      expect(tui.dictionaries.en[short], `${short} отсутствует в словаре TUI (en)`).toBeDefined()
    }

    // Тексты состояний и классов ошибок совпадают дословно: их читает пользователь, и расходиться
    // между оболочками они не должны. Подписи действий и подтверждение — короче в терминале.
    const sameText = [
      "corp.connectors.connected",
      "corp.connectors.neverConnected",
      "corp.connectors.lost",
      "corp.connectors.disconnected",
      "corp.error.connect.token_rejected",
      "corp.error.connect.method_unavailable",
      "corp.error.connect.hub_unreachable",
      "corp.upgrade.disabled",
    ]
    for (const key of sameText) {
      expect(normalize(tui.dictionaries.ru[tuiKey(key)]!), key).toBe(normalize(dictRu[key]!))
      expect(normalize(tui.dictionaries.en[tuiKey(key)]!), key).toBe(normalize(dictEn[key]!))
    }
  })

  test("AC-187: у класса unknown есть свой текст — «ошибки без объяснения» не существует", () => {
    for (const dict of [dictEn, dictRu]) {
      const unknown = dict["corp.error.connect.unknown"]!
      expect(unknown.trim().length).toBeGreaterThan(0)
      // Текст называет ошибку с её кодом (S-V19, строка `unknown`).
      expect(unknown).toContain("{{code}}")
    }
  })
})
