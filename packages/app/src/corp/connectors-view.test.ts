import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Витрина коннекторов Desktop: размер корп-окна и признак «Подключено»
 * (S-D10, S-V16, S-V17, S-V18, S-V19, S-Q9; AC-172, AC-177, AC-184).
 *
 * Разметку и стили проверяем двумя способами:
 *   - **каскад CSS** — настоящие файлы стилей (`packages/ui` + `dialog-shell.css`) грузятся в
 *     документ happy-dom, и вычисленные свойства читаются с тех же элементов, что строит `Dialog`.
 *     Так ловится и опечатка в селекторе, и потерянное правило. Раскладка (layout) в среде тестов
 *     не считается, поэтому проверяется наблюдаемый инвариант S-D10: **высота панели приходит от
 *     контейнера, а не от содержимого**, и объявление высоты контейнера у корп-окна и у окна
 *     настроек — одно и то же;
 *   - **исходник экрана** — то, чего в стилях не видно: какие элементы карточка показывает и при
 *     каком состоянии (S-V16, S-V18), и что `fit` окну не передаётся ни в одной ветке флага.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/connectors-view.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "..")
const ROOT = path.resolve(APP, "../../..")

const read = (file: string) => fs.readFileSync(file, "utf8")

const CSS = {
  dialog: read(path.join(ROOT, "packages/ui/src/components/dialog.css")),
  dialogV2: read(path.join(ROOT, "packages/ui/src/v2/components/dialog-v2.css")),
  corp: read(path.join(APP, "components/corp/dialog-shell.css")),
}

const SOURCE = {
  shell: read(path.join(APP, "components/corp/dialog-shell.tsx")),
  connectors: read(path.join(APP, "components/corp/dialog-connectors.tsx")),
}

/**
 * Объявленная высота контейнера окна размера `x-large` — то, что задаёт высоту окна целиком.
 * Читается из настоящего файла стилей: happy-dom вложенные `&[data-size=…]`-селекторы не
 * раскрывает, поэтому объявление сверяется по тексту правила, а растяжение панели — каскадом.
 */
function containerSize(css: string) {
  const at = css.indexOf('&[data-size="x-large"] [data-slot="dialog-container"]')
  expect(at, "правило размера x-large не найдено").toBeGreaterThan(-1)
  const block = css.slice(at, css.indexOf("}", at))
  return {
    width: /width:\s*([^;]+);/.exec(block)![1]!.trim(),
    height: /height:\s*([^;]+);/.exec(block)![1]!.trim(),
  }
}

/** Ветки флага «New layout and designs»: прежний `Dialog` и `DialogV2` формата settings-v2. */
const BRANCHES = {
  legacy: { component: "dialog", corpClass: "corp-dialog" },
  v2: { component: "dialog-v2", corpClass: "corp-dialog-v2" },
} as const

interface Content {
  /** Сколько карточек в списке. */
  cards: number
  /** Баннер «Hub недоступен», предупреждение об отброшенных карточках, пустое состояние. */
  banner?: boolean
  partial?: boolean
  empty?: boolean
  /** Корп-окно или окно настроек той же ветки. */
  corp?: boolean
  /** Передан ли окну `fit` — контрольный случай: он снимает высоту контейнера. */
  fit?: boolean
}

/**
 * Строит ту же разметку, что и `Dialog`/`DialogV2` вокруг содержимого витрины, и возвращает
 * контейнер окна и его видимую панель.
 */
function render(branch: keyof typeof BRANCHES, content: Content) {
  const { component, corpClass } = BRANCHES[branch]
  document.head.innerHTML = `<style>${CSS.dialog}</style><style>${CSS.dialogV2}</style><style>${CSS.corp}</style>`
  const cards = Array.from({ length: content.cards }, (_, at) => `<div data-slot="list-item">коннектор ${at}</div>`)
  document.body.innerHTML = `
    <div data-component="${component}" data-size="x-large"${content.fit ? " data-fit" : ""}>
      <div data-slot="dialog-container">
        <div data-slot="dialog-content"${content.corp === false ? "" : ` class="${corpClass}"`}>
          <div data-slot="dialog-body">
            ${content.banner ? '<div data-slot="corp-banner">Hub недоступен</div>' : ""}
            ${content.partial ? '<div data-slot="corp-partial">часть карточек отброшена</div>' : ""}
            ${content.empty ? '<div data-slot="corp-empty">Каталог пуст</div>' : ""}
            <div data-slot="list">${cards.join("")}</div>
          </div>
        </div>
      </div>
    </div>`
  const container = document.querySelector('[data-slot="dialog-container"]') as HTMLElement
  const panel = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
  return {
    container,
    panel,
    containerStyle: getComputedStyle(container),
    panelStyle: getComputedStyle(panel),
  }
}

describe("корп-окно витрины — размер не зависит от содержимого (S-D10; AC-184)", () => {
  for (const branch of ["legacy", "v2"] as const) {
    test(`AC-184: ${branch} — ноль, одна и полсотни карточек дают одну и ту же высоту окна`, () => {
      const panels = new Set<string>()
      for (const cards of [0, 1, 50]) {
        const view = render(branch, { cards })
        panels.add(`${view.panelStyle.height}|${view.panelStyle.minHeight}|${view.panelStyle.overflow}`)
      }
      expect(panels.size, [...panels].join(" / ")).toBe(1)
      // Высота панели приходит от контейнера: содержимое её не растит и не сжимает.
      const [panel] = [...panels]
      expect(panel).toBe("100%|0|hidden")
    })

    test(`AC-184: ${branch} — баннер, предупреждение и пустое состояние высоту не меняют`, () => {
      const base = render(branch, { cards: 12 })
      const panel = `${base.panelStyle.height}|${base.panelStyle.minHeight}|${base.panelStyle.overflow}`

      for (const extra of [{ banner: true }, { partial: true }, { empty: true }, { banner: true, partial: true }]) {
        const view = render(branch, { cards: extra.empty ? 0 : 12, ...extra })
        expect(
          `${view.panelStyle.height}|${view.panelStyle.minHeight}|${view.panelStyle.overflow}`,
          JSON.stringify(extra),
        ).toBe(panel)
      }
    })

    test(`AC-184: ${branch} — окно витрины и окно настроек одной ветки объявлены одним размером`, () => {
      // Высоту окна задаёт контейнер размера `x-large`; и корп-окно, и окно настроек просят
      // именно его, поэтому объявленная высота у них общая по построению.
      const size = containerSize(branch === "legacy" ? CSS.dialog : CSS.dialogV2)
      expect(size.height).toBe(branch === "legacy" ? "min(calc(100vh - 32px), 600px)" : "560px")
      expect(SOURCE.shell).toContain('size="x-large"')

      const settings = read(
        path.join(APP, "components", branch === "legacy" ? "dialog-settings.tsx" : "settings-v2/dialog-settings-v2.tsx"),
      )
      expect(settings, branch).toContain('size="x-large"')
    })

    test(`AC-184: ${branch} — список прокручивается внутри окна, само окно не прокручивается`, () => {
      const view = render(branch, { cards: 50 })
      expect(view.panelStyle.overflow).toBe("hidden")
    })
  }

  test("AC-184: высоты веток различны — сравниваются окна одной ветки, а не одна константа", () => {
    expect(containerSize(CSS.dialog).height).not.toBe(containerSize(CSS.dialogV2).height)
  })

  test("AC-184: `fit` корп-окну не передаётся ни в одной ветке флага", () => {
    // `fit` снимает высоту контейнера (`[data-fit] [data-slot="dialog-container"] { height: auto }`)
    // и вернул бы ровно тот дефект, который S-D10 исправляет.
    expect(CSS.dialog).toMatch(/&\[data-fit\]/)
    const shell = SOURCE.shell
      .split("\n")
      .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      .join("\n")
    expect(shell).not.toMatch(/(^|\s)fit(\s|=|\}|$)/m)
    expect(shell).toContain('size="x-large"')
    expect(shell).toContain('class="corp-dialog"')
    expect(shell).toContain('class="corp-dialog-v2"')
  })

  test("S-D10: правило относится ко всем корп-окнам, а не только к витрине", () => {
    // Размер задаёт контейнер `CorpDialog`, а не отдельный экран: витрина, вход и права его
    // получают, ничего про размеры не зная (D-33).
    const text = read(path.join(APP, "components/corp", "dialog-connectors.tsx"))
    expect(text).toContain("CorpDialog")
    // Экран витрины про размеры не знает: ни размера, ни `fit` он контейнеру не задаёт.
    expect(text).not.toMatch(/<CorpDialog[^>]*size=/)
    expect(text).not.toMatch(/<CorpDialog[^>]*\bfit\b/)
  })

  test("S-D10: общие стили packages/ui ради витрины не правятся", () => {
    // Растяжение панели живёт в корп-файле стилей и адресовано корп-классу.
    expect(CSS.corp).toContain(".corp-dialog")
    expect(CSS.corp).toContain(".corp-dialog-v2")
    expect(CSS.dialog).not.toContain("corp-dialog")
    expect(CSS.dialogV2).not.toContain("corp-dialog")
  })
})

describe("карточка витрины — признак «Подключено» и объяснение ошибки (AC-177, AC-172)", () => {
  const source = SOURCE.connectors

  test("AC-177: бейдж «Подключено» — тот же элемент и размер, что бейдж «устаревший»", () => {
    const connected = source.slice(source.indexOf('card.state === "connected"'))
    const badge = connected.slice(0, connected.indexOf("</Show>"))
    expect(badge).toContain("<Tag")
    expect(badge).toContain('language.t("corp.connectors.connected")')
    // Бейдж «устаревший» рисуется тем же средством — `Tag` без собственного размера.
    expect(source).toContain('<Tag>{language.t("corp.connectors.deprecated")}</Tag>')
    // Признак положительный: он показывается по состоянию 4, а не по отсутствию кнопки.
    expect(badge).not.toContain("!card")
  })

  test("AC-177: подпись статуса сохраняется — бейдж её дополняет, а не заменяет", () => {
    expect(source).toContain("language.t(STATUS_KEY[card.status])")
    // Мелкий вспомогательный шрифт остаётся у подписи, но признаком подключения уже не является.
    expect(source).toContain('text-11-regular text-text-weaker')
  })

  test("AC-177: у подключённой карточки нет кнопки «Подключить»", () => {
    // Кнопка показывается строго по набору действий, а состояние 4 его не содержит (S-V16).
    expect(source).toContain('<Show when={card.actions.includes("connect") || card.actions.includes("reconnect")}>')
    expect(source).toContain('<Show when={card.actions.includes("disconnect")}>')
    expect(source).toContain('<Show when={card.actions.includes("forget")}>')
    expect(source).toContain('<Show when={card.actions.includes("permissions")}>')
  })

  test("AC-172: слово «Отключить» на карточке появляется только по действию disconnect", () => {
    const occurrences = source.split('language.t("corp.connectors.disconnect")').length - 1
    expect(occurrences).toBe(1)
    const before = source.slice(0, source.indexOf('language.t("corp.connectors.disconnect")'))
    // Ближайший охраняющий `Show` — именно про действие disconnect.
    expect(before.slice(before.lastIndexOf("<Show"))).toContain('card.actions.includes("disconnect")')
  })

  test("AC-172, S-V19: подпись состояния и объяснение ошибки берутся из состояния и класса", () => {
    const table = source.slice(source.indexOf("const STATE_KEY"), source.indexOf("} as const", source.indexOf("const STATE_KEY")))
    expect(table).toContain('failed: "corp.connectors.neverConnected"')
    expect(table).toContain('lost: "corp.connectors.lost"')
    expect(table).toContain('disconnected: "corp.connectors.disconnected"')

    const explain = source.slice(source.indexOf("function explain("))
    expect(explain.slice(0, explain.indexOf("}"))).toContain("connectErrorKey(card.error_class)")
    // Предлагаемое действие показывается тем же элементом, которым выполняется: отдельной
    // «кнопки-совета» на карточке нет.
    expect(source).not.toContain("corp.connectors.advice")
  })

  test("S-V17: «Убрать из списка» спрашивает подтверждение, отмена ничего не меняет", () => {
    const confirm = source.slice(source.indexOf("const DialogForgetConnector"))
    const body = confirm.slice(0, confirm.indexOf("export const DialogConnectors"))
    expect(body).toContain('language.t("corp.connectors.forgetConfirm"')
    expect(body).toContain('language.t("common.cancel")')
    expect(body).toContain('action.mutate({ kind: "forget"')
    // Отмена закрывает окно и не вызывает мутацию.
    const cancel = body.slice(body.indexOf('variant="ghost"'), body.indexOf('variant="primary"'))
    expect(cancel).toContain("dialog.close()")
    expect(cancel).not.toContain("action.mutate")
  })
})
