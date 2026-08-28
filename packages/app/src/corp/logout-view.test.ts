import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { logoutReasonKey } from "../context/corp"
import { dict as en } from "../i18n/en"
import { dict as ru } from "../i18n/ru"

/**
 * Выход из UI и возврат выключенного провайдера — Desktop/web (S-A16, S-C11, S-D6; AC-287…AC-290,
 * AC-292…AC-295, AC-298, AC-299).
 *
 * Экран не рендерится: разметка и обработчики — те же исходники, что и у витрины (`viewFunction`-
 * приём из `connectors-view.test.ts`), а функции onSuccess мутаций (`context/corp.ts`) исполняются
 * как есть на подменённых `language`/`showToast`, без сети и без солид-рендера.
 */

const APP = path.resolve(import.meta.dirname, "..")
const source = fs.readFileSync(path.join(APP, "components/corp/dialog-connectors.tsx"), "utf8")
const connectorPageSource = fs.readFileSync(path.join(APP, "components/corp/dialog-connector.tsx"), "utf8")
const contextSource = fs.readFileSync(path.join(APP, "context/corp.ts"), "utf8")

/**
 * Единственность вхождения маркера в тексте (review-i4-rev112-3, риск при H-1): `indexOf` берёт
 * ПЕРВОЕ совпадение молча. Сегодня каждый маркер этого файла встречается в исходнике ровно один
 * раз — но появление второго компонента с тем же именем мемо/атрибута увело бы извлечение не туда
 * без единого красного теста. Проверка ловит это раньше, чем извлечение начнёт врать.
 */
function assertSingleOccurrence(text: string, marker: string, at: number) {
  const second = text.indexOf(marker, at + 1)
  expect(second, `маркер «${marker}» встречается более одного раза — indexOf возьмёт не то вхождение`).toBe(-1)
}

/** Содержимое JSX-атрибута/блока, ограниченное балансом фигурных скобок от первой `{` после marker. */
function blockAfter(text: string, marker: string) {
  const at = text.indexOf(marker)
  expect(at, `не найдено ${marker}`).toBeGreaterThan(-1)
  assertSingleOccurrence(text, marker, at)
  const open = text.indexOf("{", at + marker.length - 1)
  let depth = 0
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth += 1
    else if (text[index] === "}") {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, index)
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

/**
 * Тело async-функции `onSuccess: async (result) => { … }` — исполняется как есть.
 *
 * `marker` уже оканчивается открывающей скобкой самой функции — её и берём точкой отсчёта глубины
 * (а не следующую `{` после неё, иначе счёт начнётся с первого вложенного блока и тело обрежется
 * по его первой закрывающей скобке, потеряв всё, что идёт следом).
 */
function onSuccessBody(marker: string, from = 0) {
  const at = contextSource.indexOf(marker, from)
  expect(at, `не найдено ${marker}`).toBeGreaterThan(-1)
  const open = at + marker.length - 1
  expect(contextSource[open], `${marker} не оканчивается открывающей скобкой`).toBe("{")
  let depth = 0
  for (let index = open; index < contextSource.length; index++) {
    if (contextSource[index] === "{") depth += 1
    else if (contextSource[index] === "}") {
      depth -= 1
      if (depth === 0) return contextSource.slice(open + 1, index)
    }
  }
  throw new Error(`тело ${marker} не закрыто`)
}

describe("витрина — заголовок: «Войти»/«Выйти» и постоянные элементы (S-A16, S-D6; AC-287)", () => {
  const action = blockAfter(source, "action={")

  test("AC-287: одна позиция с двумя взаимоисключающими состояниями — не показаны обе разом", () => {
    expect(action).toContain("when={signedIn()}")
    expect(action).toContain('{language.t("corp.logout.action")}')
    expect(action).toContain('{language.t("corp.connectors.login")}')
    // «Войти» — только внутри fallback-ветки того же <Show>, а не отдельного условия рядом.
    const fallback = action.slice(action.indexOf("fallback="), action.indexOf('{language.t("corp.logout.action")}'))
    expect(fallback).toContain('{language.t("corp.connectors.login")}')
  })

  /**
   * H-1 (review-i4-rev112-3): проверка выше подтверждает, ГДЕ в разметке стоит «Войти» (внутри
   * fallback-ветки того же <Show>), но не ЧЕМ эта ветка гейтится. Инъекция И-6 меняет
   * `fallback={<Show when={signedOut()}>` на `when={!signedIn()}` — обе кнопки остаются на своих
   * местах в разметке, тест выше её не замечает, `describe` ниже (мемо `authenticated`/`signedIn`/
   * `signedOut`, исполненные из исходника) её тоже не видит: он проверяет только вычисление самих
   * мемо, а не то, какое из них читает разметка. `signedOut` при этом остаётся объявленным, но
   * неиспользуемым — `noUnusedLocals` в пакете выключен, поэтому и typecheck молчит. Здесь —
   * граница между мемо и разметкой: `when=` внутри `<Show>` внутри `fallback=` обязан быть
   * буквально `signedOut()`, а не логически эквивалентным на вид выражением.
   */
  test("H-1: fallback-ветка «Войти» гейтится буквально signedOut(), а не производным !signedIn()", () => {
    const match = action.match(/fallback=\{\s*<Show when=\{([^}]*)\}>/)
    expect(match, "не найден <Show when={...}> внутри fallback").not.toBeNull()
    expect(match![1]).toBe("signedOut()")
  })

  test("AC-287: подпись пользователя и «Обновить» не зависят от состояния входа", () => {
    expect(action).toContain("<Show when={user()}>")
    expect(action).toContain('icon="reset"')
    // Иконка обновления и подпись пользователя стоят вне <Show when={signedIn()}>…</Show> — их
    // порядок в разметке подтверждён отдельно ниже.
    const signedInBlock = blockAfter(action, "when={signedIn()}")
    expect(signedInBlock).not.toContain('icon="reset"')
    expect(signedInBlock).not.toContain("<Show when={user()}>")
  })
})

/**
 * G-1 (review-i4-rev112-2): АС-287 в разметке (описанный тестом выше) не проверяет, ОТКУДА берётся
 * признак «Войти»/«Выйти» — он переживает и возврат дефекта F-1 (признак снова считается по
 * `hub_error` каталога), и схлопывание третьего значения признака. Errata dd09ac9cb6 завела ради
 * этого четыре прогона AC-287 и S-Q9 п.(р) («признак берётся из `authenticated` и ни из чего
 * другого») — здесь оба исполнены на выражениях `authenticated`/`signedIn`/`signedOut`, взятых
 * ИЗ ИСХОДНИКА витрины, а не пересказанных в тесте (тот же приём, что `onSuccessBody` выше и
 * `viewFunction` в connectors-view.test.ts).
 */
describe("AC-287, S-Q9 п.(р): признак «Войти»/«Выйти» берётся из authenticated, а не из hub_error каталога", () => {
  /**
   * Выражение внутри `createMemo(...)`, ограниченное балансом круглых скобок от `(` сразу после
   * marker — символ в символ то, что стоит в источнике сейчас. Если признак поменяют (например,
   * вернут чтение `catalog.data?.hub_error`), извлечётся уже другое выражение, и тест исполнит
   * именно его.
   */
  function memoBody(marker: string) {
    const at = source.indexOf(marker)
    expect(at, `не найдено ${marker}`).toBeGreaterThan(-1)
    assertSingleOccurrence(source, marker, at)
    const open = at + marker.length - 1
    expect(source[open], `${marker} не оканчивается «(»`).toBe("(")
    let depth = 0
    for (let index = open; index < source.length; index++) {
      if (source[index] === "(") depth += 1
      else if (source[index] === ")") {
        depth -= 1
        if (depth === 0) return source.slice(open + 1, index)
      }
    }
    throw new Error(`скобка после ${marker} не закрыта`)
  }

  /**
   * `authenticated`/`signedIn`/`signedOut` исполняются как настоящие функции на подставных
   * `status`/`catalog`. `catalog` передаётся НАРЯДУ со `status`, хотя правильное выражение его не
   * читает вовсе, — чтобы и текущий код, и инъекция И-4 (возврат к `catalog.data?.hub_error`)
   * исполнялись без ReferenceError, а не падали на извлечении раньше, чем на проверке значения.
   */
  function computeButtons(statusData: Record<string, unknown> | undefined, catalogData: Record<string, unknown> | undefined) {
    const fn = new Function(
      "status",
      "catalog",
      `
      const authenticated = ${memoBody("const authenticated = createMemo(")}
      const signedIn = ${memoBody("const signedIn = createMemo(")}
      const signedOut = ${memoBody("const signedOut = createMemo(")}
      return { authenticated: authenticated(), signedIn: signedIn(), signedOut: signedOut() }
      `,
    ) as (status: unknown, catalog: unknown) => { authenticated: unknown; signedIn: boolean; signedOut: boolean }
    return fn({ data: statusData }, { data: catalogData })
  }

  /** Какая из двух кнопок окажется в ряду — по факту `signedIn`/`signedOut`, а не по разметке. */
  function visibleButton(
    statusData: Record<string, unknown> | undefined,
    catalogData: Record<string, unknown> | undefined = {},
  ) {
    const { signedIn, signedOut } = computeButtons(statusData, catalogData)
    expect(signedIn && signedOut, "«Войти» и «Выйти» одновременно").toBeFalsy()
    if (signedIn) return "logout"
    if (signedOut) return "login"
    return "none"
  }

  test("AC-287, прогон 1: authenticated:true → «Выйти», «Войти» нет", () => {
    expect(visibleButton({ enabled: true, authenticated: true }, {})).toBe("logout")
  })

  test("AC-287, прогон 2: authenticated:false при hub_error каталога ПУСТОМ (статический каталог либо недоступный Hub) → «Войти» — признак берётся из authenticated и ни из чего другого", () => {
    expect(visibleButton({ enabled: true, authenticated: false }, {})).toBe("login")
  })

  test('AC-287, прогон 3: authenticated:true при hub_error каталога "unauthorized" → «Выйти», а не «Войти»', () => {
    expect(visibleButton({ enabled: true, authenticated: true }, { hub_error: "unauthorized" })).toBe("logout")
  })

  test("AC-287, прогон 4: статус ещё не получен (третье значение признака) → ни одной из двух кнопок", () => {
    expect(visibleButton(undefined, {})).toBe("none")
  })
})

describe("витрина — подтверждение выхода (S-A16; AC-288)", () => {
  const dialogBlock = source.slice(source.indexOf("const DialogCorpLogout:"), source.indexOf("const DialogProviderEnable:"))

  test("AC-288: текст называет обе части (или только локальную часть без Hub)", () => {
    expect(dialogBlock).toContain('{language.t(props.hubConfigured ? "corp.logout.confirm" : "corp.logout.confirmLocal")}')
  })

  test("AC-288: отмена не зовёт мутацию, подтверждение зовёт её ровно один раз", () => {
    const cancel = dialogBlock.slice(dialogBlock.indexOf("common.cancel") - 200, dialogBlock.indexOf("common.cancel"))
    expect(cancel).toContain("onClick={() => dialog.close()}")
    expect(cancel).not.toContain("logout.mutate")
    const mutateCalls = [...dialogBlock.matchAll(/logout\.mutate\(\)/g)]
    expect(mutateCalls).toHaveLength(1)
  })
})

describe("useCorpLogout — три различимых исхода (S-A16, D-49; AC-289)", () => {
  const body = onSuccessBody("onSuccess: async (result) => {")

  /**
   * `language.t` — заглушка, но `logoutReasonKey` — НЕ заглушка (F-3, review-i4-rev112-1): это
   * настоящая функция из `context/corp.ts`, импортированная выше. `t` без подстановок отдаёт сам
   * ключ, с подстановками — ключ и JSON аргументов; итоговый `title` поэтому раскрывает, каким
   * ИМЕННО ключом словаря (`corp.logout.notRevoked` vs `corp.logout.revokeFailed`) и какой ИМЕННО
   * причиной (результат настоящей `logoutReasonKey`) собран текст — а не только его финальную
   * строку. Слияние двух исходов в одну ветку словаря меняет префикс ключа и ловится независимо от
   * того, совпадёт ли после этого подставленная причина (см. F-2).
   */
  function run(result: Record<string, unknown> | undefined) {
    const calls: { variant: string; title: string }[] = []
    const showToast = (options: { variant: string; title: string }) => calls.push(options)
    const language = {
      t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    }
    let invalidated = false
    const invalidate = async () => {
      invalidated = true
    }
    const fn = new Function(
      "showToast",
      "language",
      "logoutReasonKey",
      "invalidate",
      "result",
      `return (async () => { ${body} })()`,
    ) as (...args: unknown[]) => Promise<void>
    return { run: () => fn(showToast, language, logoutReasonKey, invalidate, result), calls, invalidated: () => invalidated }
  }

  test("AC-289: успех целиком — variant success, доменный ключ corp.logout.done", async () => {
    const { run: runSuccess, calls: successCalls } = run({ key_removed: true, hub: "revoked" })
    await runSuccess()
    expect(successCalls).toHaveLength(1)
    expect(successCalls[0]!.variant).toBe("success")
    expect(successCalls[0]!.title).toBe("corp.logout.done")
  })

  test("AC-289, F-2: not_revoked и unavailable — РАЗНЫЕ ключи словаря, не только разный финальный текст", async () => {
    // Ключевая проверка F-2: сравнивается не итоговая строка (она разная и после ошибочного
    // слияния веток, потому что различается подставленная причина — см. заголовок файла), а
    // конкретный ключ шаблона тоста, реально использованный кодом.
    const { run: runNotRevoked, calls: notRevokedCalls } = run({
      key_removed: true,
      hub: "not_revoked",
      revoke_error: "not_permitted",
    })
    await runNotRevoked()
    expect(notRevokedCalls[0]!.variant).not.toBe("error")
    expect(notRevokedCalls[0]!.variant).not.toBe("success")
    // notRevoked обязан идти через ключ corp.logout.notRevoked с причиной из logoutReasonKey.
    expect(notRevokedCalls[0]!.title).toBe(`corp.logout.notRevoked {"reason":"corp.logout.reason.notPermitted"}`)

    const { run: runUnavailable, calls: unavailableCalls } = run({ key_removed: true, hub: "unavailable" })
    await runUnavailable()
    expect(unavailableCalls[0]!.variant).not.toBe("error")
    expect(unavailableCalls[0]!.variant).not.toBe("success")
    // unavailable обязан идти через ДРУГОЙ ключ — corp.logout.revokeFailed, с фиксированной
    // причиной «unreachable», а не с причиной, выведенной из revoke_error (её у unavailable нет).
    expect(unavailableCalls[0]!.title).toBe(`corp.logout.revokeFailed {"reason":"corp.logout.reason.unreachable"}`)

    // Дополнительно: ключи-шаблоны (префикс до пробела) различны — это и есть «не слито».
    const templateKeyOf = (title: string) => title.split(" ")[0]
    expect(templateKeyOf(notRevokedCalls[0]!.title)).not.toBe(templateKeyOf(unavailableCalls[0]!.title))
  })

  test("AC-289, S-A5: message от Hub не попадает в текст тоста ни у одного исхода", async () => {
    const LEAK = "СЕКРЕТНАЯ ФРАЗА ОТ HUB"
    for (const result of [
      { key_removed: true, hub: "revoked", message: LEAK },
      { key_removed: true, hub: "not_revoked", revoke_error: "not_permitted", message: LEAK },
      { key_removed: true, hub: "unavailable", message: LEAK },
    ]) {
      const { run: runCase, calls } = run(result)
      await runCase()
      expect(calls[0]!.title, JSON.stringify(result)).not.toContain(LEAK)
    }
  })

  test("AC-289: инвалидация выполняется во всех трёх случаях — экран обновляется после действия", async () => {
    for (const result of [
      { key_removed: true, hub: "revoked" },
      { key_removed: true, hub: "not_revoked", revoke_error: "not_permitted" },
      { key_removed: true, hub: "unavailable" },
    ]) {
      const { run: runCase, invalidated } = run(result)
      await runCase()
      expect(invalidated(), JSON.stringify(result)).toBe(true)
    }
  })
})

describe("logoutReasonKey — закрытый набор причин отказа отзыва (S-A14 п.1, S-I1; AC-300)", () => {
  test("AC-300: три известных кода дают три различимых ключа словаря", () => {
    expect(logoutReasonKey("not_permitted")).toBe("corp.logout.reason.notPermitted")
    expect(logoutReasonKey("upstream_unavailable")).toBe("corp.logout.reason.upstreamUnavailable")
    expect(logoutReasonKey("invalid_response")).toBe("corp.logout.reason.invalidResponse")
    const keys = new Set([
      logoutReasonKey("not_permitted"),
      logoutReasonKey("upstream_unavailable"),
      logoutReasonKey("invalid_response"),
    ])
    expect(keys.size).toBe(3)
  })

  test("AC-300: неизвестный код и отсутствие кода — тот же ключ, что invalidResponse, а не код машины", () => {
    for (const code of ["unheard_of_code", undefined, "", "not_permitted_typo"]) {
      const key = logoutReasonKey(code)
      expect(key, String(code)).toBe("corp.logout.reason.invalidResponse")
      // Неизвестный код никогда не попадает в результат как есть (S-I1).
      if (code) expect(key).not.toContain(code)
    }
  })
})

describe("сборка без Hub — тексты выхода не называют Hub (S-I1, D-43; AC-290)", () => {
  /**
   * Три ключа, достижимые в сборке без Hub: подтверждение (`hubConfigured=false`) и исход
   * `hub:"skipped"` при удалённом (`doneLocal`) или отсутствовавшем (`notSignedIn`) ключе. Исходы
   * `not_revoked`/`unavailable` в этой сборке недостижимы вовсе (S-A14 п.6 — шага 1 не существует),
   * поэтому их текстов в матрице здесь нет: им нечего показывать про сервер, которого не было.
   */
  const NO_HUB_KEYS = ["corp.logout.confirmLocal", "corp.logout.doneLocal", "corp.logout.notSignedIn"] as const

  test("AC-290: ни один из трёх текстов не содержит подстроки «Hub»", () => {
    for (const key of NO_HUB_KEYS) {
      expect(en[key], key).toBeString()
      expect(ru[key], key).toBeString()
      expect(/hub/i.test(String(en[key])), `en.${key}`).toBe(false)
      expect(/hub/i.test(String(ru[key])), `ru.${key}`).toBe(false)
    }
  })

  test("AC-290: те же ветви в сборке с Hub называют обе части — тексты различны от Local-пары", () => {
    expect(en["corp.logout.confirm"]).not.toBe(en["corp.logout.confirmLocal"])
    expect(en["corp.logout.done"]).not.toBe(en["corp.logout.doneLocal"])
    expect(ru["corp.logout.confirm"]).not.toBe(ru["corp.logout.confirmLocal"])
    expect(ru["corp.logout.done"]).not.toBe(ru["corp.logout.doneLocal"])
  })
})

describe("витрина — предупреждение о выключенном провайдере (S-C11; AC-292, AC-294)", () => {
  const action = blockAfter(source, "action={")
  const warningBlock = blockAfter(action, "when={providerDisabled()}")

  test("AC-292: предупреждение называет провайдера, файл и действие «Включить»; не модальное окно", () => {
    expect(warningBlock).toContain('language.t("corp.provider.disabledTitle", { file: value().file })')
    expect(warningBlock).toContain('language.t("corp.provider.enable")')
    // Обёртка — обычный <div>, а не <Dialog>: работу предупреждение не прерывает.
    expect(warningBlock).toContain('data-slot="corp-provider-warning"')
    expect(warningBlock).not.toContain("<Dialog")
  })

  test("AC-294: предупреждения нет вовсе, когда провайдер не выключен — единственное условие рендера", () => {
    // `<Show when={providerDisabled()}>` без `fallback` — при falsy providerDisabled() блок не
    // рендерится совсем (не пустая строка, не серый текст-заглушка).
    const showTag = action.slice(action.indexOf("when={providerDisabled()}") - 10, action.indexOf("when={providerDisabled()}") + 40)
    expect(showTag).not.toContain("fallback")
  })
})

describe("действие «Включить» — подтверждение и последствия (S-C11 п.4-5; AC-293, AC-294)", () => {
  const dialogBlock = source.slice(source.indexOf("const DialogProviderEnable:"), source.indexOf("export const DialogConnectors:"))

  test("AC-293: подтверждение называет файл, который будет изменён", () => {
    expect(dialogBlock).toContain('language.t("corp.provider.enableConfirm", { file: props.file })')
  })

  test("AC-294: отмена не мутирует конфиг, подтверждение зовёт enable.mutate() ровно один раз", () => {
    const cancel = dialogBlock.slice(dialogBlock.indexOf("common.cancel") - 200, dialogBlock.indexOf("common.cancel"))
    expect(cancel).toContain("onClick={() => dialog.close()}")
    expect(cancel).not.toContain("enable.mutate")
    const mutateCalls = [...dialogBlock.matchAll(/enable\.mutate\(\)/g)]
    expect(mutateCalls).toHaveLength(1)
  })
})

describe("useProviderEnable — чужой слой назван, а не молча пропущен (S-C7, S-C11 п.4; AC-295)", () => {
  test("AC-295: reason:\"foreign_layer\" показывает файл, который приложение не правит", () => {
    const body = onSuccessBody("onSuccess: async (result) => {", contextSource.indexOf("export function useProviderEnable"))
    expect(body).toContain('result.reason === "foreign_layer"')
    expect(body).toContain('language.t("corp.provider.enableForeignLayer"')
    expect(body).toContain("result.provider_disabled?.file")
  })

  test("AC-295: приложение не пишет disabled_providers само — ни в исходниках корп-компонентов, ни в контексте", () => {
    const componentsDir = path.join(APP, "components/corp")
    const files = fs.readdirSync(componentsDir).filter((file) => file.endsWith(".tsx"))
    for (const file of files) {
      const text = fs.readFileSync(path.join(componentsDir, file), "utf8")
      expect(text, file).not.toContain("disabled_providers")
    }
    // В context/corp.ts имя массива встречается только в комментарии, поясняющем роут — не в коде.
    const codeLines = contextSource.split("\n").filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    expect(codeLines.some((line) => line.includes("disabled_providers"))).toBe(false)
  })
})

describe("витрина — обновление иконкой, а не словом (D-53, S-D6; AC-298)", () => {
  const action = blockAfter(source, "action={")

  test("AC-298: иконка обновления — доступное имя и подсказка из одного ключа, текстовой кнопки нет", () => {
    expect(action).toContain('aria-label={language.t("corp.connectors.refresh")}')
    expect(action).toContain('title={language.t("corp.connectors.refresh")}')
    expect(action).not.toContain(">Обновить<")
    expect(action).not.toContain(">Refresh<")
  })

  test("AC-298: «Войти», «Выйти» и «Включить» остались текстовыми кнопками", () => {
    expect(source).toContain('{language.t("corp.logout.action")}')
    expect(source).toContain('{language.t("corp.connectors.login")}')
    expect(source).toContain('{language.t("corp.provider.enable")}')
    // Своего SVG корп-компоненты не заводят — иконка берётся из набора приложения (`IconButton`).
    expect(source).not.toContain("<svg")
  })
})

describe("витрина — имя коннектора один раз, alias — в поиске и на странице (S-D6, S-V11; AC-299)", () => {
  test("AC-299: в ячейке «Имя» ровно один текстовый узел — второй строки с alias нет", () => {
    const row = source.slice(source.indexOf('data-slot="corp-connectors-row"'), source.indexOf("</List>"))
    const nameCell = row.slice(0, row.indexOf('<span class="text-12-regular text-text-weak truncate">{connectorType(card)'))
    // Единственный текстовый узел ячейки — {card.title}; {card.alias} в ней не встречается.
    expect(nameCell).toContain("{card.title}")
    expect(nameCell).not.toContain("{card.alias}")
  })

  test("AC-299: alias остаётся полем поиска (matchesQuery) и виден на странице коннектора", () => {
    expect(source).toContain("card.title, card.alias, card.description, card.owner, card.type")
    expect(connectorPageSource).toContain("{props.alias}")
  })
})
