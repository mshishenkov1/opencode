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

/**
 * AC-312 в переформулировке решений заказчика от 31.08 (макет, экран 4).
 *
 * **Первое решение (утро 31.08).** Критерий выбора идёт по числу ДОСТУПНЫХ способов, а не по общему
 * их числу. Прежняя мера закрепляла обратное — «два способа в любом сочетании доступности дают
 * список», то есть у карточки ТЭГ, где OAuth закрыт администратором, над формой висел выбор из
 * одного нажимаемого элемента и одного серого.
 *
 * **Второе решение (31.08, дословно).** «Не упоминай подключение через OAuth сейчас в сборке,
 * конечному пользователю это не нужно, просто сохрани возможность подключения по OAuth в коде, но
 * пока не скажу, что есть приложения, и не пришлю их данные — не включай их». Способ с
 * `available: false` не рисуется НИГДЕ: ни элементом выбора, ни приглушённой строкой под формой, ни
 * названием в строке свойств. Прежняя редакция S-V28 п.4 требовала обратного («недоступный способ
 * не прячется»), и мера сторожила именно показ; теперь она сторожит отсутствие показа.
 *
 * Что НЕ ослаблено. Разбор способов не тронут: `available` считает сервер (S-V28 п.3), поле ввода
 * достаётся только выбранному ИЗ ДОСТУПНЫХ способу, а роут по-прежнему отказывает `409` на попытку
 * подключиться недоступным способом мимо интерфейса (S-V28 п.5) — эти меры стоят там же, где
 * стояли, и ослаблению не подвергались.
 */
describe("dialog-connector — методChoice: четыре случая S-V28 п.4 (AC-312)", () => {
  test("AC-312: доступных нет ни одного → \"none\" (случай 4: формы нет)", () => {
    const methods: AuthMethodView[] = [
      { id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" },
    ]
    expect(methodChoice(methods)).toBe("none")
  })

  test("AC-312: доступен ровно один способ → \"single\" (случаи 1 и 2: выбора нет, сразу форма)", () => {
    const only: AuthMethodView[] = [
      { id: "a", title: "A", type: "user_token", available: true, unavailable_code: null },
    ]
    // Случай 2: рядом лежит недоступный способ. Выбор из одного — не выбор, и пилюль над формой нет
    // (решение заказчика от 31.08); сам недоступный способ при этом никуда не делся — он назван под
    // формой, что проверяется мерой разметки ниже.
    const oneUnavailable: AuthMethodView[] = [
      { id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" },
      { id: "b", title: "B", type: "user_token", available: true, unavailable_code: null },
    ]
    expect(methodChoice(only)).toBe("single")
    expect(methodChoice(oneUnavailable)).toBe("single")
  })

  test("AC-312: доступных больше одного → \"list\" (случай 3: компактный ряд выбора над формой)", () => {
    const bothAvailable: AuthMethodView[] = [
      { id: "a", title: "A", type: "user_token", available: true, unavailable_code: null },
      { id: "b", title: "B", type: "user_token", available: true, unavailable_code: null },
    ]
    const twoOfThree: AuthMethodView[] = [
      { id: "a", title: "A", type: "oauth2", available: false, unavailable_code: "oauth_disabled" },
      { id: "b", title: "B", type: "user_token", available: true, unavailable_code: null },
      { id: "c", title: "C", type: "user_token", available: true, unavailable_code: null },
    ]
    expect(methodChoice(bothAvailable)).toBe("list")
    expect(methodChoice(twoOfThree)).toBe("list")
  })

  test("AC-312: ряд выбора рисуется только в случае \"list\" и только из ДОСТУПНЫХ способов", () => {
    const at = source.indexOf('data-slot="corp-connect-methods"')
    expect(at, "ряд выбора способа не найден").toBeGreaterThan(-1)
    // Охранник ряда — по случаю "list", а не «не single»: при одном доступном способе ряда нет.
    expect(source.lastIndexOf('<Show when={choice() === "list"}>', at)).toBeGreaterThan(-1)
    const row = source.slice(at, source.indexOf("</Show>", at))
    // Перебираются доступные способы, а не все: недоступному в ряду выбора места нет.
    expect(row).toContain("<For each={available()}>")
    expect(row).not.toContain("<For each={methods()}>")
    // И потому `disabled` в ряду не нужен: нерабочих элементов выбора в нём не бывает.
    expect(row).not.toContain("disabled=")
  })

  test("AC-312, S-V28 п.4: недоступный способ не рисуется НИГДЕ — ни блока под формой, ни строк причин", () => {
    // Мера перенацелена решением заказчика от 31.08 (см. заголовок describe). Прежняя редакция
    // требовала блока `corp-connect-methods-unavailable` со строками «способ — причина» ПОД формой;
    // теперь недоступный способ не показывается вовсе, и мера сторожит именно отсутствие.
    expect(source).not.toContain('data-slot="corp-connect-methods-unavailable"')
    expect(source).not.toContain('data-slot="corp-connect-method-reason"')
    expect(source).not.toContain("unavailable().length > 0")
    expect(source).not.toContain("<For each={unavailable()}>")
    // Ни имени способа, ни текста его причины из каталога в файле не остаётся: поля
    // `unavailable_reason` и `unavailable_code` элемента `auth_methods` не читаются ни в одной точке.
    expect(source).not.toContain("unavailable_reason")
    expect(source).not.toContain("methodUnavailableKey")
    // Что НЕ ослаблено: способ по-прежнему выбирается ИЗ ДОСТУПНЫХ, то есть поле ввода недоступному
    // способу не достаётся ни при каком составе карточки — оно рисуется под `Show when={selected()}`.
    // Искать от объявления САМОЙ формы: имя `selected` встречается и у прежнего экрана пресетов выше.
    const formAt = source.indexOf("const ConnectorConnect: Component<")
    expect(formAt, "компонент формы подключения не найден").toBeGreaterThan(-1)
    const selectedAt = source.indexOf("const selected = createMemo(", formAt)
    expect(selectedAt, "выбранный способ не найден").toBeGreaterThan(-1)
    const selected = source.slice(selectedAt, source.indexOf("\n  })", selectedAt))
    expect(selected).toContain("available().find(")
    expect(selected).toContain("available()[0]")
    expect(selected).not.toContain("methods()[")
  })

  test("AC-312: строка свойств «Способ подключения» называет только ДОСТУПНЫЙ способ", () => {
    // Та же граница, что у формы: закрытый способ не показывается и здесь. Прежний откат на первый
    // объявленный способ печатал в свойствах имя закрытого OAuth — «нигде» решения заказчика
    // включает и строку свойств.
    const at = source.indexOf("export function connectionMethodTitle(")
    expect(at, "connectionMethodTitle не найдена").toBeGreaterThan(-1)
    const body = source.slice(at, source.indexOf("\n}", at))
    expect(body).toContain("methods.find((method) => method.available)?.title")
    expect(body).not.toContain("methods[0]")
  })

  test("AC-312: шапка формы называет способ, когда выбирать не из чего (макет, экран 4)", () => {
    const at = source.indexOf('data-slot="corp-connect-head"')
    expect(at, "шапка формы не найдена").toBeGreaterThan(-1)
    const head = source.slice(at, source.indexOf("</div>", at))
    // Заголовок — «Подключение <имя>»: имя коннектора подставляется, а не приписывается словарём.
    expect(head).toContain('language.t("corp.connect.title", { title: entry().title })')
    // Подзаголовок — название способа, и только в случае "single": при выборе его несут пилюли.
    expect(head).toContain('choice() === "single" ? selected() : undefined')
    expect(head).toContain("{method().title}")
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
    // Ключ у oauth_disabled перенацелен решением заказчика от 31.08: причина рядом с кнопкой ОБЩАЯ и
    // способа не называет. Что мера держала и держит — что это РАЗНЫЕ ключи с разной отрисовкой:
    // слияние с facade_needs_hub по-прежнему запрещено (S-V28 п.4).
    expect(oauth).toBe("corp.connectors.connectMethodNotConfigured")
    expect(facade).toBe("corp.connectors.facadeNeedsHub")
    expect(oauth).not.toBe(facade)
  })

  test("AC-341: тексты обеих причин не называют OAuth ни в одном словаре (решение заказчика 31.08)", () => {
    const keys = [
      connectUnavailableKey({ connect_mode_unavailable_code: "oauth_disabled" })!,
      connectUnavailableKey({ connect_mode_unavailable_code: "facade_needs_hub" })!,
      connectUnavailableKey({ connect_mode_unavailable_code: "no_method" })!,
    ]
    for (const [locale, dict] of Object.entries({ en: en as Record<string, string>, ru: ru as Record<string, string> }))
      for (const key of keys) {
        expect(dict[key], `${locale}.${key}`).toBeString()
        expect(dict[key]!.toLowerCase(), `${locale}.${key} = ${dict[key]}`).not.toContain("oauth")
      }
  })

  test("AC-341: connect_mode_unavailable_code отсутствует (null) — причины нет, действие работает", () => {
    expect(connectUnavailableKey({ connect_mode_unavailable_code: null })).toBeUndefined()
  })
})

describe("dialog-connector — разметка: oauth_disabled рисует действие НЕАКТИВНЫМ, facade_needs_hub убирает его (AC-341)", () => {
  /**
   * Ряд действий страницы коннектора. Ревизия 1.14 (макет заказчика от 30.08) переставила блоки и
   * увела действия из блока «Статус» в шапку страницы: «рядом с действием» теперь значит «в ряду
   * действий шапки». Срез берётся по контейнеру ряда, а не по номеру блока в комментарии, — номера
   * блоков заказчик уже менял дважды, и мера, привязанная к ним, ломается от перестановки, ничего
   * из охраняемого не нарушив.
   */
  const statusBlock = (() => {
    const at = source.indexOf('data-slot="corp-connector-actions"')
    expect(at, "ряд действий страницы коннектора не найден").toBeGreaterThan(-1)
    const start = source.lastIndexOf("<Show", at)
    // Конец ряда — закрытие охраняющего его `<Show when={hasActions(...)}>`.
    const end = source.indexOf("</Show>\n              </div>", at)
    expect(end, "ряд действий не закрыт").toBeGreaterThan(at)
    return source.slice(start, end)
  })()

  test("AC-341: кнопка «Подключить» отрисована с disabled по connect_mode_unavailable_code === \"oauth_disabled\"", () => {
    expect(statusBlock).toContain('data-action="corp-connect"')
    // Утверждение привязано к самому атрибуту `disabled=`, а не к произвольному месту в срезе:
    // та же подстрока встречается ещё раз ниже, в условии `<Show>` причины недоступности — там она
    // ничего не доказывает про активность кнопки. Приём — как в TUI-близнеце AC-344
    // (dialog-connectors.test.ts), который проверяет `disabled: () => …` дословно у самой строки
    // меню, а не где-то в срезе исходника.
    const buttonAt = statusBlock.indexOf('data-action="corp-connect"')
    expect(buttonAt).toBeGreaterThan(-1)
    const disabledAt = statusBlock.indexOf("disabled={", buttonAt)
    expect(disabledAt, "у кнопки corp-connect нет атрибута disabled=").toBeGreaterThan(-1)
    let depth = 0
    let end = -1
    for (let index = disabledAt + "disabled=".length; index < statusBlock.length; index++) {
      if (statusBlock[index] === "{") depth += 1
      else if (statusBlock[index] === "}") {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    expect(end, "атрибут disabled= не закрыт").toBeGreaterThan(-1)
    const disabledValue = statusBlock.slice(disabledAt, end + 1)
    expect(disabledValue).toContain('entry().connect_mode_unavailable_code === "oauth_disabled"')

    // Кнопка — ВНУТРИ общего условия по actions.includes("connect"/"reconnect"), а не спрятана за
    // отдельной проверкой oauth_disabled: у native-карточки "connect" остаётся в actions (S-V16
    // не тронут), поэтому кнопка присутствует и лишь неактивна — не исчезает.
    const connectShow = statusBlock.indexOf('entry().actions.includes("connect") || entry().actions.includes("reconnect")')
    expect(connectShow).toBeGreaterThan(-1)
    expect(buttonAt).toBeGreaterThan(connectShow)
  })

  test("AC-341: причина отрисована РЯДОМ (в том же блоке), а не в другой части экрана", () => {
    expect(statusBlock).toContain('data-slot="corp-connect-disabled-reason"')
    // Ключ перенацелен решением заказчика от 31.08: общий текст вместо названия закрытого способа.
    // Место отрисовки — то же самое, и его мера сторожит по-прежнему.
    expect(statusBlock).toContain("corp.connectors.connectMethodNotConfigured")
    expect(statusBlock).not.toContain("methodUnavailable.oauthDisabled")
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

/**
 * Паритет с TUI (S-V28 п.3, S-T12; AC-313): доступность способа и `connect_mode` считает один общий
 * модуль `packages/opencode/src/corp/status.ts`, и Desktop его не пересчитывает — расхождение
 * оболочек по вопросу «можно ли этим подключиться» исключается по построению. Строка
 * `packages/tui/src/corp/connect-token.test.ts` держит то же утверждение для TUI на своих функциях
 * (`connectDisabled`, `connectDirect`); сетевой гейт (AC-311, AC-343) проверен на уровне роута в
 * `packages/opencode/src/corp/connect-token.test.ts`, общего для обеих оболочек.
 */
describe("dialog-connector — доступность способа не пересчитывается на клиенте (S-V28 п.3; AC-313)", () => {
  test("исходник не импортирует corp/status.ts и не вызывает oauthDisabled() — поле available берётся из карточки", () => {
    expect(source).not.toMatch(/from\s+["']@?.*corp\/status["']/)
    expect(source).not.toContain("oauthDisabled(")
    // Решением заказчика от 31.08 из отрисовки ушёл ключ словаря `methodUnavailable.oauthDisabled`:
    // текстов со словом «OAuth» файл не показывает ни одного. Мера усилена, а не ослаблена — прежде
    // одно такое упоминание допускалось, теперь не допускается ни одного.
    //
    // Сам КОД ПРИЧИНЫ `"oauth_disabled"` остаётся: это значение поля контракта
    // `connect_mode_unavailable_code` (S-V28 п.2, D-62), по нему идёт ветвление, и пользователю оно
    // не показывается. Поэтому мера перечисляет допустимые вхождения поимённо, а не запрещает
    // подстроку целиком.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    for (const hit of code.match(/[A-Za-z_.]*[Oo][Aa]uth[A-Za-z_.]*/g) ?? [])
      expect(hit, "неожиданное упоминание OAuth в отрисовке").toBe("oauth_disabled")
  })
})
