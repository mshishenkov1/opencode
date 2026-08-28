import { TextAttributes } from "@opentui/core"
import type { CorpCatalogCard, CorpCatalogView, CorpPermissionModel } from "@opencode-ai/sdk/v2"
import { connectorType, corpUserLabel } from "@opencode-ai/core/corp/constants"
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { connectErrorText, errorText, format, t } from "../../corp/i18n"
import { rememberTitles } from "../../corp/state"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { DialogConnectToken, methodUnavailableKey, revokeKey } from "./dialog-connect-token"
import { DialogCorpLogin } from "./dialog-corp-login"
import { DialogCorpLogout } from "./dialog-corp-logout"
import { DialogPermissions } from "./dialog-permissions"

/**
 * Витрина коннекторов для TUI (S-T6, S-T7, S-T10, S-V6, S-V11, S-V12, S-V16, S-V18, S-V22).
 *
 * Список карточек на штатном `DialogSelect`: строка — маркер подключения, название и «Тип»
 * (S-V22), `footer` — статус витрины цветами темы. Действия: `enter` — страница коннектора
 * (S-D11), `c` — подключить/повторить, `d` — отключить, `x` — убрать из списка, `p` — права,
 * `o` — открыть в Hub, `f` — вкладка фильтра, `r` — обновить каталог.
 *
 * Паритет с Desktop держится не договорённостью, а построением (S-T10): набор действий обе оболочки
 * получают из общего модуля `packages/opencode/src/corp/status.ts` и сами его не вычисляют. Клавиша
 * `d` действует только в состоянии «Подключено», `x` — только в состоянии «Соединение потеряно» /
 * «Отключено вами». Ревизия 1.10 переносит в терминал смысл, а не раскладку Desktop: колонок,
 * вкладок-«таблеток» и стека диалогов здесь нет — вкладка переключается клавишей и видна в
 * заголовке, а страница коннектора открывается `dialog.replace`.
 */

const STATUS_KEY = {
  connected: "status.connected",
  needs_auth: "status.needs_auth",
  not_connected: "status.not_connected",
  unavailable: "status.unavailable",
} as const

/**
 * Подписи состояний карточки (S-V16). Состояние 3 имеет две подписи при одном наборе действий:
 * путать поломку связи с собственным решением пользователя нельзя.
 */
const STATE_KEY = {
  never: undefined,
  failed: "connectors.neverConnected",
  lost: "connectors.lost",
  disconnected: "connectors.disconnected",
  connected: undefined,
} as const

/**
 * Маркер подключённой карточки в начале строки (S-T10, S-V18).
 *
 * Цвет и жирное начертание подписи статуса в монохромном терминале недоступны, поэтому признак
 * подключения обязан читаться символом. Ширина маркера одинакова у всех карточек — список не
 * разъезжается. Ревизия 1.10 роль маркера не меняет: переезд признака в колонку касается Desktop.
 */
const MARKER = { connected: "● ", other: "  " } as const

function Status(props: { card: CorpCatalogCard; busy: boolean }) {
  const { theme } = useTheme()
  if (props.busy) return <span style={{ fg: theme.textMuted }}>{t("connectors.authorizing")}</span>
  const color = {
    connected: theme.success,
    needs_auth: theme.warning,
    not_connected: theme.textMuted,
    unavailable: theme.error,
  }[props.card.status]
  const label = t(STATUS_KEY[props.card.status])
  const attributes = props.card.status === "connected" ? TextAttributes.BOLD : undefined
  // S-V16: подпись состояния идёт рядом со статусом — «Подключение не удалось» и «Соединение
  // потеряно» при одном и том же статусе витрины различаются только ею.
  const stateKey = STATE_KEY[props.card.state]
  const state = stateKey ? ` · ${t(stateKey)}` : ""
  // S-V19: ошибка показывается текстом своего класса, а не голым кодом.
  const explained = props.card.error_class ? ` · ${connectErrorText(props.card.error_class)}` : ""
  const suffix = props.card.deprecated ? ` · ${t("connectors.deprecated")}` : ""
  // S-V28 п.4 (микроревизия 1.13.1): у закрытой карточки причина названа там же, где статус, —
  // действие остаётся в списке неактивным, а «почему» пользователь читает, ничего не нажимая.
  const closed = connectDisabled(props.card) ? ` · ${connectDisabledText()}` : ""
  return (
    <span style={attributes === undefined ? { fg: color } : { fg: color, attributes }}>
      {label}
      {state}
      {explained}
      {suffix}
      {closed}
    </span>
  )
}

/**
 * Пресеты карточки для экрана прав (S-V9), по строке таблицы на вид модели прав.
 *
 * Пустой список — модель прав отсутствует, неизвестна или не разобрана (S-V14): выбор недоступен,
 * вместо экрана показывается причина. Вид `permission_groups` (S-V20) сюда не попадает: у него свой
 * экран, а пресеты остаются как деградация, когда словаря групп в карточке нет.
 */
export function presetOptions(model: CorpPermissionModel | undefined) {
  if (!model) return []
  if (model.kind === "header_groups") {
    const groups = model.groups.map((group) => `${group.title}${group.preset ? ` (${group.preset})` : ""}`).join(", ")
    const always = model.always?.length ? ` · ${model.always.join(", ")}` : ""
    return [
      { value: "readonly", title: t("preset.readonly"), description: groups + always },
      { value: "readwrite", title: t("preset.readwrite"), description: groups + always },
    ]
  }
  // `tool_filter`: имена пресетов в порядке ответа Hub, состав среза — списком инструментов как есть.
  if (model.kind === "tool_filter")
    return Object.entries(model.presets).map(([value, preset]) => ({
      value,
      title: value,
      description: preset.tools.join(", "),
    }))
  // `consent`: только имена пресетов — состав прав выбирается на экране согласия целевой системы.
  return Object.keys(model.presets).map((value) => ({ value, title: value }))
}

/**
 * Доступно ли действие на карточке (S-V6): набор действий считает сервер, клавиши витрины
 * повторяют его — как и кнопки в Desktop/web. Правило одно на витрину и на страницу коннектора.
 */
function allows(card: CorpCatalogCard | undefined, action: CorpCatalogCard["actions"][number]) {
  if (!card) return false
  if (action === "connect") return card.actions.includes("connect") || card.actions.includes("reconnect")
  return card.actions.includes(action)
}

/**
 * Задан ли адрес Hub в этой сборке (S-C10 п.7, D-43). Отсутствие поля означает «сборка с Hub»:
 * поведение до ревизии 1.11 не меняется ни в одной ветке. Признак вьюшный, а не карточный — он
 * один на весь экран и не зависит от того, какой источник ответил в этот раз.
 */
export function hubConfigured(view: CorpCatalogView | undefined) {
  return view?.hub_configured !== false
}

/** Подключение идёт через Hub-фасад, а Hub в сборке нет (S-V7, S-C10 п.8). */
export function connectNeedsHub(card: CorpCatalogCard) {
  return card.connect_needs_hub === true
}

/**
 * Подключение карточки закрыто программным запретом OAuth (S-V28 п.2, микроревизия 1.13.1).
 *
 * Признак приходит **из ответа роута**: TUI условия запрета у себя не повторяет и `connect_mode`
 * сам не вычисляет (S-V28 п.3, S-T12). Действие при этом из списка **не исчезает** — спрятанное
 * действие в терминале так же неотличимо от несуществующего, как и в Desktop.
 */
export function connectDisabled(card: CorpCatalogCard | undefined) {
  return card?.connect_mode_unavailable_code === "oauth_disabled"
}

/** Текст причины закрытого подключения — тот же, что у способа `oauth2` (D-62, S-I4). */
export function connectDisabledText() {
  return t(methodUnavailableKey("oauth_disabled"))
}

/**
 * Подключение выполняется формой ввода токена в самом приложении (S-V7 строка 1, S-V25):
 * браузер не открывается, Hub не участвует. Способ считает сервер и присылает полем `connect_mode`.
 */
export function connectDirect(card: CorpCatalogCard | undefined) {
  return card?.connect_mode === "direct"
}

/** Экран прав Hub-зависимого вида модели, а Hub в сборке нет (S-V9, S-C10 п.7). */
export function permissionsNeedHub(card: CorpCatalogCard) {
  return card.permissions_need_hub === true
}

/**
 * Вкладки фильтра витрины (S-V11); умолчание — «Все», между запусками выбор не сохраняется.
 *
 * Ревизия 1.12 убрала «Неподключённые»: у неё почти всегда тот же состав, что у «Все», и
 * различить их на глаз было нельзя. Оставшаяся пара отвечает на вопрос «чем я уже могу
 * пользоваться», а полный список остаётся вкладкой «Все».
 */
export const TABS = ["all", "connected"] as const
export type ConnectorTab = (typeof TABS)[number]

const TAB_KEY = {
  all: "connectors.tabAll",
  connected: "connectors.tabConnected",
} as const

/**
 * Пустое состояние вкладки (S-V12, состояние 5): «в этой вкладке пусто» — не «каталога нет».
 *
 * Ревизия 1.12 оставила пустых состояний пять: шестое исчезло вместе со вкладкой
 * «Неподключённые». Номера остальных не сдвинуты, их тексты и действия не изменены.
 */
const TAB_EMPTY_KEY = {
  all: undefined,
  connected: "empty.tabConnected",
} as const

/** Клавиша `f` идёт циклом «Все → Подключённые → Все» (S-T10, S-V11 ревизии 1.12). */
export function nextTab(tab: ConnectorTab): ConnectorTab {
  return TABS[(TABS.indexOf(tab) + 1) % TABS.length]!
}

/**
 * Видна ли карточка во вкладке (S-V11). «Подключённые» — состояние 4 таблицы S-V16, а не пересказ
 * таблицы статусов: вкладка отвечает на вопрос «чем я уже могу пользоваться». Определение
 * ревизией 1.12 не изменено — убрана только вкладка «Неподключённые».
 */
export function inTab(card: Pick<CorpCatalogCard, "state">, tab: ConnectorTab) {
  if (tab === "all") return true
  return card.state === "connected"
}

/**
 * Поиск витрины (S-V11): подстрока без учёта регистра по `title`, `alias`, `description`, `owner` и
 * «Типу» (S-V22). Поиск и вкладка перемножаются: строка видна, когда удовлетворяет обоим условиям.
 */
export function matches(card: CorpCatalogCard, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [card.title, card.alias, card.description, card.owner, card.type].some(
    (value) => typeof value === "string" && value.toLowerCase().includes(needle),
  )
}

/**
 * Обработчик закрытия экрана, который уводит пользователя на другой корп-экран.
 *
 * Два обстоятельства делают его не таким простым, как выглядит. Первое: `dialog.replace` сам зовёт
 * обработчик закрытия того экрана, что лежит в стеке, — без флага возврат вызвал бы сам себя.
 * Второе: обработчик `esc` считает новую длину стека **после** вызова, поэтому синхронный
 * `dialog.replace` внутри него закрыл бы диалог целиком; переход откладывается на микрозадачу — тем
 * же способом, каким это делает продолжение промиса в `openPermissions`.
 *
 * `suppress` гасит обработчик заранее: экран уходит своим ходом и возвращаться ему не нужно.
 */
function leaving(next: () => void) {
  let left = false
  return {
    done() {
      if (left) return
      left = true
      queueMicrotask(next)
    },
    suppress() {
      left = true
    },
  }
}

/**
 * Состояние витрины, которое обязан вернуть `esc` со страницы коннектора (S-D11, S-T10): выбранная
 * вкладка, строка поиска и выделенная строка.
 */
export interface ConnectorsRestore {
  tab: ConnectorTab
  query: string
  alias?: string
}

export function DialogConnectors(props: { restore?: ConnectorsRestore }) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()

  const event = useEvent()

  const [view, setView] = createSignal<CorpCatalogView>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal<string>()
  /** Подпись пользователя в заголовке витрины: email, а при неизвестном email — `user_id` (S-A13). */
  const [user, setUser] = createSignal<string>()
  /**
   * Есть ли ключ `magnit_prod` (S-A16). «Войти» показывается, когда ключа нет; «Выйти» — когда он
   * есть; одновременно — никогда: это одна позиция в ряду с двумя взаимоисключающими состояниями.
   */
  const [authenticated, setAuthenticated] = createSignal<boolean>()
  /**
   * Провайдер `magnit_prod` выключен личным конфигом пользователя (S-C11): предупреждение видно
   * там, где видно следствие, и **только** пока состояние держится. Файл считает сервер — второй
   * копии разбора слоёв конфига клиент не заводит.
   */
  const [providerDisabled, setProviderDisabled] = createSignal<string>()
  /**
   * Карточка под курсором: от её состояния зависит подпись `c` — «Повторить» в состоянии
   * «Соединение потеряно» и «Подключить» в состояниях «Не подключён» и «Подключение не удалось»
   * (S-T10, S-V16). Оболочка подпись выбирает, набор действий — нет.
   */
  const [current, setCurrent] = createSignal<CorpCatalogCard>()
  /** Вкладка фильтра и строка поиска: возврат со страницы коннектора обязан их сохранить (S-D11). */
  const [tab, setTab] = createSignal<ConnectorTab>(props.restore?.tab ?? "all")
  const [query, setQuery] = createSignal(props.restore?.query ?? "")

  async function loadUser() {
    const status = await sdk.client.corp.status().catch(() => undefined)
    const value = status?.data?.user
    setUser(value ? corpUserLabel(value) : undefined)
    setAuthenticated(status?.data?.authenticated)
    setProviderDisabled(status?.data?.provider_disabled?.file)
  }

  async function load(refresh = false) {
    setLoading(true)
    const result = await sdk.client.corp
      .catalog(refresh ? { refresh: "true" } : {})
      .catch(() => undefined)
    setLoading(false)
    const data = result?.data
    if (!data) {
      setView({ version: "", source: "cache", stale: true, servers: [], hub_error: "hub_unavailable" })
      return
    }
    rememberTitles(data.servers)
    setView(data)
  }

  /** Обновляет локальные статусы MCP, чтобы `/mcps` и витрина не разъезжались. */
  async function refreshMcp() {
    const status = await sdk.client.mcp.status().catch(() => undefined)
    if (status?.data) sync.set("mcp", status.data)
  }

  async function act(card: CorpCatalogCard, action: "connect" | "disconnect" | "forget") {
    if (busy()) return
    // S-T10: клавиша `d` вне состояния «Подключено» ничего не меняет — и говорит, почему:
    // молчаливое бездействие неотличимо от зависшего интерфейса.
    if (action === "disconnect" && !allows(card, "disconnect"))
      toast.show({ variant: "warning", message: t("connectors.notConnectedHint") })
    if (!allows(card, action)) return
    if (card.blocked && action === "connect") {
      toast.show({ variant: "warning", message: t("connectors.stale") })
      return
    }
    setBusy(card.alias)
    try {
      const result =
        action === "connect"
          ? await sdk.client.corp.connect({ alias: card.alias, preset: card.preset ?? "readonly" })
          : action === "forget"
            ? await sdk.client.corp.forget({ alias: card.alias })
            : await sdk.client.corp.disconnect({ alias: card.alias })
      const data = result?.data
      if (data?.hub_error) {
        // S-V17: отказ Hub локальные шаги не откатывает — предупреждение называет ровно это.
        const removed = data && "removed" in data && data.removed
        toast.show({
          variant: "warning",
          message: removed ? t("connectors.forgetHubFailed") : errorText(data.hub_error),
        })
      }
      // S-V27 п.2: исход отзыва выпущенного токена — закрытый набор из четырёх значений; `skipped`
      // не показывает ничего («звать было некого»), прочие три различимы попарно.
      if (data && "revoke" in data && data.revoke) {
        const key = revokeKey(data.revoke)
        if (key) toast.show({ variant: data.revoke === "revoked" ? "info" : "warning", message: t(key) })
      }
      if (data && "error" in data && data.error) {
        // S-V19: рядом с кодом ошибки — объяснение её класса и предлагаемое действие.
        const explained = "error_class" in data && data.error_class ? connectErrorText(data.error_class) : undefined
        toast.show({ variant: "error", message: explained ? `${explained} (${data.error})` : data.error })
      }
    } catch (error) {
      toast.show({ variant: "error", message: String(error) })
    } finally {
      setBusy(undefined)
      await refreshMcp()
      await load(true)
    }
    // Свежий каталог нужен и странице коннектора: она перерисовывает свою карточку по нему (S-D11).
    return view()
  }

  async function openPermissions(card: CorpCatalogCard, back: () => void) {
    if (!allows(card, "permissions")) return
    if (card.blocked) {
      toast.show({ variant: "warning", message: t("connectors.stale") })
      return
    }
    // S-V9, S-C10 п.7: подтверждение Hub-зависимых видов уходит в Hub, а его в этой сборке нет —
    // экран показывается заблокированным с названной причиной. Причина другая, чем у строки
    // «модель прав не поддерживается», поэтому и ключ другой.
    if (permissionsNeedHub(card)) {
      toast.show({ variant: "warning", message: t("connectors.permissionsNeedHub") })
      return
    }
    // S-V20: словарь групп — пятый вид модели прав, и у него свой экран. Деградация на прежний
    // выбор пресетов (S-V9) действует, когда словаря в карточке нет или он не разобрался.
    const groups = card.permission_groups
    if (groups && groups.groups.length > 0) {
      dialog.replace(() => <DialogPermissions card={card} />, leaving(back).done)
      return
    }
    const options = presetOptions(card.permission_model)
    if (options.length === 0) {
      // S-V9, строка 4: вид модели прав неизвестен или не разобран — экран прав не открывается,
      // пользователю называется причина. Остальные действия карточки работают как обычно.
      //
      // Микроревизия 1.11.1: причина одна, а совет «правами можно управлять в Hub» верен только
      // там, где Hub есть. Признак берётся тот же, которым определяется наличие действия
      // «Открыть в Hub» (S-V16, S-C10 п.7): сервер убирает `open_hub` из набора ровно тогда,
      // когда адрес Hub не задан. Второй проверки и второго чтения build-константы здесь нет.
      const reason = allows(card, "open_hub")
        ? t("connectors.permissionsUnavailable")
        : t("connectors.permissionsUnavailableNoHub")
      toast.show({ variant: "warning", message: reason })
      return
    }
    const preset = await new Promise<string | null>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title={`${t("connectors.presetTitle")}: ${card.title}`}
            options={options.map((option) => ({
              title: option.title,
              value: option.value,
              ...("description" in option && option.description ? { description: option.description } : {}),
            }))}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(null),
      )
    })
    if (preset === null) {
      back()
      return
    }
    const result = await sdk.client.corp.permissions({ alias: card.alias, preset }).catch(() => undefined)
    if (result?.data?.hub_error) toast.show({ variant: "warning", message: errorText(result.data.hub_error) })
    else if (result?.data?.reauth_required) toast.show({ variant: "info", message: t("connectors.reauth") })
    await refreshMcp()
    back()
  }

  /**
   * Подтверждение «Убрать из списка» (S-V17, S-T10): то же подтверждение, что в Desktop.
   * Действие удаляет запись из конфига и в один клик не отменяется; отмена не меняет ничего.
   */
  async function openForget(card: CorpCatalogCard, back: () => void) {
    if (!allows(card, "forget")) return
    const confirmed = await new Promise<boolean>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            // S-V17, 1.11.1: подтверждение называет коннектор и не обещает шага, которого в этой
            // сборке может не быть. Название — данные каталога (S-I6), подставляется в текст.
            title={format("connectors.forgetConfirm", { title: card.title })}
            options={[
              { title: t("connectors.forget"), value: true },
              { title: t("login.cancelled"), value: false },
            ]}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(false),
      )
    })
    if (!confirmed) {
      back()
      return
    }
    await act(card, "forget")
    // Записи больше нет — возвращаться на страницу удалённого коннектора некуда (S-V17).
    backToList()
  }

  /**
   * Вход по SSO (S-C5, S-C10 п.6). В сборке без Hub входить некуда: экран называет причину и не
   * шлёт запрос на незаданный адрес. Проверка живёт здесь, а не только в самом экране входа,
   * чтобы отказ был один и тот же, каким бы путём вход ни открыли.
   */
  function openLogin() {
    if (!hubConfigured(view())) {
      toast.show({ variant: "warning", message: t("login.needsHub") })
      return
    }
    dialog.replace(() => <DialogCorpLogin />)
  }

  /**
   * Возврат выключенного провайдера (S-C11, S-T11). Правит личный конфиг пользователя, поэтому
   * спрашивает подтверждение и называет файл, который будет изменён; отмена не меняет ничего.
   * Запись в слое, который приложение не правит, не трогается — ответ называет причину.
   */
  async function enableProvider(file: string) {
    const confirmed = await new Promise<boolean>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title={format("provider.enableConfirm", { file })}
            options={[
              { title: t("provider.enable"), value: true },
              { title: t("login.cancelled"), value: false },
            ]}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(false),
      )
    })
    if (!confirmed) {
      backToList()
      return
    }
    const result = await sdk.client.corp.providerEnable().catch(() => undefined)
    const data = result?.data
    if (data?.reason === "foreign_layer")
      toast.show({
        variant: "warning",
        message: format("provider.enableForeignLayer", { file: data.provider_disabled?.file ?? file }),
      })
    // Предупреждение исчезает потому, что исчезло состояние, а не потому что его закрыли (S-C11).
    await loadUser()
    backToList()
  }

  async function openHub(card: CorpCatalogCard) {
    if (!allows(card, "open_hub") || !card.hub_url) return
    const open = await import("open").then((module) => module.default)
    await open(card.hub_url).catch(() => {
      toast.show({ variant: "warning", message: card.hub_url! })
    })
  }

  /** Возврат на витрину с сохранённой вкладкой, строкой поиска и выделенной строкой (S-D11, S-T10). */
  function backToList(alias?: string) {
    const restore: ConnectorsRestore = {
      tab: tab(),
      query: query(),
      ...(alias === undefined ? {} : { alias }),
    }
    dialog.replace(() => <DialogConnectors restore={restore} />)
  }

  /**
   * Форма прямого подключения токеном (S-T12, S-V25) — тот же роут и то же тело, что в Desktop.
   * Экран открывается `dialog.replace`, как и прочие корп-экраны: стека диалогов в терминале нет.
   */
  function openConnectToken(card: CorpCatalogCard) {
    const exit = leaving(() => backToList(card.alias))
    dialog.replace(() => <DialogConnectToken card={card} onDone={exit.done} />, exit.done)
  }

  /**
   * Страница коннектора (S-D11) — `dialog.replace` вместо стека: стека диалогов в терминале нет
   * (S-T10). `esc` закрывает страницу и возвращает витрину тем же состоянием, из которого ушли.
   */
  function openConnector(card: CorpCatalogCard) {
    const exit = leaving(() => backToList(card.alias))
    dialog.replace(
      () => (
        <DialogConnector
          card={card}
          onBack={exit.done}
          onLeave={exit.suppress}
          act={act}
          forget={openForget}
          permissions={openPermissions}
          openHub={openHub}
          open={openConnector}
          connectToken={openConnectToken}
          notify={(message) => toast.show({ variant: "warning", message })}
        />
      ),
      exit.done,
    )
  }

  const options = createMemo<DialogSelectOption<CorpCatalogCard>[]>(() => {
    const data = view()
    if (!data) return []
    const active = busy()
    const filter = tab()
    const needle = query()
    // Порядок карточек — как в каталоге Hub (S-V11, I-1 R-A3); группировки по владельцу нет.
    return data.servers
      .filter((card) => inTab(card, filter) && matches(card, needle))
      .map((card) => {
        const type = connectorType(card)
        return {
          // S-T10: маркер в начале строки читается и в монохромном терминале, где цвет недоступен.
          title: `${card.state === "connected" ? MARKER.connected : MARKER.other}${card.title}`,
          value: card,
          // S-V22: «Тип» — в подписи строки; отдельной колонки в терминале нет (S-T10).
          ...(type === undefined ? {} : { description: type }),
          footer: <Status card={card} busy={active === card.alias} />,
        }
      })
  })

  /**
   * Возврат со страницы коннектора обязан вернуть и выделенную строку (S-D11). Выделение ставится
   * по alias: карточка после действия — уже другой объект.
   */
  let selectRef: DialogSelectRef<CorpCatalogCard> | undefined
  let restored = props.restore?.alias === undefined
  createEffect(() => {
    const list = options()
    if (restored) return
    const target = list.find((option) => option.value.alias === props.restore?.alias)
    if (!target) return
    restored = true
    const value = target.value
    setTimeout(() => selectRef?.moveTo(value), 0)
  })

  /**
   * Недоступный **источник** каталога (S-V12 п.3, S-C10, D-43): в сборке без Hub он называется
   * каталогом, а не Hub, и код ошибки к тексту не приписывается — расшифровки кодов говорят про
   * Hub, а в такой сборке это слово пользователю не показывается нигде.
   */
  function sourceDown() {
    const data = view()
    if (!hubConfigured(data)) return t("connectors.catalogUnavailable")
    return `${t("connectors.hubDown")} (${errorText(data?.hub_error)})`
  }

  const banner = createMemo(() => {
    const data = view()
    if (!data) return undefined
    if (data.hub_error === "unauthorized") return t("connectors.needsLogin")
    if (!data.hub_error) return undefined
    if (!data.cached_at) return sourceDown()
    const at = new Date(data.cached_at).toLocaleString()
    if (!hubConfigured(data)) return `${t("connectors.catalogUnavailable")} · ${at}`
    return `${t("connectors.hubDownCached")} ${at}`
  })

  /** Предупреждение о числе отброшенных карточек и выброшенных групп (S-V14 п.5, S-V20). */
  const partial = createMemo(() => {
    const dropped = view()?.dropped?.length ?? 0
    if (dropped === 0) return undefined
    if ((view()?.servers.length ?? 0) === 0) return undefined
    return format("connectors.partial", { dropped })
  })

  /**
   * Шесть пустых состояний витрины (S-V12). Первые четыре — про каталог целиком, пятое и шестое —
   * про вкладку: «в этой вкладке пусто» не то же самое, что «каталога нет», и действие у них другое.
   */
  const empty = createMemo(() => {
    const data = view()
    if (loading() || !data) return undefined
    if (data.hub_error === "unauthorized") return t("connectors.needsLogin")
    if (data.servers.length === 0) {
      // Состояние 3 (S-V12): называет недоступный источник каталога, а не Hub безусловно.
      if (data.hub_error) return sourceDown()
      const dropped = data.dropped?.length ?? 0
      if (dropped > 0) return format("empty.unparsed", { dropped })
      return t("connectors.empty")
    }
    const key = TAB_EMPTY_KEY[tab()]
    // Вкладка «Все»: пусто может быть только из-за поиска — своего состояния у этого случая нет.
    if (!key) return undefined
    return `${t(key)} · ${t("connectors.resetFilter")}`
  })

  /** Вкладки видны всегда, когда показан список; при «Hub недоступен» и «Требуется вход» — нет. */
  const tabsVisible = createMemo(() => {
    const data = view()
    if (!data) return false
    if (data.hub_error === "unauthorized") return false
    return data.servers.length > 0
  })

  onMount(() => {
    dialog.setSize("large")
    void load()
    void loadUser()
  })

  // S-V7 шаг 3 / AC-60: браузер открыть не удалось — показываем URL авторизации текстом,
  // ожидание callback при этом продолжается.
  onCleanup(
    event.on("mcp.browser.open.failed", (failed) => {
      toast.show({ variant: "warning", message: `${t("connectors.authorizing")}: ${failed.properties.url}` })
    }),
  )

  return (
    <DialogSelect
      title={t("connectors.title")}
      placeholder={t("connectors.search")}
      // S-D11, S-T10: возврат со страницы коннектора обязан вернуть и строку поиска — не только
      // отфильтрованный ею список. Поле ввода `DialogSelect` неуправляемое, поэтому прежний запрос
      // отдаётся ему начальным значением, а дальше строкой владеет само поле.
      initialFilter={props.restore?.query}
      ref={(value) => (selectRef = value)}
      onFilter={setQuery}
      skipFilter={true}
      titleView={
        <box flexDirection="row" justifyContent="space-between" flexGrow={1}>
          <box flexDirection="row" gap={2}>
            <text attributes={TextAttributes.BOLD} fg={theme.text}>
              {t("connectors.title")}
            </text>
            {/* S-V11: текущая вкладка видна в подписи списка — «таблеток» в терминале нет. */}
            <Show when={tabsVisible()}>
              <text fg={theme.accent}>{t(TAB_KEY[tab()])}</text>
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <Show when={partial()}>{(value) => <text fg={theme.warning}>{value()}</text>}</Show>
            <Show when={banner()}>{(value) => <text fg={theme.warning}>{value()}</text>}</Show>
            {/* S-C11: предупреждение стоит рядом с подписью пользователя и живёт, пока держится
                состояние; работу оно не прерывает — состояние создано пользователем сознательно. */}
            <Show when={providerDisabled()}>
              {(file) => <text fg={theme.warning}>{format("provider.disabledTitle", { file: file() })}</text>}
            </Show>
            {/* AC-131: пользователь в заголовке — email, а при неизвестном email — `user_id`. */}
            <Show when={user()}>{(value) => <text fg={theme.textMuted}>{value()}</text>}</Show>
          </box>
        </box>
      }
      emptyView={<text fg={theme.textMuted}>{empty() ?? ""}</text>}
      options={options()}
      onMove={(option) => setCurrent(option.value)}
      onSelect={(option) => openConnector(option.value)}
      actions={[
        {
          command: "dialog.corp.connect",
          // S-V16: «Повторить» в состоянии 3 честно называет, что попытка уже была.
          title: current()?.actions.includes("reconnect") ? t("connectors.retry") : t("connectors.connect"),
          // S-V28 п.4: у закрытой карточки строка действия остаётся в подвале и не выбирается, а
          // причина видна в статусе строки — прятать действие запрещено (микроревизия 1.13.1).
          disabled: (option) => !allows(option?.value, "connect") || connectDisabled(option?.value),
          onTrigger: (option) => {
            // S-V7 строка 1: прямой режим открывает форму ввода токена в самом приложении —
            // браузера в этом пути нет ни одного шага.
            if (connectDirect(option.value)) return openConnectToken(option.value)
            void act(option.value, "connect")
          },
        },
        {
          command: "dialog.corp.disconnect",
          title: t("connectors.disconnect"),
          disabled: (option) => !allows(option?.value, "disconnect"),
          onTrigger: (option) => void act(option.value, "disconnect"),
        },
        {
          command: "dialog.corp.forget",
          title: t("connectors.forget"),
          disabled: (option) => !allows(option?.value, "forget"),
          onTrigger: (option) => void openForget(option.value, () => backToList(option.value.alias)),
        },
        {
          command: "dialog.corp.permissions",
          title: t("connectors.permissions"),
          disabled: (option) => !allows(option?.value, "permissions"),
          onTrigger: (option) => void openPermissions(option.value, () => backToList(option.value.alias)),
        },
        {
          command: "dialog.corp.open_hub",
          title: t("connectors.openHub"),
          side: "right",
          // S-C10 п.7, D-43: без адреса Hub пункт не рисуется вовсе — заблокированный обещал бы,
          // что когда-нибудь заработает, а ссылка в никуда не заработает никогда. Набор действий
          // при этом считает сервер: `open_hub` уходит из `card.actions` там же.
          hidden: !allows(current(), "open_hub") || !current()?.hub_url,
          disabled: (option) => !allows(option?.value, "open_hub") || !option?.value.hub_url,
          onTrigger: (option) => void openHub(option.value),
        },
        {
          // S-V11: одна клавиша на обе вкладки; подпись называет ту, куда переключит нажатие.
          command: "dialog.corp.filter",
          title: t(TAB_KEY[nextTab(tab())]),
          side: "right",
          hidden: !tabsVisible(),
          onTrigger: () => setTab(nextTab(tab())),
        },
        {
          command: "dialog.corp.refresh",
          title: t("connectors.refresh"),
          side: "right",
          onTrigger: () => void load(true),
        },
        {
          // S-C11: действие живёт рядом с предупреждением и исчезает вместе с ним.
          command: "dialog.corp.provider_enable",
          title: t("provider.enable"),
          side: "right",
          hidden: providerDisabled() === undefined,
          onTrigger: () => void enableProvider(providerDisabled()!),
        },
        {
          command: "dialog.corp.login",
          title: t("connectors.login"),
          side: "right",
          // S-A16: видимость — по состоянию, а не по экрану. Нет ключа — «Войти».
          hidden: authenticated() !== false,
          onTrigger: () => openLogin(),
        },
        {
          // S-A16, S-T11: та же позиция и та же клавиша, что у «Войти», — второго ускорителя
          // выход не получает. Есть ключ — «Выйти»; вместе они не показываются никогда.
          command: "dialog.corp.logout",
          title: t("logout.action"),
          side: "right",
          hidden: authenticated() !== true,
          onTrigger: () => {
            // Экран выхода заменяет витрину — стека диалогов в терминале нет (S-T10), — поэтому
            // возврат на неё описывается здесь, как у страницы коннектора и экрана прав. Возврат
            // нужен обоим исходам, при которых экран входа не открывается: отмене (она не меняет
            // ни ключа, ни экрана, S-A16) и выходу в сборке без Hub (витрина продолжает работать
            // на статическом каталоге, S-T11). Уход на экран входа этот возврат гасит сам.
            const exit = leaving(() => backToList())
            dialog.replace(() => <DialogCorpLogout onLeave={exit.suppress} />, exit.done)
          },
        },
      ]}
    />
  )
}

/** Строка страницы коннектора: действие карточки либо возврат на витрину. */
type ConnectorRow =
  | "connect"
  /** Не действие, а причина его отсутствия: строка стоит там, где была бы «Подключить». */
  | "connect_needs_hub"
  | "permissions"
  | "disconnect"
  | "open_hub"
  | "forget"
  // S-V28 п.4 (микроревизия 1.13.1): строка действия «Подключить» у закрытой карточки — она
  // присутствует и не выбирается, а не исчезает из списка.
  | "connect_disabled"
  | "back"

export interface DialogConnectorProps {
  card: CorpCatalogCard
  /** `esc` и строка «Назад»: закрыть страницу и вернуть витрину (S-D11). */
  onBack: () => void
  /**
   * Уход со страницы своим ходом. Страница живёт в стеке с обработчиком закрытия, и любой её
   * собственный `dialog.replace` этот обработчик разбудил бы — предупреждаем его заранее.
   */
  onLeave: () => void
  act: (
    card: CorpCatalogCard,
    action: "connect" | "disconnect" | "forget",
  ) => Promise<CorpCatalogView | undefined>
  forget: (card: CorpCatalogCard, back: () => void) => Promise<void>
  permissions: (card: CorpCatalogCard, back: () => void) => Promise<void>
  openHub: (card: CorpCatalogCard) => Promise<void>
  open: (card: CorpCatalogCard) => void
  /** Форма прямого подключения токеном (S-T12): тот же экран, что открывает витрина. */
  connectToken: (card: CorpCatalogCard) => void
  /** Показ причины, по которой закрытое действие ничего не делает (S-V28 п.4). */
  notify: (message: string) => void
}

/**
 * Страница коннектора (S-D11, S-T10).
 *
 * Состав сверху вниз: заголовок с названием и бейджем «устаревший», описание карточки, свойства
 * «Тип» / «Владелец» / ссылка на документацию (отсутствующее поле строки не рисует), блок статуса с
 * объяснением ошибки по её классу (S-V19) и список действий по `card.actions` — тот же набор, что
 * на витрине, и та же семантика клавиш `c`/`d`/`x`/`p`/`o`.
 */
export function DialogConnector(props: DialogConnectorProps) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [card, setCard] = createSignal<CorpCatalogCard>(props.card)
  const [busy, setBusy] = createSignal(false)

  onMount(() => dialog.setSize("large"))

  /** Действие карточки: набор берётся из общего модуля, страница его не пересчитывает (S-T10). */
  async function run(action: "connect" | "disconnect") {
    if (busy()) return
    setBusy(true)
    const fresh = await props.act(card(), action)
    setBusy(false)
    const next = fresh?.servers.find((item) => item.alias === card().alias)
    if (next) setCard(next)
  }

  function select(row: ConnectorRow) {
    const value = card()
    if (row === "back") return props.onBack()
    // Строка причины — не действие: нажатие на неё ничего не делает, текст уже на экране.
    if (row === "connect_needs_hub") return
    // S-V28 п.4: нажатие на закрытое действие ничего не меняет — ни конфига, ни состояния — и
    // показывает ту же причину из словаря TUI, что стоит рядом со строкой.
    if (row === "connect_disabled") {
      props.notify(connectDisabledText())
      return
    }
    if (row === "connect" && connectDirect(value)) {
      // S-V7 строка 1: прямой режим — форма ввода токена в приложении, а не браузерный шаг.
      props.onLeave()
      return props.connectToken(value)
    }
    if (row === "open_hub") return void props.openHub(value)
    if (row === "permissions") {
      props.onLeave()
      return void props.permissions(value, () => props.open(value))
    }
    if (row === "forget") {
      props.onLeave()
      return void props.forget(value, () => props.open(value))
    }
    return void run(row)
  }

  const rows = createMemo<DialogSelectOption<ConnectorRow>[]>(() => {
    const value = card()
    const list: DialogSelectOption<ConnectorRow>[] = []
    if (allows(value, "connect"))
      list.push(
        connectDisabled(value)
          ? {
              // Действие остаётся на месте и с прежней подписью, а причина стоит рядом с ним —
              // в том же блоке, а не в другой части экрана (S-V28 п.4).
              title: t("connectors.connect"),
              value: "connect_disabled",
              description: connectDisabledText(),
            }
          : {
              title: value.actions.includes("reconnect") ? t("connectors.retry") : t("connectors.connect"),
              value: "connect",
            },
      )
    // S-V7, S-C10 п.8: подключение `mode:"facade"` идёт через Hub-фасад, и без адреса Hub его
    // выполнить нечем. Действие сервер из набора снял, а на его месте — там же, где была бы
    // строка «Подключить», а не в другой части экрана, — стоит причина недоступности.
    else if (connectNeedsHub(value)) list.push({ title: t("connectors.facadeNeedsHub"), value: "connect_needs_hub" })
    // S-D11: блок «Разрешения» — на странице, а не в строке витрины.
    if (allows(value, "permissions")) list.push({ title: t("permissions.title"), value: "permissions" })
    if (allows(value, "disconnect")) list.push({ title: t("connectors.disconnect"), value: "disconnect" })
    if (allows(value, "open_hub") && value.hub_url)
      list.push({ title: t("connectors.openHub"), value: "open_hub", description: value.hub_url })
    // S-V17: «Убрать из списка» — со своим подтверждением, правило не изменено.
    if (allows(value, "forget")) list.push({ title: t("connectors.forget"), value: "forget" })
    list.push({ title: t("connector.back"), value: "back" })
    return list
  })

  return (
    <DialogSelect
      title={props.card.title}
      renderFilter={false}
      skipFilter={true}
      locked={busy()}
      titleView={
        <Show when={card()} keyed>
          {(value) => (
            <box flexDirection="column" flexGrow={1}>
              <box flexDirection="row" gap={2}>
                {/* S-I6: название, описание, «Тип» и владелец — данные каталога, как есть. */}
                <text attributes={TextAttributes.BOLD} fg={theme.text}>
                  {value.title}
                </text>
                <Show when={value.deprecated}>
                  <text fg={theme.warning}>{t("connectors.deprecated")}</text>
                </Show>
              </box>
              <Show when={value.description}>
                {(description) => <text fg={theme.textMuted}>{description()}</text>}
              </Show>
              <Show when={connectorType(value)}>
                {(type) => <text fg={theme.textMuted}>{`${t("connector.type")}: ${type()}`}</text>}
              </Show>
              <Show when={value.owner}>
                {(owner) => <text fg={theme.textMuted}>{`${t("connector.owner")}: ${owner()}`}</text>}
              </Show>
              <Show when={value.docs_url}>
                {(docs) => <text fg={theme.textMuted}>{`${t("connector.docs")}: ${docs()}`}</text>}
              </Show>
              {/* S-V19: место показа объяснения ошибки — блок страницы, само правило не изменено. */}
              <text>
                <Status card={value} busy={false} />
              </text>
              <Show when={busy()}>
                <text fg={theme.textMuted}>{t("connectors.authorizing")}</text>
              </Show>
            </box>
          )}
        </Show>
      }
      options={rows()}
      onSelect={(option) => select(option.value)}
      footerHints={[{ title: t("connector.back"), label: "esc" }]}
      actions={[
        {
          command: "dialog.corp.connect",
          title: card().actions.includes("reconnect") ? t("connectors.retry") : t("connectors.connect"),
          disabled: () => !allows(card(), "connect") || connectDisabled(card()),
          onTrigger: () => (connectDirect(card()) ? select("connect") : void run("connect")),
        },
        {
          command: "dialog.corp.disconnect",
          title: t("connectors.disconnect"),
          disabled: () => !allows(card(), "disconnect"),
          onTrigger: () => void run("disconnect"),
        },
        {
          command: "dialog.corp.forget",
          title: t("connectors.forget"),
          disabled: () => !allows(card(), "forget"),
          onTrigger: () => select("forget"),
        },
        {
          command: "dialog.corp.permissions",
          title: t("connectors.permissions"),
          disabled: () => !allows(card(), "permissions"),
          onTrigger: () => select("permissions"),
        },
        {
          command: "dialog.corp.open_hub",
          title: t("connectors.openHub"),
          side: "right",
          // S-C10 п.7, D-43: без адреса Hub пункта нет — ни в списке строк, ни в подвале.
          hidden: !allows(card(), "open_hub") || !card().hub_url,
          disabled: () => !allows(card(), "open_hub") || !card().hub_url,
          onTrigger: () => select("open_hub"),
        },
      ]}
    />
  )
}
