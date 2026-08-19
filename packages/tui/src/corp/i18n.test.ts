import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import * as CorpI18n from "./i18n"
import * as CorpState from "./state"

/**
 * Словарь корпоративных экранов TUI и общее состояние (S-I4, S-I5, S-V13;
 * AC-97, AC-98, AC-99, AC-71, AC-72).
 */

const HERE = import.meta.dirname
const TUI_SRC = path.resolve(HERE, "..")

const original = {
  lang: process.env["OPENCODE_CORP_LANG"],
  hub: process.env["OPENCODE_CORP_HUB_URL"],
}

afterEach(() => {
  for (const [key, value] of Object.entries({
    OPENCODE_CORP_LANG: original.lang,
    OPENCODE_CORP_HUB_URL: original.hub,
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

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

describe("tui/corp/i18n (AC-97, AC-99)", () => {
  test("AC-97: множества ключей ru и en совпадают", () => {
    const ru = Object.keys(CorpI18n.dictionaries.ru).sort()
    const en = Object.keys(CorpI18n.dictionaries.en).sort()
    expect(en).toEqual(ru)
    expect(ru.length).toBeGreaterThan(0)
  })

  test("AC-97: ни одно значение словаря не пустое", () => {
    for (const [key, value] of Object.entries(CorpI18n.dictionaries.ru)) expect(value, key).not.toBe("")
    for (const [key, value] of Object.entries(CorpI18n.dictionaries.en)) expect(value, key).not.toBe("")
  })

  test("AC-97: при включённых корп-функциях язык по умолчанию — ru", () => {
    delete process.env["OPENCODE_CORP_LANG"]
    process.env["OPENCODE_CORP_HUB_URL"] = "https://hub.test"
    expect(CorpI18n.language()).toBe("ru")
    expect(CorpI18n.t("login.title")).toBe(CorpI18n.dictionaries.ru["login.title"])
  })

  test("AC-97: OPENCODE_CORP_LANG=en переключает словарь на английский", () => {
    process.env["OPENCODE_CORP_HUB_URL"] = "https://hub.test"
    process.env["OPENCODE_CORP_LANG"] = "en"
    expect(CorpI18n.language()).toBe("en")
    expect(CorpI18n.t("login.title")).toBe(CorpI18n.dictionaries.en["login.title"])
  })

  test("AC-97: OPENCODE_CORP_LANG=ru работает и в ванильном режиме", () => {
    delete process.env["OPENCODE_CORP_HUB_URL"]
    process.env["OPENCODE_CORP_LANG"] = "RU"
    expect(CorpI18n.language()).toBe("ru")
  })

  test("AC-10: в ванильном режиме без OPENCODE_CORP_LANG язык — en", () => {
    delete process.env["OPENCODE_CORP_LANG"]
    delete process.env["OPENCODE_CORP_HUB_URL"]
    expect(CorpI18n.language()).toBe("en")
  })

  test("AC-99: для каждого кода ошибки S-A5 есть русский и английский текст", () => {
    for (const code of ERROR_CODES) {
      const key = `error.${code}` as CorpI18n.Key
      expect(CorpI18n.dictionaries.ru[key], code).toBeString()
      expect(CorpI18n.dictionaries.en[key], code).toBeString()
      expect(CorpI18n.dictionaries.ru[key], code).not.toBe("")
      expect(CorpI18n.dictionaries.en[key], code).not.toBe("")
    }
  })

  test("AC-99: errorText отдаёт текст по коду, неизвестный код — как есть", () => {
    process.env["OPENCODE_CORP_HUB_URL"] = "https://hub.test"
    delete process.env["OPENCODE_CORP_LANG"]
    expect(CorpI18n.errorText("hub_unavailable")).toBe(CorpI18n.dictionaries.ru["error.hub_unavailable"])
    expect(CorpI18n.errorText("совсем_неизвестный")).toBe("совсем_неизвестный")
    expect(CorpI18n.errorText(undefined)).toBe(CorpI18n.dictionaries.ru["error.unknown"])
  })

  test("AC-97: статусы витрины и пресеты переведены на оба языка", () => {
    for (const key of [
      "status.connected",
      "status.needs_auth",
      "status.not_connected",
      "status.unavailable",
      "preset.readonly",
      "preset.readwrite",
      "connectors.hubDown",
      "connectors.needsLogin",
      "connectors.empty",
    ] as CorpI18n.Key[]) {
      expect(CorpI18n.dictionaries.ru[key], key).toBeString()
      expect(CorpI18n.dictionaries.en[key], key).toBeString()
      expect(CorpI18n.dictionaries.ru[key], key).not.toBe(CorpI18n.dictionaries.en[key])
    }
  })
})

describe("tui/corp — отсутствие захардкоженных строк (AC-98)", () => {
  const files = [
    path.join(TUI_SRC, "corp/state.ts"),
    path.join(TUI_SRC, "component/corp/dialog-connectors.tsx"),
    path.join(TUI_SRC, "component/corp/dialog-corp-login.tsx"),
  ]

  test("AC-98: в корп-экранах TUI нет строковых литералов с кириллицей", () => {
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8")
      // Комментарии на русском разрешены, строковые литералы — нет.
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
      const literals = withoutComments.match(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g) ?? []
      const cyrillic = literals.filter((literal) => /[А-Яа-яЁё]/.test(literal))
      expect(cyrillic, path.basename(file)).toEqual([])
    }
  })
})

describe("tui/corp/state — подписи каталога для /mcps (AC-71, AC-72)", () => {
  test("AC-72: без прочитанного каталога подписи нет — поведение как в upstream", () => {
    expect(CorpState.titleFor("никогда-не-виденный-alias")).toBeUndefined()
  })

  test("AC-71: после чтения каталога alias получает человеческое название", () => {
    CorpState.rememberTitles([{ alias: "gitlab", title: "GitLab (coderepo)" }])
    expect(CorpState.titleFor("gitlab")).toBe("GitLab (coderepo)")
    expect(CorpState.hasTitles()).toBe(true)
    expect(CorpState.titleFor("другой")).toBeUndefined()
  })

  test("AC-71: период опроса входа общий для экранов TUI", () => {
    expect(CorpState.POLL_INTERVAL_MS).toBe(2000)
  })
})
