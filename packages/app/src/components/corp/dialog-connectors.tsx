import { Component, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { CorpCatalogCard } from "@opencode-ai/sdk/v2"
import { connectorType, corpUserLabel } from "@opencode-ai/core/corp/constants"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { corpErrorKey, useCorpCatalog, useCorpInvalidate, useCorpLogout, useCorpStatus, useProviderEnable } from "@/context/corp"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { ConnectorIcon } from "./connector-icon"
import { CorpDialog } from "./dialog-shell"

/**
 * Витрина коннекторов Desktop/web — плоская таблица (S-D2, S-D6, S-V11, S-V12, S-V18, S-V22).
 *
 * Композиция сверху вниз, и каждая часть — существующий компонент (S-D6):
 * `CorpDialog` (окно и его габариты, S-D10) → `TabsV2 variant="pill"` (две вкладки-фильтра
 * S-V11) → неподвижная шапка «Имя | Тип | Статус» → существующий `List` (поиск, клавиатурная
 * навигация, пустые состояния). Группировка по владельцу отменена: витрина — таблица состояний,
 * а не лента, и заголовки групп ломали выравнивание колонок.
 *
 * Ревизия 1.12 по правкам живой витрины: обновление — иконкой, а не словом (D-53); имя коннектора
 * показывается один раз, без подписи `alias` второй строкой; вкладок две.
 *
 * Строка не носит кнопок действий: и они, и описание уехали на страницу коннектора (S-D11),
 * которая открывается основным действием строки через `useDialog().push` — витрина при этом
 * остаётся в стеке живой, поэтому возврат сохраняет вкладку, поиск и позицию прокрутки.
 */

/** Подписи состояний витрины (S-V6) — используются, когда попытки подключения ещё не было. */
const STATUS_KEY = {
  connected: "corp.status.connected",
  needs_auth: "corp.status.needs_auth",
  not_connected: "corp.status.not_connected",
  unavailable: "corp.status.unavailable",
} as const

/**
 * Подписи состояний карточки (S-V16).
 *
 * Состояние 3 имеет две подписи при одном наборе действий: «Соединение потеряно» — когда связь
 * сломалась сама, «Отключено вами» — когда пользователь отключил сервер сам. Путать поломку с
 * собственным решением нельзя, поэтому подписи разные. У состояния 1 подписи своей нет — её
 * несёт состояние витрины.
 */
const STATE_KEY = {
  never: undefined,
  failed: "corp.connectors.neverConnected",
  lost: "corp.connectors.lost",
  disconnected: "corp.connectors.disconnected",
  connected: "corp.connectors.connected",
} as const

/**
 * Вкладки-фильтры витрины (S-V11, переформулирован ревизией 1.12: было три, стало две).
 * Умолчание — «Все»; выбор между запусками не персистится.
 *
 * «Неподключённые» убрана заказчиком: на реальном каталоге она почти совпадала со «Всеми»
 * (подключено два-три из полутора десятков), а орган фильтрации, дающий тот же список, — не
 * фильтр, а лишний выбор (D-53).
 */
export type ConnectorsTab = "all" | "connected"

const TAB_KEY = {
  all: "corp.connectors.tabAll",
  connected: "corp.connectors.tabConnected",
} as const

/**
 * Ключ подписи состояния для колонки «Статус» (S-V18).
 *
 * Текст в ячейке есть всегда: точка его дублирует, а не заменяет — состояние обязано читаться и
 * в чёрно-белой печати, и при дальтонизме.
 */
export function statusKey(card: Pick<CorpCatalogCard, "state" | "status">) {
  return STATE_KEY[card.state] ?? STATUS_KEY[card.status]
}

/**
 * Тон состояния в колонке «Статус» (S-V18): семантический токен темы, а не произвольный цвет.
 * `success` — «Подключено»; `danger` — «Подключение не удалось» и `unavailable`; `warning` —
 * «Нужна повторная авторизация», «Соединение потеряно» и «Отключено вами»; `weak` — «Не подключено».
 *
 * Ревизией 1.14 цветную точку заменила галочка у подключённого (макет заказчика от 30.08): значок
 * появился там, где состояние положительное, а тон переехал с точки на саму ячейку. Дублирование
 * цвета текстом при этом сохранено — цвет по-прежнему не единственный носитель состояния.
 */
export function statusTone(card: Pick<CorpCatalogCard, "state" | "status">): "success" | "warning" | "danger" | "weak" {
  if (card.state === "connected") return "success"
  if (card.state === "failed" || card.status === "unavailable") return "danger"
  if (card.state === "lost" || card.state === "disconnected") return "warning"
  if (card.status === "needs_auth") return "warning"
  return "weak"
}

/**
 * Ключ бейджа способа подключения рядом с колонкой «Тип» (S-V22, решение заказчика от 30.08).
 *
 * Различает коннекторы **бейдж**, а не колонка типа: тип у всех один — MCP. Признак берётся из
 * `mode` каталога, то есть из природы записи, а не из состояния связи: «Через Hub» у карточки
 * фасада, «Напрямую» у карточки, к которой приложение ходит само, «Локальный» у записи, которой в
 * каталоге нет вовсе (правило 1 S-V6 — alias остался в конфиге, а из каталога пропал; там `mode`
 * не откуда взять). Поэтому недоступный Hub и оборванное подключение бейджа не меняют.
 */
export function connectModeKey(card: Pick<CorpCatalogCard, "mode">) {
  if (card.mode === "facade") return "corp.connectors.viaHub"
  if (card.mode === "native") return "corp.connectors.viaDirect"
  return "corp.connectors.viaLocal"
}

/**
 * Вкладка карточки (S-V11): «Подключённые» — карточки в состоянии 4 таблицы S-V16. Определение
 * сохранено дословно с ревизии 1.10; изменилось лишь то, что противоположной вкладки больше нет.
 */
export function matchesTab(card: CorpCatalogCard, tab: ConnectorsTab): boolean {
  if (tab === "all") return true
  return card.state === "connected"
}

/**
 * Поиск витрины (S-V11, S-V22): подстрока без учёта регистра по `title`, `alias`, `description`,
 * `owner` и `type`. Порядок строк при этом остаётся порядком каталога Hub — ранжирования у
 * подстрочного поиска нет.
 */
export function matchesQuery(card: CorpCatalogCard, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [card.title, card.alias, card.description, card.owner, card.type].some((value) =>
    value ? value.toLowerCase().includes(needle) : false,
  )
}

/**
 * Подтверждение выхода (S-A16).
 *
 * Выход отменяется только повторным входом, а вход требует браузера и SSO, поэтому действие
 * спрашивает один раз явно; отмена не меняет ни ключа, ни экрана. Текст называет **обе** части —
 * ключ будет отозван на сервере и удалён у вас, — а в сборке без Hub говорит только о локальном
 * ключе и слова «Hub» не содержит (D-43).
 */
const DialogCorpLogout: Component<{ hubConfigured: boolean }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const logout = useCorpLogout()

  return (
    <Dialog title={language.t("corp.logout.action")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.t(props.hubConfigured ? "corp.logout.confirm" : "corp.logout.confirmLocal")}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={logout.isPending}
            onClick={() => {
              logout.mutate()
              dialog.close()
            }}
          >
            {language.t("corp.logout.action")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Подтверждение действия «Включить» (S-C11 п.5): действие правит конфиг пользователя, поэтому
 * спрашивает подтверждение и называет файл, который будет изменён. Отмена не меняет ничего.
 */
const DialogProviderEnable: Component<{ file: string }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const enable = useProviderEnable()

  return (
    <Dialog title={language.t("corp.provider.enable")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.t("corp.provider.enableConfirm", { file: props.file })}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={enable.isPending}
            onClick={() => {
              enable.mutate()
              dialog.close()
            }}
          >
            {language.t("corp.provider.enable")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export const DialogConnectors: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const invalidate = useCorpInvalidate()
  const catalog = useCorpCatalog(() => true)
  const status = useCorpStatus()
  /** Подпись пользователя в заголовке витрины: email, а при неизвестном email — `user_id` (S-A13). */
  const user = createMemo(() => {
    const value = status.data?.user
    return value ? corpUserLabel(value) : undefined
  })
  // Витрина открывается из `Layout` — директорного SDK-контекста там нет (BUG-I4-002). Поток событий
  // сервера общий для всех рабочих каталогов, поэтому слушаем его целиком и фильтруем по типу.
  const sdk = useServerSDK()

  // S-V7 шаг 3 / AC-60: браузер открыть не удалось — показываем URL авторизации текстом,
  // ожидание callback при этом продолжается.
  onCleanup(
    sdk().event.listen((event) => {
      if (event.details.type !== "mcp.browser.open.failed") return
      showToast({
        variant: "default",
        title: language.t("corp.connectors.authorizing"),
        description: event.details.properties.url,
      })
    }),
  )

  const [tab, setTab] = createSignal<ConnectorsTab>("all")
  // Строка поиска живёт здесь, а не только внутри `List`: по ней считается, пусто ли пересечение
  // вкладки и запроса (S-V12, состояние 5), и она же возвращается в поле после сброса фильтра.
  const [query, setQuery] = createSignal("")

  const cards = createMemo<CorpCatalogCard[]>(() => catalog.data?.servers ?? [])
  const connected = createMemo(() => cards().filter((card) => card.state === "connected").length)

  /**
   * Видимые строки: поиск и вкладка перемножаются, а не спорят (S-V11). Отбор выполняется здесь,
   * а `List` получает готовый набор (`skipFilter`), потому что S-V11 требует **подстроку** и
   * **порядок каталога**, а встроенный поиск списка нечёткий и ранжирует результаты по релевантности.
   */
  const visible = createMemo(() => cards().filter((card) => matchesTab(card, tab()) && matchesQuery(card, query())))

  /**
   * Задан ли адрес Hub в этой сборке (S-C10 п.7). Поле необязательно ради совместимости ответа:
   * его отсутствие означает «сборка с Hub» — поведение до ревизии 1.11.
   */
  const hubConfigured = createMemo(() => catalog.data?.hub_configured !== false)

  /**
   * Недоступный источник называется своим именем (S-V12 п.3, D-43): в сборке без Hub слово «Hub»
   * не показывается нигде, поэтому ни текст класса ошибки (`corp.error.hub_*`), ни дата кэша с
   * упоминанием Hub туда не подставляются — сообщение называет недоступным **каталог**.
   */
  const unavailableSource = createMemo(() =>
    hubConfigured() ? language.t("corp.connectors.hubDown") : language.t("corp.connectors.catalogUnavailable"),
  )

  const banner = createMemo(() => {
    const data = catalog.data
    if (!data?.hub_error) return undefined
    if (data.hub_error === "unauthorized") return language.t("corp.connectors.needsLogin")
    if (!hubConfigured()) return unavailableSource()
    if (!data.cached_at) return `${unavailableSource()}: ${language.t(corpErrorKey(data.hub_error))}`
    return language.t("corp.connectors.hubDownCached", { at: new Date(Number(data.cached_at)).toLocaleString() })
  })

  /** Число карточек, отброшенных разбором каталога (S-V14 п.5). */
  const dropped = createMemo(() => catalog.data?.dropped?.length ?? 0)

  /**
   * Предупреждение о неполном каталоге (S-V12): разобрана хотя бы одна карточка, но не все —
   * витрина показывает принятые и говорит, сколько отброшено.
   */
  const partial = createMemo(() => {
    if (dropped() === 0 || cards().length === 0) return undefined
    return language.t("corp.connectors.partial", { dropped: dropped() })
  })

  /** Каталога нет вовсе: Hub не ответил или требуется вход — фильтровать нечего (S-V11). */
  const hubEmpty = createMemo(
    () => cards().length === 0 && !catalog.isLoading && (!catalog.data || !!catalog.data.hub_error),
  )
  const showTable = createMemo(() => !hubEmpty())

  /**
   * Пять пустых состояний (S-V12, ревизия 1.12: было шесть — вместе со вкладкой «Неподключённые»
   * исчезло её пустое состояние). Первые четыре — про каталог целиком и предлагают запросить его
   * заново («Обновить») либо войти («Войти»); пятое — про вкладку, и предлагает сброс фильтра
   * («Показать все»), потому что каталог-то на месте.
   *
   * Пустой результат на вкладке «Все» сюда не попадает: там причина — поиск, и `List` сам говорит
   * об этом своим сообщением с текстом запроса.
   */
  const empty = createMemo(() => {
    if (catalog.isLoading) return undefined
    const data = catalog.data
    if (cards().length === 0) {
      if (!data) return { text: unavailableSource(), action: "refresh" as const }
      if (data.hub_error === "unauthorized")
        return { text: language.t("corp.connectors.needsLogin"), action: "login" as const }
      if (data.hub_error)
        return {
          // Состояние 3 (S-V12 п.3): текст называет недоступный **источник**, а не Hub безусловно.
          text: hubConfigured()
            ? `${unavailableSource()}: ${language.t(corpErrorKey(data.hub_error))}`
            : unavailableSource(),
          action: "refresh" as const,
        }
      // Состояния 1 и 2 обязаны различаться текстом: первое — правда о каталоге, второе —
      // сообщение о дефекте клиента, и путать их нельзя.
      if (dropped() > 0)
        return { text: language.t("corp.empty.unparsed", { dropped: dropped() }), action: "refresh" as const }
      return { text: language.t("corp.connectors.empty"), action: "refresh" as const }
    }
    if (visible().length > 0) return undefined
    if (tab() === "connected") return { text: language.t("corp.empty.tabConnected"), action: "resetFilter" as const }
    return undefined
  })

  async function openLogin() {
    const module = await import("@/components/corp/dialog-corp-login")
    dialog.show(() => <module.DialogCorpLogin />)
  }

  /**
   * Есть ли ключ `magnit_prod` (S-A16) — **три** значения, а не два.
   *
   * `true` — ключ есть, `false` — ключа нет, `undefined` — этого ещё не известно: статус не
   * загружен либо корп-функции недоступны (`enabled:false` — и транспортный сбой, подменяемый
   * `STATUS_UNAVAILABLE`, попадает сюда же). Третье значение обязано быть отдельным: пара
   * «Войти»/«Выйти» — одна позиция в ряду, и до ответа сервера рисовать в ней **любую** из двух
   * кнопок значит либо мигнуть неверной, либо соврать о состоянии входа.
   *
   * Признак — только наличие ключа. `hub_error` каталога им не является: в сборке со статическим
   * каталогом (S-C10) и при недоступном Hub каталог приходит **без** `hub_error`, и вход по нему
   * не предложился бы вовсе (то самое «после выхода приложение предлагает вход», S-A16).
   * Та же логика, тем же полем и с тем же третьим состоянием, — в TUI
   * (`packages/tui/src/component/corp/dialog-connectors.tsx`, `hidden: authenticated() !== …`).
   */
  const authenticated = createMemo(() => (status.data?.enabled === true ? status.data.authenticated : undefined))

  /** Вход выполнен — показывается «Выйти» (S-A16). */
  const signedIn = createMemo(() => authenticated() === true)

  /** Ключа нет — показывается «Войти» (S-A16, AC-287). */
  const signedOut = createMemo(() => authenticated() === false)

  /** Провайдер выключен личным конфигом пользователя, и сервер знает файл (S-C11 п.1). */
  const providerDisabled = createMemo(() => status.data?.provider_disabled)

  function confirmLogout() {
    dialog.push(() => <DialogCorpLogout hubConfigured={hubConfigured()} />)
  }

  function confirmProviderEnable(file: string) {
    dialog.push(() => <DialogProviderEnable file={file} />)
  }

  /**
   * S-D11: строка ведёт на страницу коннектора через `push`, а не `show`. `show` уничтожил бы
   * витрину со всем её состоянием, и возврат приводил бы пользователя не туда, откуда он ушёл.
   *
   * Модуль страницы подгружается по требованию — тем же приёмом, что экран входа: страница берёт
   * с витрины подписи статуса, и статический импорт в обе стороны замкнул бы модули в цикл.
   */
  async function openConnector(alias: string) {
    const module = await import("@/components/corp/dialog-connector")
    dialog.push(() => <module.DialogConnector alias={alias} />)
  }

  return (
    <CorpDialog
      title={language.t("corp.connectors.title")}
      description={language.t("corp.connectors.description", { connected: connected(), total: cards().length })}
      action={
        <div class="flex items-center gap-2">
          {/* AC-131: пользователь в заголовке — email, а при неизвестном email — `user_id`. */}
          <Show when={user()}>{(value) => <span class="text-12-regular text-text-weak">{value()}</span>}</Show>
          {/* S-C11 п.2: предупреждение живёт там, где видно следствие, и только пока держится
              состояние. Модальным окном оно не является и работу не прерывает: состояние создано
              пользователем сознательно, и приложение не вправе решать за него, что это ошибка. */}
          <Show when={providerDisabled()}>
            {(value) => (
              <div data-slot="corp-provider-warning" class="flex items-center gap-2">
                <span class="text-12-regular text-text-weak">
                  {language.t("corp.provider.disabledTitle", { file: value().file })}
                </span>
                <Button size="small" onClick={() => confirmProviderEnable(value().file)}>
                  {language.t("corp.provider.enable")}
                </Button>
              </div>
            )}
          </Show>
          {/* S-A16: «Войти» — когда ключа нет, «Выйти» — когда есть; одновременно никогда.
              Пока наличие ключа неизвестно (`authenticated()` — undefined), не показывается ни
              одна: обе ветви спрашивают признак явным сравнением, поэтому третье состояние не
              достаётся ни «Войти», ни «Выйти» и кнопка не мигает подменой при первом ответе. */}
          <Show
            when={signedIn()}
            fallback={
              <Show when={signedOut()}>
                <Button size="small" onClick={() => void openLogin()}>
                  {language.t("corp.connectors.login")}
                </Button>
              </Show>
            }
          >
            <Button size="small" variant="ghost" onClick={confirmLogout}>
              {language.t("corp.logout.action")}
            </Button>
          </Show>
          {/* D-53: иконкой показывается действие, которое ничего не меняет, доступно всегда и
              повторяется часто. Доступность краткости в жертву не приносится — `aria-label` и
              подсказка обязательны и локализованы, иначе кнопка исчезает не только с экрана, но и
              из скринридера. Иконка берётся из набора приложения, своего SVG корп-код не заводит. */}
          <IconButton
            icon="reset"
            size="small"
            variant="ghost"
            aria-label={language.t("corp.connectors.refresh")}
            title={language.t("corp.connectors.refresh")}
            onClick={() => void invalidate()}
          />
        </div>
      }
    >
      {/* Баннер, предупреждение, вкладки, шапка и пустое состояние в область прокрутки списка не
          входят и высоту окна не меняют (S-D6, S-D10) — раскладку задаёт `dialog-shell.css`. */}
      <div class="corp-connectors" data-empty={empty() ? "" : undefined}>
        <Show when={banner()}>
          {(value) => (
            <div data-slot="corp-connectors-banner" class="text-12-regular text-text-weak">
              {value()}
            </div>
          )}
        </Show>
        <Show when={partial()}>
          {(value) => (
            <div data-slot="corp-connectors-partial" class="text-12-regular text-text-weak">
              {value()}
            </div>
          )}
        </Show>

        {/* S-D6, S-V11: вкладки — единственный орган фильтрации витрины. При «Hub недоступен» и
            «Требуется вход» они не показываются: фильтровать нечего. */}
        <Show when={showTable()}>
          <TabsV2
            variant="pill"
            data-slot="corp-connectors-tabs"
            value={tab()}
            onChange={(value: string) => setTab(value as ConnectorsTab)}
          >
            <TabsV2.List>
              <TabsV2.Trigger value="all">{language.t(TAB_KEY.all)}</TabsV2.Trigger>
              <TabsV2.Trigger value="connected">{language.t(TAB_KEY.connected)}</TabsV2.Trigger>
            </TabsV2.List>
          </TabsV2>
        </Show>

        {/* S-D6: шапка таблицы и строки списка размечены одной сеткой `grid-template-columns`
            (`dialog-shell.css`); расхождение сеток — дефект, колонки перестают быть колонками. */}
        <Show when={showTable()}>
          <div data-slot="corp-connectors-header" class="text-12-regular text-text-weak">
            <span>{language.t("corp.connectors.columnName")}</span>
            <span>{language.t("corp.connectors.columnType")}</span>
            <span>{language.t("corp.connectors.columnStatus")}</span>
          </div>
        </Show>

        <List
          search={{ placeholder: language.t("corp.connectors.search"), autofocus: true }}
          emptyMessage={empty()?.text}
          loadingMessage={catalog.isLoading ? language.t("corp.connectors.title") : undefined}
          key={(card) => card?.alias ?? ""}
          items={visible()}
          filter={query()}
          onFilter={setQuery}
          // Отбор выполнен выше по правилам S-V11 — встроенный нечёткий поиск списка переупорядочил
          // бы результаты, а порядок строк обязан совпадать с порядком каталога Hub.
          skipFilter={() => true}
          onSelect={(card) => {
            if (!card) return
            void openConnector(card.alias)
          }}
        >
          {(card) => (
            <div data-slot="corp-connectors-row" class="w-full">
              {/* Имя показывается **один раз** (S-D6, ревизия 1.12): подпись `alias` второй строкой
                  убрана — она повторяла то же самое техническим именем и удваивала высоту строки,
                  мешая ровно тому сканированию, ради которого список делали плоским. `alias`
                  остаётся полем поиска (`matchesQuery`) и виден на странице коннектора (D-53).

                  Значок слева от имени (S-V22, ревизия 1.14): картинка каталога, а без неё —
                  монограмма на подложке цвета `icon_color` из того же каталога либо на нейтральной,
                  если цвет не назван. Он опознавательный, а не смысловой, поэтому скрыт от
                  скринридера: имя рядом говорит ровно то же. */}
              <div class="flex items-center gap-3 min-w-0">
                <ConnectorIcon title={card.title} icon={card.icon} color={card.icon_color} />
                <span class="text-14-regular text-text-strong truncate">{card.title}</span>
                {/* Бейдж «устаревший» живёт в колонке «Имя»: он про карточку, а не про
                    подключение (S-V18). */}
                <Show when={card.deprecated}>
                  <Tag>{language.t("corp.connectors.deprecated")}</Tag>
                </Show>
              </div>
              {/* S-V22 (решение заказчика от 30.08): в колонке — тип каталога, а без него `MCP`.
                  Бейдж способа подключения убран (решение заказчика от 01.09). */}
              <span data-slot="corp-type-cell">
                <span class="text-12-regular text-text-weak truncate">{connectorType(card)}</span>
              </span>
              {/* S-V18: у подключённого — галочка и подпись, у остальных состояний подпись без
                  значка. Текст в ячейке есть **всегда**: состояние читается и в чёрно-белой
                  печати, и при дальтонизме, а галочка и цвет его дублируют, а не заменяют. */}
              <span data-slot="corp-status-cell" data-tone={statusTone(card)}>
                <Show when={card.state === "connected"}>
                  <Icon name="check-small" size="small" data-slot="corp-status-check" />
                </Show>
                <span class="text-12-regular truncate">{language.t(statusKey(card))}</span>
              </span>
            </div>
          )}
        </List>

        {/* Пустое состояние вместе со своим действием: «Обновить» и «Войти» перезапрашивают каталог,
            «Показать все» переводит вкладку в «Все» и строку поиска не трогает — если список после
            сброса всё ещё пуст, причина в поиске, и это видно по непустому полю ввода (S-V12). */}
        <Show when={empty()}>
          {(state) => (
            <div data-slot="corp-connectors-empty">
              <span class="text-14-regular text-text-strong">{state().text}</span>
              <Show when={state().action === "login"}>
                <Button size="small" onClick={() => void openLogin()}>
                  {language.t("corp.connectors.login")}
                </Button>
              </Show>
              <Show when={state().action === "refresh"}>
                <Button size="small" variant="ghost" onClick={() => void invalidate()}>
                  {language.t("corp.connectors.refresh")}
                </Button>
              </Show>
              <Show when={state().action === "resetFilter"}>
                <Button size="small" variant="ghost" onClick={() => setTab("all")}>
                  {language.t("corp.connectors.resetFilter")}
                </Button>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </CorpDialog>
  )
}
