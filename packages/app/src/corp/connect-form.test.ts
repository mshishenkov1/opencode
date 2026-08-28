import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { dict as en } from "../i18n/en"
import { dict as ru } from "../i18n/ru"

/**
 * Блок подключения на странице коннектора (S-D13, ревизия 1.13; AC-312, AC-330, AC-332, AC-333,
 * AC-334, AC-341).
 *
 * Правило живёт в `dialog-connector.tsx`: чистые функции (`methodChoice`, `lengthError`,
 * `verifyKey`, `exchangeKey`, `connectBlockVisible`, `connectUnavailableKey`) исполняются как есть
 * из исходника — копии правила в тесте нет (тот же приём, что в `connector-page.test.ts`).
 * Разметка (`data-slot`/`data-action`) проверяется по срезу исходника: тест смотрит, что условие
 * `Show when={…}` в дереве ссылается на настоящее поле карточки, а не пересказывает его текстом.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/connect-form.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const PAGE = path.join(APP, "components/corp/dialog-connector.tsx")
const source = fs.readFileSync(PAGE, "utf8")

/** Тело именованного объявления (функции или блока) — по образцу `connector-page.test.ts`. */
function block(marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const open = source.indexOf("{", source.indexOf(")", at))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0)
        return source
          .slice(open + 1, index)
          .replace(/\bas const\b/g, "")
          .replace(/\b(const|let)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=/g, "$1 $2 =")
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

interface AuthMethodField {
  label: string
  secret?: boolean
  hint?: string
  docs_url?: string
  placeholder?: string
  min_length?: number
  max_length?: number
}
interface AuthMethodView {
  id: string
  title: string
  type: "oauth2" | "user_token"
  available: boolean
  unavailable_code: string | null
  unavailable_reason?: string
  field?: AuthMethodField
}

const methodChoice = new Function("methods", block("export function methodChoice(")) as (
  methods: AuthMethodView[],
) => "single" | "list" | "none"

// `lengthError` вызывает локальный хелпер `bound` — тот не входит в его собственное тело
// объявления, поэтому оба блока склеены в одну функцию, а не скопированы порознь.
const lengthError = new Function(
  "value",
  "field",
  `function bound(value) {${block("function bound(")}}\n${block("export function lengthError(")}`,
) as (value: string, field: AuthMethodField | undefined) => { key: string; n: number } | undefined

const verifyKey = new Function("result", "account", block("export function verifyKey(")) as (
  result: string,
  account: string | undefined,
) => string

const exchangeKey = new Function("result", block("export function exchangeKey(")) as (
  result: string | null | undefined,
) => string | undefined

const connectBlockVisible = new Function(
  "card",
  "justConnected",
  block("export function connectBlockVisible("),
) as (card: { connect_mode?: string; state?: string } | undefined, justConnected: boolean) => boolean

const connectUnavailableKey = new Function("card", block("export function connectUnavailableKey(")) as (card: {
  connect_mode_unavailable_code?: string | null
}) => string | undefined

describe("dialog-connector — методChoice: три случая S-V28 п.4 (AC-312)", () => {
  test("AC-312: доступных нет ни одного → \"none\" (случай 3: формы нет)", () => {
    const methods: AuthMethodView[] = [
      { id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" },
    ]
    expect(methodChoice(methods)).toBe("none")
  })

  test("AC-312: доступен ровно один способ, недоступных нет → \"single\" (случай 1: выбора нет, сразу форма)", () => {
    const methods: AuthMethodView[] = [
      { id: "a", title: "A", type: "user_token", available: true, unavailable_code: null },
    ]
    expect(methodChoice(methods)).toBe("single")
  })

  test("AC-312: способов больше одного, в любом сочетании доступности → \"list\" (случай 2: список всех)", () => {
    const bothAvailable: AuthMethodView[] = [
      { id: "a", title: "A", type: "user_token", available: true, unavailable_code: null },
      { id: "b", title: "B", type: "user_token", available: true, unavailable_code: null },
    ]
    const oneUnavailable: AuthMethodView[] = [
      { id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" },
      { id: "b", title: "B", type: "user_token", available: true, unavailable_code: null },
    ]
    expect(methodChoice(bothAvailable)).toBe("list")
    expect(methodChoice(oneUnavailable)).toBe("list")
  })
})

describe("dialog-connector — валидация длины до сети (S-D13 п.4; AC-332)", () => {
  test("AC-332: пустое значение — без сообщения (кнопка неактивна отдельно, запроса тоже нет)", () => {
    expect(lengthError("", { label: "T", min_length: 20 })).toBeUndefined()
  })

  test("AC-332: значение короче min_length — corp.connect.tooShort с числом границы", () => {
    expect(lengthError("a".repeat(19), { label: "T", min_length: 20 })).toEqual({ key: "corp.connect.tooShort", n: 20 })
  })

  test("AC-332: значение длиннее max_length — corp.connect.tooLong", () => {
    expect(lengthError("a".repeat(41), { label: "T", max_length: 40 })).toEqual({ key: "corp.connect.tooLong", n: 40 })
  })

  test("AC-332: без границ — любое значение годится (границ у поля может не быть, S-V24 п.2)", () => {
    expect(lengthError("x", { label: "T" })).toBeUndefined()
    expect(lengthError("x".repeat(500), { label: "T" })).toBeUndefined()
  })
})

describe("dialog-connector — пять исходов проверки и четыре исхода обмена различимы попарно (AC-334, AC-336)", () => {
  test("AC-334/AC-336: пять значений verifyKey все РАЗНЫЕ, включая различие verified/verifiedAs", () => {
    const keys = [
      verifyKey("verified", undefined),
      verifyKey("verified", "ivanov"),
      verifyKey("account_missing", undefined),
      verifyKey("token_rejected", undefined),
      verifyKey("verify_failed", undefined),
      verifyKey("upstream_unreachable", undefined),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("AC-334/AC-336: четыре значения exchangeKey все РАЗНЫЕ; отсутствие обмена (null) не показывает ничего", () => {
    const keys = [
      exchangeKey("exchanged"),
      exchangeKey("exchange_denied"),
      exchangeKey("exchange_failed"),
      exchangeKey("exchange_unreachable"),
    ]
    expect(new Set(keys).size).toBe(4)
    expect(exchangeKey(null)).toBeUndefined()
    expect(exchangeKey(undefined)).toBeUndefined()
  })
})

describe("dialog-connector — видимость блока подключения (S-D13 п.1; AC-333, AC-330)", () => {
  test("AC-333: пока карточка не получена — блока нет (\"форма всегда на экране\" не утверждается)", () => {
    expect(connectBlockVisible(undefined, false)).toBe(false)
  })

  test("AC-333: connect_mode:\"direct\" и не «Подключено» — блок есть", () => {
    expect(connectBlockVisible({ connect_mode: "direct", state: "never" }, false)).toBe(true)
  })

  test("AC-333, AC-330: connect_mode:\"native\"/\"facade\"/\"none\" — блока нет вовсе", () => {
    for (const mode of ["native", "facade", "none"])
      expect(connectBlockVisible({ connect_mode: mode, state: "never" }, false)).toBe(false)
  })

  test("AC-330 (S-V29 п.1): в состоянии 4 «Подключено» блока НЕТ, даже если connect_mode:\"direct\"", () => {
    expect(connectBlockVisible({ connect_mode: "direct", state: "connected" }, false)).toBe(false)
  })

  test("AC-334: только что показанный успех (justConnected) держит блок на экране в состоянии 4", () => {
    expect(connectBlockVisible({ connect_mode: "direct", state: "connected" }, true)).toBe(true)
  })
})

describe("dialog-connector — причина недоступности «Подключить» на уровне карточки (S-V28 п.2, п.4; AC-341)", () => {
  test("AC-341: oauth_disabled и facade_needs_hub — РАЗНЫЕ ключи, слияние запрещено", () => {
    const oauth = connectUnavailableKey({ connect_mode_unavailable_code: "oauth_disabled" })
    const facade = connectUnavailableKey({ connect_mode_unavailable_code: "facade_needs_hub" })
    expect(oauth).toBe("corp.connectors.methodUnavailable.oauthDisabled")
    expect(facade).toBe("corp.connectors.facadeNeedsHub")
    expect(oauth).not.toBe(facade)
  })

  test("AC-341: connect_mode_unavailable_code отсутствует (null) — причины нет, действие работает", () => {
    expect(connectUnavailableKey({ connect_mode_unavailable_code: null })).toBeUndefined()
  })
})

describe("dialog-connector — разметка: oauth_disabled рисует действие НЕАКТИВНЫМ, facade_needs_hub убирает его (AC-341)", () => {
  const statusBlock = source.slice(source.indexOf("{/* 4. Статус"), source.indexOf("{/* 5."))

  test("AC-341: кнопка «Подключить» отрисована с disabled по connect_mode_unavailable_code === \"oauth_disabled\"", () => {
    expect(statusBlock).toContain('data-action="corp-connect"')
    expect(statusBlock).toContain('entry().connect_mode_unavailable_code === "oauth_disabled"')
    // Кнопка — ВНУТРИ общего условия по actions.includes("connect"/"reconnect"), а не спрятана за
    // отдельной проверкой oauth_disabled: у native-карточки "connect" остаётся в actions (S-V16
    // не тронут), поэтому кнопка присутствует и лишь неактивна — не исчезает.
    const connectShow = statusBlock.indexOf('entry().actions.includes("connect") || entry().actions.includes("reconnect")')
    const buttonAt = statusBlock.indexOf('data-action="corp-connect"')
    expect(connectShow).toBeGreaterThan(-1)
    expect(buttonAt).toBeGreaterThan(connectShow)
  })

  test("AC-341: причина oauth_disabled отрисована РЯДОМ (в том же блоке), а не в другой части экрана", () => {
    expect(statusBlock).toContain('data-slot="corp-connect-disabled-reason"')
    expect(statusBlock).toContain('corp.connectors.methodUnavailable.oauthDisabled')
  })

  test("AC-341: facade_needs_hub — прежний текст ревизии 1.11 дословно, AC-252 не переформулирован", () => {
    expect(statusBlock).toContain('language.t("corp.connectors.facadeNeedsHub")')
  })
})

/**
 * Матрица ветвей блока подключения без слова «Hub» (AC-336, S-Q9 (ч), продолжение AC-275).
 *
 * Перечни исходов взяты из тех же функций, которыми они объявлены в коде (`verifyKey`,
 * `exchangeKey`, `connectUnavailableKey`), а не переписаны текстом — новый исход без ветки словаря
 * эту проверку не пройдёт. Текст берётся из словаря по ключу, который эти функции реально вернули
 * бы на экране, — не грep по всему словарю: значения ключей за пределами `corp.connect.*` подстроку
 * «Hub» иметь вправе.
 */
describe("dialog-connector — блок подключения без слова «Hub» ни в одной из девяти ветвей (AC-336)", () => {
  const dicts = { en: en as Record<string, string>, ru: ru as Record<string, string> }

  test("AC-336: пять текстов verify_result, четыре текста exchange_result, три причины недоступности — без «Hub»", () => {
    const verifyResults = ["verified", "account_missing", "token_rejected", "verify_failed", "upstream_unreachable"]
    const exchangeResults = ["exchanged", "exchange_denied", "exchange_failed", "exchange_unreachable"]
    const unavailableCauses = [
      { connect_mode_unavailable_code: "oauth_disabled" },
      { connect_mode_unavailable_code: "facade_needs_hub" },
      { connect_mode_unavailable_code: "no_method" },
    ]

    const keys = [
      ...verifyResults.map((result) => verifyKey(result, undefined)),
      verifyKey("verified", "ivanov"), // verifiedAs — отдельный текст с подстановкой account
      ...exchangeResults.map((result) => exchangeKey(result)!),
      ...unavailableCauses.map((card) => connectUnavailableKey(card)!),
    ]
    expect(keys.every((key) => key !== undefined)).toBe(true)

    for (const [locale, dict] of Object.entries(dicts))
      for (const key of keys) {
        const text = dict[key]
        expect(text, `${locale}.${key}`).toBeString()
        expect(text!.toLowerCase(), `${locale}.${key} = ${text}`).not.toContain("hub")
      }
  })

  test("AC-336: заголовок блока, кнопка «Подключить», «Заменить токен» — без «Hub»", () => {
    for (const key of ["corp.connect.title", "corp.connect.submit", "corp.connect.replace", "corp.connect.chooseMethod"])
      for (const [locale, dict] of Object.entries(dicts)) {
        expect(dict[key], `${locale}.${key}`).toBeString()
        expect(dict[key]!.toLowerCase(), `${locale}.${key}`).not.toContain("hub")
      }
  })
})
