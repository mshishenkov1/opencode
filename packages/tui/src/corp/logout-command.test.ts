import { describe, expect, test } from "bun:test"
import path from "path"

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

  test("AC-296: исход — как у Desktop: отказ отзыва помечен предупреждением, а не ошибкой", () => {
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
    const outcome = new Function(
      "t",
      "format",
      "revokeReasonText",
      "data",
      dialogSource
        .slice(open + 1, end)
        .replace(/\bas const\b/g, "")
        .replace(/([\])\w])!(?=[\s;,)\].])/g, "$1"),
    ) as (t: (k: string) => string, format: (k: string, v: object) => string, reason: (c?: string) => string, data: unknown) => { variant: string; message: string }
    const t = (key: string) => key
    const format = (key: string, vars: object) => `${key} ${JSON.stringify(vars)}`
    const reason = (code?: string) => code ?? "unreachable"

    const revoked = outcome(t, format, reason, { key_removed: true, hub: "revoked" })
    const notRevoked = outcome(t, format, reason, { key_removed: true, hub: "not_revoked", revoke_error: "not_permitted" })
    const unavailable = outcome(t, format, reason, { key_removed: true, hub: "unavailable" })
    const skipped = outcome(t, format, reason, { key_removed: false, hub: "skipped" })

    expect(revoked.variant).not.toBe("warning")
    // Второй и третий — ПРЕДУПРЕЖДЕНИЕ, действие всё равно выполнено (D-49), и они различимы текстом.
    expect(notRevoked.variant).toBe("warning")
    expect(unavailable.variant).toBe("warning")
    expect(notRevoked.message).not.toBe(unavailable.message)
    expect(skipped.variant).not.toBe("warning")
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
