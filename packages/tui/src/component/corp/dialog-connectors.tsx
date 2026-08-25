import { TextAttributes } from "@opentui/core"
import type { CorpCatalogCard, CorpCatalogView, CorpPermissionModel } from "@opencode-ai/sdk/v2"
import { corpUserLabel } from "@opencode-ai/core/corp/constants"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { connectErrorText, errorText, t } from "../../corp/i18n"
import { rememberTitles } from "../../corp/state"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { DialogCorpLogin } from "./dialog-corp-login"

/**
 * Витрина коннекторов для TUI (S-T6, S-T7, S-T10, S-V6, S-V11, S-V12, S-V16).
 *
 * Список карточек на штатном `DialogSelect`: `title` — название, `description` — описание и владелец,
 * `footer` — статус витрины цветами темы. Действия: `enter` — подключить/повторить, `d` —
 * отключить, `x` — убрать из списка, `p` — права, `o` — открыть в Hub, `r` — обновить каталог.
 *
 * Паритет с Desktop держится не договорённостью, а построением (S-T10): набор действий обе оболочки
 * получают из общего модуля `packages/opencode/src/corp/status.ts` и сами его не вычисляют. Клавиша
 * `d` действует только в состоянии «Подключено», `x` — только в состоянии «Соединение потеряно» /
 * «Отключено вами».
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
 * разъезжается.
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
  return (
    <span style={attributes === undefined ? { fg: color } : { fg: color, attributes }}>
      {label}
      {state}
      {explained}
      {suffix}
    </span>
  )
}

/**
 * Пресеты карточки для экрана прав (S-V9), по строке таблицы на вид модели прав.
 *
 * Пустой список — модель прав отсутствует, неизвестна или не разобрана (S-V14): выбор недоступен,
 * вместо экрана показывается причина.
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

export function DialogConnectors() {
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
   * Карточка под курсором: от её состояния зависит подпись `enter` — «Повторить» в состоянии
   * «Соединение потеряно» и «Подключить» в состояниях «Не подключён» и «Подключение не удалось»
   * (S-T10, S-V16). Оболочка подпись выбирает, набор действий — нет.
   */
  const [current, setCurrent] = createSignal<CorpCatalogCard>()

  async function loadUser() {
    const status = await sdk.client.corp.status().catch(() => undefined)
    const value = status?.data?.user
    setUser(value ? corpUserLabel(value) : undefined)
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

  /**
   * Доступно ли действие на карточке (S-V6): набор действий считает сервер, клавиши витрины
   * повторяют его — как и кнопки в Desktop/web.
   */
  function allows(card: CorpCatalogCard | undefined, action: CorpCatalogCard["actions"][number]) {
    if (!card) return false
    if (action === "connect") return card.actions.includes("connect") || card.actions.includes("reconnect")
    return card.actions.includes(action)
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
  }

  async function openPermissions(card: CorpCatalogCard) {
    if (!allows(card, "permissions")) return
    if (card.blocked) {
      toast.show({ variant: "warning", message: t("connectors.stale") })
      return
    }
    const options = presetOptions(card.permission_model)
    if (options.length === 0) {
      // S-V9, строка 4: вид модели прав неизвестен или не разобран — экран прав не открывается,
      // пользователю называется причина. Остальные действия карточки работают как обычно.
      toast.show({ variant: "warning", message: t("connectors.permissionsUnavailable") })
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
      dialog.replace(() => <DialogConnectors />)
      return
    }
    const result = await sdk.client.corp.permissions({ alias: card.alias, preset }).catch(() => undefined)
    if (result?.data?.hub_error) toast.show({ variant: "warning", message: errorText(result.data.hub_error) })
    else if (result?.data?.reauth_required) toast.show({ variant: "info", message: t("connectors.reauth") })
    await refreshMcp()
    dialog.replace(() => <DialogConnectors />)
  }

  /**
   * Подтверждение «Убрать из списка» (S-V17, S-T10): то же подтверждение, что в Desktop.
   * Действие удаляет запись из конфига и в один клик не отменяется; отмена не меняет ничего.
   */
  async function openForget(card: CorpCatalogCard) {
    if (!allows(card, "forget")) return
    const confirmed = await new Promise<boolean>((resolve) => {
      dialog.replace(
        () => (
          <DialogSelect
            title={t("connectors.forgetConfirm")}
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
      dialog.replace(() => <DialogConnectors />)
      return
    }
    await act(card, "forget")
    dialog.replace(() => <DialogConnectors />)
  }

  async function openHub(card: CorpCatalogCard) {
    if (!allows(card, "open_hub") || !card.hub_url) return
    const open = await import("open").then((module) => module.default)
    await open(card.hub_url).catch(() => {
      toast.show({ variant: "warning", message: card.hub_url! })
    })
  }

  const options = createMemo<DialogSelectOption<CorpCatalogCard>[]>(() => {
    const data = view()
    if (!data) return []
    const active = busy()
    // Порядок карточек и групп — как в каталоге Hub (S-V11, I-1 R-A3).
    return data.servers.map((card) => ({
      // S-T10: маркер в начале строки читается и в монохромном терминале, где цвет недоступен.
      title: `${card.state === "connected" ? MARKER.connected : MARKER.other}${card.title}`,
      value: card,
      description: [card.description, card.owner].filter(Boolean).join(" · ") || undefined,
      category: card.owner || undefined,
      footer: <Status card={card} busy={active === card.alias} />,
    }))
  })

  const banner = createMemo(() => {
    const data = view()
    if (!data) return undefined
    if (data.hub_error === "unauthorized") return t("connectors.needsLogin")
    if (!data.hub_error) return undefined
    if (!data.cached_at) return `${t("connectors.hubDown")} (${errorText(data.hub_error)})`
    return `${t("connectors.hubDownCached")} ${new Date(data.cached_at).toLocaleString()}`
  })

  const empty = createMemo(() => {
    const data = view()
    if (loading() || !data) return undefined
    if (data.servers.length > 0) return undefined
    if (data.hub_error === "unauthorized") return t("connectors.needsLogin")
    if (data.hub_error) return `${t("connectors.hubDown")} (${errorText(data.hub_error)})`
    return t("connectors.empty")
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
      titleView={
        <box flexDirection="row" justifyContent="space-between">
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {t("connectors.title")}
          </text>
          <box flexDirection="row" gap={2}>
            <Show when={banner()}>{(value) => <text fg={theme.warning}>{value()}</text>}</Show>
            {/* AC-131: пользователь в заголовке — email, а при неизвестном email — `user_id`. */}
            <Show when={user()}>{(value) => <text fg={theme.textMuted}>{value()}</text>}</Show>
          </box>
        </box>
      }
      emptyView={<text fg={theme.textMuted}>{empty() ?? ""}</text>}
      options={options()}
      onMove={(option) => setCurrent(option.value)}
      onSelect={() => {
        // Закрываем только по esc; действия — по клавишам ниже (как в dialog-mcp).
      }}
      actions={[
        {
          command: "dialog.corp.connect",
          // S-V16: «Повторить» в состоянии 3 честно называет, что попытка уже была.
          title: current()?.actions.includes("reconnect") ? t("connectors.retry") : t("connectors.connect"),
          disabled: (option) => !allows(option?.value, "connect"),
          onTrigger: (option) => void act(option.value, "connect"),
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
          onTrigger: (option) => void openForget(option.value),
        },
        {
          command: "dialog.corp.permissions",
          title: t("connectors.permissions"),
          disabled: (option) => !allows(option?.value, "permissions"),
          onTrigger: (option) => void openPermissions(option.value),
        },
        {
          command: "dialog.corp.open_hub",
          title: t("connectors.openHub"),
          side: "right",
          disabled: (option) => !allows(option?.value, "open_hub") || !option?.value.hub_url,
          onTrigger: (option) => void openHub(option.value),
        },
        {
          command: "dialog.corp.refresh",
          title: t("connectors.refresh"),
          side: "right",
          onTrigger: () => void load(true),
        },
        {
          command: "dialog.corp.login",
          title: t("connectors.login"),
          side: "right",
          hidden: view()?.hub_error !== "unauthorized",
          onTrigger: () => dialog.replace(() => <DialogCorpLogin />),
        },
      ]}
    />
  )
}
