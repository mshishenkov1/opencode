import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { For, Show, createSignal, type JSXElement } from "solid-js"
import { render } from "solid-js/web"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Dialog as DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import "@/index.css"
import "@/components/corp/dialog-shell.css"

/**
 * Оболочка витрины коннекторов для измерения раскладки (BUG-I10-002, S-D6, S-D10).
 *
 * Здесь ровно то, что определяет геометрию, и всё это — **настоящее**: контейнер `Dialog`/`DialogV2`
 * внутри той же обёртки Kobalte, какой их монтирует `packages/ui/src/context/dialog.tsx`, настоящие
 * `TabsV2` и `List`, настоящие стили приложения (`@/index.css` тянет темы, утилиты и CSS всех
 * компонентов) и корп-`dialog-shell.css`. Своего CSS фикстура не добавляет ни строки: любое правило,
 * влияющее на раскладку, приходит из тех же файлов, что и в собранном приложении.
 *
 * Содержимое строк — та же разметка, что у витрины (`dialog-connectors.tsx`): те же `data-slot`,
 * те же три ячейки, те же классы. Совпадение слотов проверяется отдельным утверждением теста, чтобы
 * переименование в витрине ломало фикстуру громко, а не делало её зелёной и бессмысленной.
 */

export interface Card {
  alias: string
  title: string
  type?: string
  connected: boolean
}

export interface ShellOptions {
  /** Ветка флага «New layout and designs»: `legacy` — прежний `Dialog`, `v2` — `DialogV2`. */
  branch: "legacy" | "v2"
  /** Сколько карточек в каталоге. */
  cards: number
  /** Пустое состояние (S-V12) вместе с его действием — вместо строк. */
  empty?: { text: string; action: "refresh" | "login" | "resetFilter" }
  /** Баннер «источник недоступен» и предупреждение о неполном каталоге — они тоже вне прокрутки. */
  banner?: string
  partial?: string
  /** Показывать ли вкладки и шапку: при «Hub недоступен» и «Требуется вход» их нет (S-V11). */
  table?: boolean
}

const catalog = (count: number): Card[] =>
  Array.from({ length: count }, (_, at) => ({
    alias: `connector-${at}`,
    title: `Коннектор номер ${at}`,
    type: at % 3 === 0 ? "Мессенджер" : at % 3 === 1 ? "Трекер задач" : undefined,
    connected: at % 2 === 0,
  }))

/**
 * Строка витрины (S-D6, S-V18, S-V22) — та же разметка, что в `dialog-connectors.tsx`.
 *
 * Ревизия 1.12: имя показывается **один раз** (см. guard-тест «фикстура повторяет разметку витрины»
 * ниже) — подпись `alias` второй строкой убрана в настоящем компоненте, и повторение её здесь молча
 * измеряло бы высоту строки, которой у приложения больше нет (см. отчёт по разбору фикстуры).
 */
function Row(props: { card: Card }) {
  return (
    <div data-slot="corp-connectors-row" class="w-full">
      <div class="flex items-center gap-2 min-w-0">
        <span class="text-14-regular text-text-strong truncate">{props.card.title}</span>
        <Show when={props.card.alias.endsWith("0")}>
          <Tag>устаревший</Tag>
        </Show>
      </div>
      <span class="text-12-regular text-text-weak truncate">{props.card.type ?? ""}</span>
      <span data-slot="corp-status-cell">
        <span data-slot="corp-status-dot" data-tone={props.card.connected ? "success" : "weak"} aria-hidden="true">
          &bull;
        </span>
        <span
          class={
            props.card.connected
              ? "text-12-regular text-text-strong truncate"
              : "text-12-regular text-text-weak truncate"
          }
        >
          {props.card.connected ? "Подключено" : "Не подключён"}
        </span>
      </span>
    </div>
  )
}

/** Содержимое витрины (S-D6): вкладки → поиск → шапка → список → пустое состояние. */
function Connectors(props: { options: ShellOptions }) {
  const [query, setQuery] = createSignal("")
  const items = () => catalog(props.options.cards)
  const table = () => props.options.table !== false

  return (
    <div class="corp-connectors" data-empty={props.options.empty ? "" : undefined}>
      <Show when={props.options.banner}>
        {(value) => (
          <div data-slot="corp-connectors-banner" class="text-12-regular text-text-weak">
            {value()}
          </div>
        )}
      </Show>
      <Show when={props.options.partial}>
        {(value) => (
          <div data-slot="corp-connectors-partial" class="text-12-regular text-text-weak">
            {value()}
          </div>
        )}
      </Show>

      {/*
        Ревизия 1.12 (D-53) убрала вкладку «Неподключённые» — реальная витрина держит только «Все» и
        «Подключённые» (dialog-connectors.tsx, TAB_KEY). Набор и порядок value-атрибутов триггеров
        вкладок ниже обязаны совпадать с исходником буквально: guard-тест «фикстура повторяет
        разметку витрины» вычисляет ожидаемый список из исходника через регэксп и сверяет его с этим
        местом — лишняя вкладка здесь не осталась бы незамеченной, как раньше, когда тест проверял
        только наличие прежних строк, а не их полный, ровно такой же набор.
      */}
      <Show when={table()}>
        <TabsV2 variant="pill" data-slot="corp-connectors-tabs" value="all" onChange={() => {}}>
          <TabsV2.List>
            <TabsV2.Trigger value="all">Все</TabsV2.Trigger>
            <TabsV2.Trigger value="connected">Подключённые</TabsV2.Trigger>
          </TabsV2.List>
        </TabsV2>
      </Show>

      <Show when={table()}>
        <div data-slot="corp-connectors-header" class="text-12-regular text-text-weak">
          <span>Имя</span>
          <span>Тип</span>
          <span>Статус</span>
        </div>
      </Show>

      <List
        search={{ placeholder: "Поиск коннекторов" }}
        emptyMessage={props.options.empty?.text}
        key={(card: Card | undefined) => card?.alias ?? ""}
        items={items()}
        filter={query()}
        onFilter={setQuery}
        skipFilter={() => true}
        onSelect={() => {}}
      >
        {(card: Card) => <Row card={card} />}
      </List>

      <Show when={props.options.empty}>
        {(state) => (
          <div data-slot="corp-connectors-empty">
            <span class="text-14-regular text-text-strong">{state().text}</span>
            <button data-slot="corp-connectors-empty-action">{state().action}</button>
          </div>
        )}
      </Show>
    </div>
  )
}

/**
 * Обёртка Kobalte — та же, что в `packages/ui/src/context/dialog.tsx`: модальный корень, портал,
 * оверлей и слой, растянутый на весь экран и центрирующий окно. Именно она даёт панели её высоту,
 * поэтому подменять её собственной разметкой нельзя.
 */
function Layer(props: { children: JSXElement }) {
  return (
    <Kobalte modal open onOpenChange={() => {}}>
      <Kobalte.Portal>
        <Kobalte.Overlay data-component="dialog-overlay" style={{ "z-index": "100" }} />
        <div
          data-dialog-layer="0"
          style={{
            position: "fixed",
            inset: "0",
            "z-index": "100",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            "pointer-events": "none",
          }}
        >
          {props.children}
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}

function Shell(props: { options: ShellOptions }) {
  const title = "Коннекторы"
  const description = `подключено 0 из ${props.options.cards}`
  const action = <button data-slot="corp-refresh">Обновить</button>
  return (
    <Layer>
      <Show
        when={props.options.branch === "v2"}
        fallback={
          <Dialog size="x-large" transition class="corp-dialog" title={title} description={description} action={action}>
            <Connectors options={props.options} />
          </Dialog>
        }
      >
        <DialogV2 size="x-large" class="corp-dialog-v2" title={title} description={description} action={action}>
          <Connectors options={props.options} />
        </DialogV2>
      </Show>
    </Layer>
  )
}

let dispose: (() => void) | undefined

/**
 * Монтирует оболочку витрины заново. Возвращается только после того, как раскладка посчитана и
 * анимации открытия доиграли: прежний `Dialog` открывается с `transform: scale(0.98) → 1`
 * (`contentShow`, 150ms), и измерение на середине анимации дало бы высоту на два процента меньше
 * настоящей — тест мерил бы кадр, а не раскладку.
 */
async function renderShell(options: ShellOptions) {
  dispose?.()
  document.body.innerHTML = ""
  const host = document.createElement("div")
  host.id = "corp-shell-host"
  document.body.appendChild(host)
  dispose = render(() => <Shell options={options} />, host)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  // Бесконечные анимации (маска списка) `finished` не отдают — ждём их не дольше полусекунды.
  const settled = Promise.allSettled(document.getAnimations().map((animation) => animation.finished))
  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 500))])
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

declare global {
  interface Window {
    renderCorpShell: typeof renderShell
  }
}

window.renderCorpShell = renderShell
