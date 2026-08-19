import { TextAttributes } from "@opentui/core"
import type { CorpCatalogCard, CorpCatalogView, CorpPermissionModel } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { useEvent } from "../../context/event"
import { useSDK } from "../../context/sdk"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { errorText, t } from "../../corp/i18n"
import { rememberTitles } from "../../corp/state"
import { useDialog } from "../../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"
import { DialogCorpLogin } from "./dialog-corp-login"

/**
 * Витрина коннекторов для TUI (S-T6, S-T7, S-V6, S-V11, S-V12).
 *
 * Список карточек на штатном `DialogSelect`: `title` — название, `description` — описание и владелец,
 * `footer` — статус витрины цветами темы. Действия: `enter` — подключить/переподключить, `d` —
 * отключить, `p` — права, `o` — открыть в Hub, `r` — обновить каталог.
 */

const STATUS_KEY = {
  connected: "status.connected",
  needs_auth: "status.needs_auth",
  not_connected: "status.not_connected",
  unavailable: "status.unavailable",
} as const

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
  const suffix = props.card.deprecated ? ` · ${t("connectors.deprecated")}` : ""
  return (
    <span style={attributes === undefined ? { fg: color } : { fg: color, attributes }}>
      {label}
      {suffix}
    </span>
  )
}

/** Пресеты карточки для экрана прав (S-V9). */
export function presetOptions(model: CorpPermissionModel | undefined) {
  if (!model) return [{ value: "readonly", title: t("preset.readonly") }]
  if (model.kind === "header_groups") {
    const groups = model.groups.map((group) => `${group.title}${group.preset ? ` (${group.preset})` : ""}`).join(", ")
    const always = model.always?.length ? ` · ${model.always.join(", ")}` : ""
    return [
      { value: "readonly", title: t("preset.readonly"), description: groups + always },
      { value: "readwrite", title: t("preset.readwrite"), description: groups + always },
    ]
  }
  return Object.entries(model.presets).map(([value, title]) => ({ value, title }))
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

  async function act(card: CorpCatalogCard, action: "connect" | "disconnect") {
    if (busy()) return
    if (card.blocked && action === "connect") {
      toast.show({ variant: "warning", message: t("connectors.stale") })
      return
    }
    setBusy(card.alias)
    try {
      const result =
        action === "connect"
          ? await sdk.client.corp.connect({ alias: card.alias, preset: card.preset ?? "readonly" })
          : await sdk.client.corp.disconnect({ alias: card.alias })
      if (result?.data?.hub_error) {
        toast.show({ variant: "warning", message: errorText(result.data.hub_error) })
      }
      if (result?.data?.error) {
        toast.show({ variant: "error", message: result.data.error })
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
    if (card.blocked) {
      toast.show({ variant: "warning", message: t("connectors.stale") })
      return
    }
    const options = presetOptions(card.permission_model)
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

  async function openHub(card: CorpCatalogCard) {
    if (!card.hub_url) return
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
      title: card.title,
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
          <Show when={banner()}>{(value) => <text fg={theme.warning}>{value()}</text>}</Show>
        </box>
      }
      emptyView={<text fg={theme.textMuted}>{empty() ?? ""}</text>}
      options={options()}
      onSelect={() => {
        // Закрываем только по esc; действия — по клавишам ниже (как в dialog-mcp).
      }}
      actions={[
        {
          command: "dialog.corp.connect",
          title: t("connectors.connect"),
          onTrigger: (option) => void act(option.value, "connect"),
        },
        {
          command: "dialog.corp.disconnect",
          title: t("connectors.disconnect"),
          onTrigger: (option) => void act(option.value, "disconnect"),
        },
        {
          command: "dialog.corp.permissions",
          title: t("connectors.permissions"),
          onTrigger: (option) => void openPermissions(option.value),
        },
        {
          command: "dialog.corp.open_hub",
          title: t("connectors.openHub"),
          side: "right",
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
