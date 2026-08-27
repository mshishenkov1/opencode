import { describe, expect, test } from "bun:test"
import path from "path"
import { revokeReasonText } from "./i18n"

/**
 * Паритет TUI по выходу и возврату провайдера (S-T11; AC-296).
 *
 * «Оба экрана берут результат из ОДНОГО роута POST /corp/logout и сами ничего не вычисляют»: здесь
 * проверяется именно это — те же тексты и та же классификация исхода (предупреждение, а не ошибка),
 * что у Desktop, и отсутствие отдельной горячей клавиши у действия, которое необратимо в один шаг.
 * Экран не рендерится: функции берутся из исходников диалогов и исполняются как есть — тот же приём,
 * что в `dialog-actions.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "../app.tsx")
const appSource = await Bun.file(APP).text()
const DIALOG = path.resolve(import.meta.dirname, "../component/corp/dialog-corp-logout.tsx")
const dialogSource = await Bun.file(DIALOG).text()
const CONNECTORS = path.resolve(import.meta.dirname, "../component/corp/dialog-connectors.tsx")
const connectorsSource = await Bun.file(CONNECTORS).text()
const KEYBIND = path.resolve(import.meta.dirname, "../config/keybind.ts")
const keybindSource = await Bun.file(KEYBIND).text()

/** Блок объявления команды `name: "corp.logout"` в массиве `appCommands` (`app.tsx`). */
function commandBlock() {
  const at = appSource.indexOf('name: "corp.logout"')
  expect(at, "команда corp.logout не найдена в app.tsx").toBeGreaterThan(-1)
  // Границы объекта команды — от предыдущей `{` до следующей `},` на том же уровне вложенности.
  const open = appSource.lastIndexOf("{", at)
  let depth = 0
  for (let index = open; index < appSource.length; index++) {
    if (appSource[index] === "{") depth += 1
    else if (appSource[index] === "}") {
      depth -= 1
      if (depth === 0) return appSource.slice(open, index + 1)
    }
  }
  throw new Error("объект команды corp.logout не закрыт")
}

describe("TUI — команда corp.logout (S-T11, S-T2; AC-296)", () => {
  test("AC-296: команда зарегистрирована со слэшем logout, отдельной горячей клавиши нет", () => {
    const block = commandBlock()
    expect(block).toContain('slashName: "logout"')
    expect(block).not.toContain("keybind")
    // Ускоритель мог бы прийти и списком общих привязок (`appBindingCommands`) — там его тоже нет.
    const bindings = appSource.slice(
      appSource.indexOf("const appBindingCommands"),
      appSource.indexOf("]", appSource.indexOf("const appBindingCommands")) + 1,
    )
    expect(bindings).not.toContain('"corp.logout"')
    // Вход командой рядом — он свою горячую клавишу как раз получает: разница не случайна.
    expect(bindings).toContain('"corp.login"')
  })

  test("AC-296: команда открывает DialogCorpLogout тем же способом, что вход — DialogCorpLogin", () => {
    const block = commandBlock()
    expect(block).toContain("dialog.replace(() => <DialogCorpLogout")
  })

  /**
   * F-8 (review-i4-rev112-1), errata 2026-08-27 по той же находке. Прежняя проверка «отдельной
   * клавиши нет» (а) смотрела в `app.tsx` (`appCommands`/`appBindingCommands`) вместо
   * `config/keybind.ts`, где живёт настоящая привязка, и (б) буквально читала старую редакцию
   * S-T11 («отдельной клавиши-ускорителя выход не получает» = клавиши нет вовсе) — она провалилась
   * бы на ВЕРНОЙ реализации, потому что `dialog.corp.logout` существует (клавиша `l`, та же позиция,
   * что у входа). Действующая редакция требует другого: «своей, ВТОРОЙ клавиши выход не получает» —
   * именно это проверяется ниже, в правильном файле.
   */
  test("AC-296, S-T11: в keybind.ts у «Выйти» та же клавиша и позиция, что у «Войти» — не второй ускоритель", () => {
    // Ровно одна запись `dialog.corp.logout` в реестре привязок — второго, отдельного ускорителя
    // для выхода нет нигде в файле.
    const logoutEntries = [...keybindSource.matchAll(/"dialog\.corp\.logout":\s*keybind\(([^)]*)\)/g)]
    expect(logoutEntries).toHaveLength(1)
    const loginEntries = [...keybindSource.matchAll(/"dialog\.corp\.login":\s*keybind\(([^)]*)\)/g)]
    expect(loginEntries).toHaveLength(1)

    // Аргумент клавиши — первая строка вызова `keybind("l", …)`: у выхода и входа она совпадает
    // (S-A16: одна позиция с двумя взаимоисключающими состояниями), второй, отдельной клавиши для
    // выхода нет.
    const keyArgOf = (args: string) => args.split(",")[0]!.trim()
    expect(keyArgOf(logoutEntries[0]![1]!)).toBe(keyArgOf(loginEntries[0]![1]!))
  })

  test("AC-296, S-T11: клавиша e у «Включить» названа, и других dialog.corp.* привязок, не названных правилом, нет", () => {
    // Возврат провайдера получает ускоритель e (S-T11, узаконено errata по находке F-9) — действие
    // диалога в TUI без имени команды не существует.
    const enableEntries = [...keybindSource.matchAll(/"dialog\.corp\.provider_enable":\s*keybind\(([^)]*)\)/g)]
    expect(enableEntries).toHaveLength(1)
    const keyArgOf = (args: string) => args.split(",")[0]!.trim()
    expect(keyArgOf(enableEntries[0]![1]!)).toBe('"e"')

    // Требование полноты перечня (S-T11, errata): каждая привязка dialog.corp.* названа правилом —
    // S-T6 (enter/d/p/o/r), S-T10 (x/f/c), S-A16+S-T11 (l на «Войти»/«Выйти»), S-T11 (e на «Включить»).
    // Новая, не названная правилом привязка dialog.corp.* — дефект, а не мелочь.
    const NAMED_DIALOG_CORP_BINDINGS = [
      "dialog.corp.connect",
      "dialog.corp.disconnect",
      "dialog.corp.forget",
      "dialog.corp.permissions",
      "dialog.corp.open_hub",
      "dialog.corp.filter",
      "dialog.corp.refresh",
      "dialog.corp.provider_enable",
      "dialog.corp.login",
      "dialog.corp.logout",
    ].sort()
    const actualBindings = [...keybindSource.matchAll(/"(dialog\.corp\.[a-z_]+)":\s*keybind\(/g)]
      .map((match) => match[1]!)
      .sort()
    expect(actualBindings).toEqual(NAMED_DIALOG_CORP_BINDINGS)
  })
})

describe("TUI — подтверждение и вызов роута выхода (S-A16, S-T11; AC-296)", () => {
  test("AC-296: подтверждение называет обе части (или только локальную — без Hub), роут вызывается один раз", () => {
    expect(dialogSource).toContain('title={hub() === false ? t("logout.confirmLocal") : t("logout.confirm")}')
    // Ровно один вызов `sdk.client.corp.logout()` во всём диалоге — не по одному на исход.
    const calls = [...dialogSource.matchAll(/sdk\.client\.corp\.logout\(\)/g)]
    expect(calls).toHaveLength(1)
    // Отмена не меняет ни ключа, ни экрана: второй пункт `DialogSelect` просто закрывает диалог.
    expect(dialogSource).toContain("onSelect={(option) => (option.value ? void run() : dialog.clear())}")
  })

  /**
   * Извлекает тело `function outcome(data: CorpLogoutResult) { … }` из `dialogSource` и
   * возвращает исполняемую функцию, принимающую `t`/`format`/`revokeReasonText`/`data`.
   */
  function outcomeFn() {
    const start = dialogSource.indexOf("function outcome(data: CorpLogoutResult) {")
    expect(start, "функция outcome() не найдена").toBeGreaterThan(-1)
    const open = dialogSource.indexOf("{", dialogSource.indexOf(")", start))
    let depth = 0
    let end = open
    for (let index = open; index < dialogSource.length; index++) {
      if (dialogSource[index] === "{") depth += 1
      else if (dialogSource[index] === "}") {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    return new Function(
      "t",
      "format",
      "revokeReasonText",
      "data",
      dialogSource
        .slice(open + 1, end)
        .replace(/\bas const\b/g, "")
        .replace(/([\])\w])!(?=[\s;,)\].])/g, "$1"),
    ) as (t: (k: string) => string, format: (k: string, v: object) => string, reason: (c?: string) => string, data: unknown) => { variant: string; message: string }
  }

  test("AC-296: исход — как у Desktop: отказ отзыва помечен предупреждением, а не ошибкой", () => {
    const outcome = outcomeFn()
    // `t`/`format` — заглушки, раскрывающие, КАКИМ ключом собран текст (см. ниже, F-2); ho
    // `revokeReasonText` — НЕ заглушка, это настоящая функция из `corp/i18n.ts` (F-3): подмена её
    // самой заглушкой и была причиной, по которой прежняя версия теста не ловила ни слияние
    // исходов, ни утечку кода Hub напрямую в текст.
    const t = (key: string) => key
    const format = (key: string, vars: object) => `${key} ${JSON.stringify(vars)}`

    const revoked = outcome(t, format, revokeReasonText, { key_removed: true, hub: "revoked" })
    const notRevoked = outcome(t, format, revokeReasonText, { key_removed: true, hub: "not_revoked", revoke_error: "not_permitted" })
    const unavailable = outcome(t, format, revokeReasonText, { key_removed: true, hub: "unavailable" })
    const skipped = outcome(t, format, revokeReasonText, { key_removed: false, hub: "skipped" })

    expect(revoked.variant).not.toBe("warning")
    // Второй и третий — ПРЕДУПРЕЖДЕНИЕ, действие всё равно выполнено (D-49), и они различимы текстом.
    expect(notRevoked.variant).toBe("warning")
    expect(unavailable.variant).toBe("warning")
    expect(skipped.variant).not.toBe("warning")

    // F-2: не просто «разные строки» (это верно и при ошибочном слиянии веток, потому что
    // подставленная причина всё равно различается) — а РАЗНЫЙ ключ-шаблон сообщения.
    expect(notRevoked.message).toBe(format("logout.notRevoked", { reason: revokeReasonText("not_permitted") }))
    expect(unavailable.message).toBe(format("logout.revokeFailed", { reason: t("logout.reason.unreachable") }))
    const templateKeyOf = (message: string) => message.split(" ")[0]
    expect(templateKeyOf(notRevoked.message)).not.toBe(templateKeyOf(unavailable.message))
    expect(notRevoked.message).not.toBe(unavailable.message)
  })

  test("AC-296, S-A5: message от Hub не попадает в текст ни у одного исхода", () => {
    const outcome = outcomeFn()
    const t = (key: string) => key
    const format = (key: string, vars: object) => `${key} ${JSON.stringify(vars)}`
    const LEAK = "СЕКРЕТНАЯ ФРАЗА ОТ HUB"

    for (const data of [
      { key_removed: true, hub: "revoked", message: LEAK },
      { key_removed: true, hub: "not_revoked", revoke_error: "not_permitted", message: LEAK },
      { key_removed: true, hub: "unavailable", message: LEAK },
      { key_removed: false, hub: "skipped", message: LEAK },
    ]) {
      const result = outcome(t, format, revokeReasonText, data)
      expect(result.message, JSON.stringify(data)).not.toContain(LEAK)
    }
  })
})

describe("TUI — revokeReasonText: закрытый набор причин отказа отзыва (S-A14 п.1, S-I1; AC-300)", () => {
  test("AC-300: три известных кода дают три различимых текста", () => {
    const texts = new Set([
      revokeReasonText("not_permitted"),
      revokeReasonText("upstream_unavailable"),
      revokeReasonText("invalid_response"),
    ])
    expect(texts.size).toBe(3)
  })

  test("AC-300: неизвестный код и отсутствие кода дают тот же текст, что invalid_response, а не код машины", () => {
    const invalidResponseText = revokeReasonText("invalid_response")
    for (const code of ["unheard_of_code", undefined, "", "not_permitted_typo"]) {
      const text = revokeReasonText(code)
      expect(text, String(code)).toBe(invalidResponseText)
      if (code) expect(text).not.toContain(code)
    }
  })
})

describe("TUI — предупреждение о выключенном провайдере тем же роутом (S-C11, S-T11; AC-296)", () => {
  test("AC-296: действие «Включить» доступно в TUI и вызывает POST /corp/provider/enable", () => {
    expect(connectorsSource).toContain("sdk.client.corp.providerEnable()")
    expect(connectorsSource).toContain('format("provider.disabledTitle", { file: file() })')
    expect(connectorsSource).toContain('format("provider.enableConfirm", { file })')
  })

  test("AC-296: чужой слой не молчит — при reason foreign_layer показано предупреждение с файлом", () => {
    const body = connectorsSource.slice(
      connectorsSource.indexOf("async function enableProvider(file: string) {"),
      connectorsSource.indexOf("async function openHub("),
    )
    expect(body).toContain('data?.reason === "foreign_layer"')
    expect(body).toContain('variant: "warning"')
    expect(body).toContain('format("provider.enableForeignLayer"')
  })
})

/**
 * Отмена и отказ роута возвращают на витрину, а не роняют оболочку в чат (S-A16; попутный фикс
 * dev, найденный и закрытый мимо ревью и мимо изначального F-8/F-9 — коммит с правкой поведения
 * `run()`/`onLeave` в `dialog-corp-logout.tsx` и вызова `leaving()` в `dialog-connectors.tsx`).
 * «Отмена не меняет ни ключа, ни экрана» в терминале, где диалогового стека нет, означает
 * буквально это: экран выхода закрывается через `dialog.clear()`, тот зовёт зарегистрированный
 * `onClose` (`exit.done`), и только он решает, возвращаться ли на витрину. `leaving()` не
 * переисполняется тестом заново — берётся и запускается настоящая функция из исходника.
 */
describe("TUI — отмена/отказ выхода возвращают на витрину, успех с Hub — нет (S-A16; AC-296)", () => {
  function leavingFn() {
    const start = connectorsSource.indexOf("function leaving(next: () => void) {")
    expect(start, "функция leaving() не найдена").toBeGreaterThan(-1)
    const open = connectorsSource.indexOf("{", start)
    let depth = 0
    let end = open
    for (let index = open; index < connectorsSource.length; index++) {
      if (connectorsSource[index] === "{") depth += 1
      else if (connectorsSource[index] === "}") {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
      }
    }
    return new Function(`return (function leaving(next) { ${connectorsSource.slice(open + 1, end)} })`)() as (
      next: () => void,
    ) => { done: () => void; suppress: () => void }
  }

  test("leaving(): done() зовёт next(), пока suppress() не вызван раньше — настоящая функция, не переисполнение", async () => {
    const leaving = leavingFn()

    let calls = 0
    const exit = leaving(() => {
      calls += 1
    })
    exit.done()
    // `next` откладывается на микрозадачу (см. комментарий в исходнике) — ждём её.
    await Promise.resolve()
    expect(calls).toBe(1)
    // Повторный done() — идемпотентен, второго вызова next() нет.
    exit.done()
    await Promise.resolve()
    expect(calls).toBe(1)
  })

  test("leaving(): suppress() до done() гасит возврат — next() не вызывается вовсе", async () => {
    const leaving = leavingFn()
    let calls = 0
    const exit = leaving(() => {
      calls += 1
    })
    exit.suppress()
    exit.done()
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  test("AC-296: пункт «Выйти» в действиях витрины регистрирует возврат через leaving(backToList) и onLeave={exit.suppress}", () => {
    const trigger = connectorsSource.slice(
      connectorsSource.indexOf('command: "dialog.corp.logout"'),
      connectorsSource.indexOf('command: "dialog.corp.logout"') + 800,
    )
    expect(trigger).toContain("const exit = leaving(() => backToList())")
    expect(trigger).toContain("dialog.replace(() => <DialogCorpLogout onLeave={exit.suppress} />, exit.done)")
  })

  test("AC-296: отмена и отказ роута выхода закрываются через dialog.clear() — тот же путь, что зовёт onClose/exit.done", () => {
    // Отмена (второй пункт DialogSelect, value:false) — уже проверено выше отдельным тестом, что
    // это `dialog.clear()`; здесь же — отказ роута (`!data`, сеть/сервер недоступны).
    const runBody = dialogSource.slice(dialogSource.indexOf("async function run() {"), dialogSource.indexOf("return (\n    <DialogSelect"))
    const errorBranch = runBody.slice(runBody.indexOf("if (!data) {"), runBody.indexOf("if (!data) {") + 200)
    expect(errorBranch).toContain("dialog.clear()")
    expect(errorBranch).not.toContain("onLeave")
  })

  test("AC-296: успех с ключом при заданном Hub гасит возврат (onLeave) до перехода на экран входа, а не после dialog.clear()", () => {
    const runBody = dialogSource.slice(dialogSource.indexOf("async function run() {"), dialogSource.indexOf("return (\n    <DialogSelect"))
    const loginBranch = runBody.slice(
      runBody.indexOf("if (data.key_removed && hub() === true) {"),
      runBody.indexOf("} else dialog.clear()") + "} else dialog.clear()".length,
    )
    // Гашение возврата (`onLeave`) стоит РАНЬШЕ перехода на экран входа — иначе dialog.replace
    // успел бы позвать зарегистрированный onClose (exit.done) и увести на витрину вместо входа.
    expect(loginBranch.indexOf("props.onLeave?.()")).toBeGreaterThan(-1)
    expect(loginBranch.indexOf("props.onLeave?.()")).toBeLessThan(loginBranch.indexOf("dialog.replace(() => <DialogCorpLogin"))
    // Иначе (без ключа, без Hub) — тот же dialog.clear(), что у отмены и отказа: витрина, а не вход.
    expect(loginBranch).toContain("else dialog.clear()")
  })
})
