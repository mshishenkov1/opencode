import { describe, expect, test } from "bun:test"
import path from "path"
import { dictionaries as tuiDict } from "./i18n"

/**
 * Паритет TUI по прямому подключению токеном (S-T12, ревизия 1.13; AC-335, AC-336, AC-344).
 *
 * Тела чистых функций берутся из исходника `dialog-connect-token.tsx` и `dialog-connectors.tsx` и
 * исполняются как есть — тот же приём, что в `dialog-actions.test.ts`. Компонент не рендерится:
 * проверяется наблюдаемое поведение самих функций и разметка на срезе исходника.
 */

const CONNECT_TOKEN = path.resolve(import.meta.dirname, "../component/corp/dialog-connect-token.tsx")
const connectSource = await Bun.file(CONNECT_TOKEN).text()
const CONNECTORS = path.resolve(import.meta.dirname, "../component/corp/dialog-connectors.tsx")
const connectorsSource = await Bun.file(CONNECTORS).text()

function block(source: string, marker: string) {
  const at = source.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const open = source.indexOf("{", source.indexOf(")", at))
  let depth = 0
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth += 1
    else if (source[index] === "}") {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, index).replace(/\bas const\b/g, "")
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

interface AuthMethodField {
  label: string
  secret?: boolean
  min_length?: number
  max_length?: number
}
interface AuthMethodView {
  id: string
  title: string
  type: "oauth2" | "user_token"
  available: boolean
  unavailable_code: string | null
  field?: AuthMethodField
}

const methodChoice = new Function("methods", block(connectSource, "export function methodChoice(")) as (
  methods: AuthMethodView[],
) => "single" | "list" | "none"

const maskedValue = new Function(
  "value",
  "secret",
  `const MASK = "•"\n${block(connectSource, "export function maskedValue(")}`,
) as (value: string, secret: boolean) => string

const applyMaskedEdit = new Function(
  "previous",
  "screen",
  "mask",
  `const MASK = "•"\nif (mask === undefined) mask = MASK\n${block(connectSource, "export function applyMaskedEdit(")}`,
) as (previous: string, screen: string, mask?: string) => string

const lengthError = new Function(
  "value",
  "field",
  `function bound(value) {${block(connectSource, "function bound(")}}\n${block(connectSource, "export function lengthError(")}`,
) as (value: string, field: AuthMethodField | undefined) => { key: string; n: number } | undefined

const verifyKey = new Function("result", "account", block(connectSource, "export function verifyKey(")) as (
  result: string,
  account?: string,
) => string

const exchangeKey = new Function("result", block(connectSource, "export function exchangeKey(")) as (
  result: string | null | undefined,
) => string | undefined

const revokeKey = new Function("result", block(connectSource, "export function revokeKey(")) as (
  result: string | null | undefined,
) => string | undefined

const connectDisabled = new Function("card", block(connectorsSource, "export function connectDisabled(")) as (
  card: { connect_mode_unavailable_code?: string } | undefined,
) => boolean

const connectDirect = new Function("card", block(connectorsSource, "export function connectDirect(")) as (
  card: { connect_mode?: string } | undefined,
) => boolean

describe("TUI dialog-connect-token — способ, маска, длина, исходы (S-T12; AC-335)", () => {
  test("методChoice — те же три случая, что в Desktop (AC-312, AC-335)", () => {
    expect(methodChoice([{ id: "a", title: "A", type: "user_token", available: true, unavailable_code: null }])).toBe(
      "single",
    )
    expect(
      methodChoice([
        { id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" },
        { id: "b", title: "B", type: "user_token", available: true, unavailable_code: null },
      ]),
    ).toBe("list")
    expect(
      methodChoice([{ id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" }]),
    ).toBe("none")
  })

  test("маскирование: ввод маскирован при field.secret != false, значение восстанавливается по разнице экранов", () => {
    expect(maskedValue("abcdef", true)).toBe("••••••")
    expect(maskedValue("abcdef", false)).toBe("abcdef")
    // Дописан символ в конец.
    expect(applyMaskedEdit("abc", "•••d")).toBe("abcd")
    // Удалён последний символ.
    expect(applyMaskedEdit("abcd", "•••")).toBe("abc")
    // Вставка в середину.
    expect(applyMaskedEdit("ac", "•X•")).toBe("aXc")
  })

  test("длина проверяется до сети — те же сообщения, что в Desktop (AC-332, AC-335)", () => {
    expect(lengthError("", { label: "T", min_length: 20 })).toBeUndefined()
    expect(lengthError("a".repeat(3), { label: "T", min_length: 4 })).toEqual({ key: "connect.tooShort", n: 4 })
    expect(lengthError("a".repeat(41), { label: "T", max_length: 40 })).toEqual({ key: "connect.tooLong", n: 40 })
  })

  test("пять исходов verify_result различимы попарно; четыре исхода exchange_result — тоже (AC-316, AC-318, AC-335)", () => {
    const verifyResults = ["verified", "account_missing", "token_rejected", "verify_failed", "upstream_unreachable"]
    const verifyKeys = verifyResults.map((result) => verifyKey(result))
    expect(new Set(verifyKeys).size).toBe(5)
    expect(verifyKey("verified", "ivanov")).not.toBe(verifyKey("verified"))

    const exchangeResults = ["exchanged", "exchange_denied", "exchange_failed", "exchange_unreachable"]
    const exchangeKeys = exchangeResults.map((result) => exchangeKey(result))
    expect(new Set(exchangeKeys).size).toBe(4)
    expect(exchangeKey(null)).toBeUndefined()
  })

  test("три исхода отзыва различимы; skipped не показывает ничего (S-V27 п.2)", () => {
    const keys = [revokeKey("revoked"), revokeKey("not_revoked"), revokeKey("unreachable")]
    expect(new Set(keys).size).toBe(3)
    expect(revokeKey("skipped")).toBeUndefined()
    expect(revokeKey(null)).toBeUndefined()
  })

  test("адрес документации показан ТЕКСТОМ — компонент браузер не открывает (S-T12)", () => {
    expect(connectSource).not.toMatch(/\bopen\(|xdg-open|shell\.open/)
    const docsBlock = connectSource.slice(
      connectSource.indexOf('Show when={method()?.field?.docs_url}'),
      connectSource.indexOf('Show when={length()}'),
    )
    expect(docsBlock).toContain("<text")
    expect(docsBlock).not.toContain("<a ")
    expect(docsBlock).not.toContain("href")
  })

  test("введённое значение не попадает в лог TUI — рядом с console./log( в компоненте не встречается token()", () => {
    const suspicious = connectSource.match(/console\.[a-z]+\([^)]*\)/g) ?? []
    for (const call of suspicious) expect(call).not.toContain("token(")
  })
})

describe("TUI dialog-connectors — закрытая native-карточка: строка «Подключить» присутствует, не выбирается (S-V28; AC-344)", () => {
  test("connectDisabled — истинно ровно при connect_mode_unavailable_code === \"oauth_disabled\"", () => {
    expect(connectDisabled({ connect_mode_unavailable_code: "oauth_disabled" })).toBe(true)
    expect(connectDisabled({ connect_mode_unavailable_code: "facade_needs_hub" })).toBe(false)
    expect(connectDisabled({ connect_mode_unavailable_code: undefined })).toBe(false)
    expect(connectDisabled(undefined)).toBe(false)
  })

  test("connectDirect — истинно ровно при connect_mode === \"direct\" (тот же признак, что в Desktop)", () => {
    expect(connectDirect({ connect_mode: "direct" })).toBe(true)
    expect(connectDirect({ connect_mode: "native" })).toBe(false)
    expect(connectDirect(undefined)).toBe(false)
  })

  test("нажатие enter на закрытом действии ничего не делает — вызов select()/run() под disabled-проверкой", () => {
    // Строка меню действия «Подключить» ставит `disabled` ИМЕННО из connectDisabled — тот же
    // предикат, что рисует причину; действие не исчезает из списка (условие на отдельной строке
    // выше, а не завёрнуто в Show/filter, которые убрали бы саму строку).
    const menuAction = connectorsSource.slice(
      connectorsSource.indexOf("onTrigger: () => (connectDirect(card())"),
      connectorsSource.indexOf("onTrigger: () => (connectDirect(card())") + 400,
    )
    expect(connectorsSource).toContain("disabled: () => !allows(card(), \"connect\") || connectDisabled(card())")
    expect(menuAction).toContain("connectDirect(card())")
  })
})

describe("TUI словарь — тексты ревизии 1.13 без подстроки «Hub» (S-I4, D-43; AC-336)", () => {
  test("ключи блока подключения присутствуют и не содержат «Hub» ни в ru, ни в en", () => {
    const keys = Object.keys(tuiDict.ru).filter((key) => key.startsWith("connect."))
    expect(keys.length).toBeGreaterThan(10)
    for (const key of keys) {
      expect(tuiDict.ru[key as keyof typeof tuiDict.ru], `ru.${key}`).toBeTruthy()
      expect(tuiDict.en[key as keyof typeof tuiDict.en], `en.${key}`).toBeTruthy()
      expect(String(tuiDict.ru[key as keyof typeof tuiDict.ru]).toLowerCase()).not.toContain("hub")
      expect(String(tuiDict.en[key as keyof typeof tuiDict.en]).toLowerCase()).not.toContain("hub")
    }
  })
})
