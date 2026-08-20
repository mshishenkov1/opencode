import { Component, createMemo, onCleanup, Show } from "solid-js"
import type { CorpCatalogCard, CorpPermissionModel } from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import { corpErrorKey, useConnectorAction, useCorpCatalog, useCorpInvalidate } from "@/context/corp"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"

/**
 * Витрина коннекторов для Desktop/web (S-D2, S-D6, S-D7, S-V6, S-V11, S-V12).
 *
 * Полноэкранный диалог, а не URL-маршрут: сегмент `/:dir` роутера перехватывает произвольные пути
 * (D-4). Группировка — по владельцу, порядок — как в каталоге Hub.
 */

const STATUS_KEY = {
  connected: "corp.status.connected",
  needs_auth: "corp.status.needs_auth",
  not_connected: "corp.status.not_connected",
  unavailable: "corp.status.unavailable",
} as const

/** Пресеты карточки для экрана прав (S-V9). */
export function presetsFor(model: CorpPermissionModel | undefined): { value: string; labelKey?: string }[] {
  if (!model) return [{ value: "readonly", labelKey: "corp.preset.readonly" }]
  if (model.kind === "header_groups")
    return [
      { value: "readonly", labelKey: "corp.preset.readonly" },
      { value: "readwrite", labelKey: "corp.preset.readwrite" },
    ]
  return Object.keys(model.presets).map((value) => ({ value }))
}

const DialogConnectorPermissions: Component<{ card: CorpCatalogCard }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const action = useConnectorAction()

  const options = createMemo(() => presetsFor(props.card.permission_model))
  const groups = createMemo(() => {
    const model = props.card.permission_model
    return model?.kind === "header_groups" ? model.groups : []
  })
  const always = createMemo(() => {
    const model = props.card.permission_model
    return model?.kind === "header_groups" ? (model.always ?? []) : []
  })

  return (
    <Dialog title={language.t("corp.connectors.presetTitle", { title: props.card.title })}>
      <div class="px-3 pb-3 flex flex-col gap-4">
        <Show when={groups().length > 0}>
          <div class="flex flex-col gap-1">
            {groups().map((group) => (
              <div class="flex items-center justify-between gap-x-3">
                <span class="text-14-regular text-text-base">{group.title}</span>
                <Show when={group.preset}>
                  <span class="text-11-regular text-text-weaker">{group.preset}</span>
                </Show>
              </div>
            ))}
          </div>
        </Show>
        <Show when={always().length > 0}>
          <div class="flex flex-col gap-1">
            <div class="text-11-regular text-text-weaker">{language.t("corp.connectors.always")}</div>
            <div class="text-14-regular text-text-base break-all">{always().join(", ")}</div>
          </div>
        </Show>
        <div class="flex items-center gap-2">
          {options().map((option) => (
            <Button
              size="large"
              variant={props.card.preset === option.value ? "primary" : "ghost"}
              disabled={action.isPending}
              onClick={() => {
                action.mutate({ kind: "permissions", alias: props.card.alias, preset: option.value })
                dialog.close()
              }}
            >
              {option.labelKey ? language.t(option.labelKey as "corp.preset.readonly") : option.value}
            </Button>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

export const DialogConnectors: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const invalidate = useCorpInvalidate()
  const action = useConnectorAction()
  const catalog = useCorpCatalog(() => true)
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

  const cards = createMemo<CorpCatalogCard[]>(() => catalog.data?.servers ?? [])
  const connected = createMemo(() => cards().filter((card) => card.status === "connected").length)

  const banner = createMemo(() => {
    const data = catalog.data
    if (!data?.hub_error) return undefined
    if (data.hub_error === "unauthorized") return language.t("corp.connectors.needsLogin")
    if (!data.cached_at) return `${language.t("corp.connectors.hubDown")}: ${language.t(corpErrorKey(data.hub_error))}`
    return language.t("corp.connectors.hubDownCached", { at: new Date(Number(data.cached_at)).toLocaleString() })
  })

  const emptyMessage = createMemo(() => {
    const data = catalog.data
    if (!data) return language.t("corp.connectors.hubDown")
    if (data.hub_error === "unauthorized") return language.t("corp.connectors.needsLogin")
    if (data.hub_error) return `${language.t("corp.connectors.hubDown")}: ${language.t(corpErrorKey(data.hub_error))}`
    return language.t("corp.connectors.empty")
  })

  async function openLogin() {
    const module = await import("@/components/corp/dialog-corp-login")
    dialog.show(() => <module.DialogCorpLogin />)
  }

  const needsLogin = createMemo(() => catalog.data?.hub_error === "unauthorized")

  return (
    <Dialog
      title={language.t("corp.connectors.title")}
      description={language.t("corp.connectors.description", { connected: connected(), total: cards().length })}
      size="x-large"
      action={
        <div class="flex items-center gap-2">
          <Show when={needsLogin()}>
            <Button size="small" onClick={() => void openLogin()}>
              {language.t("corp.connectors.login")}
            </Button>
          </Show>
          <Button size="small" variant="ghost" onClick={() => void invalidate()}>
            {language.t("corp.connectors.refresh")}
          </Button>
        </div>
      }
    >
      <Show when={banner()}>{(value) => <div class="px-3 pb-2 text-11-regular text-text-weaker">{value()}</div>}</Show>
      <List
        class="px-3"
        search={{ placeholder: language.t("corp.connectors.search"), autofocus: true }}
        emptyMessage={emptyMessage()}
        loadingMessage={catalog.isLoading ? language.t("corp.connectors.title") : undefined}
        key={(card) => card?.alias ?? ""}
        items={cards}
        filterKeys={["alias", "title", "description", "owner"]}
        groupBy={(card) => card.owner ?? ""}
        onSelect={(card) => {
          if (!card || action.isPending) return
          if (!card.actions.includes("connect") && !card.actions.includes("reconnect")) return
          action.mutate({ kind: "connect", alias: card.alias, ...(card.preset ? { preset: card.preset } : {}) })
        }}
      >
        {(card) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <div class="flex flex-col gap-0.5 min-w-0">
              <div class="flex items-center gap-2">
                <span class="truncate">{card.title}</span>
                <span class="text-11-regular text-text-weaker">{language.t(STATUS_KEY[card.status])}</span>
                <Show when={card.deprecated}>
                  <Tag>{language.t("corp.connectors.deprecated")}</Tag>
                </Show>
                <Show when={card.preset}>
                  <span class="text-11-regular text-text-weaker">{card.preset}</span>
                </Show>
              </div>
              <Show when={card.description || card.error}>
                <span class="text-11-regular text-text-weaker truncate">{card.error ?? card.description}</span>
              </Show>
            </div>
            <div class="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
              <Show when={card.actions.includes("connect") || card.actions.includes("reconnect")}>
                <Button
                  size="small"
                  disabled={action.isPending || card.blocked}
                  onClick={() =>
                    action.mutate({
                      kind: "connect",
                      alias: card.alias,
                      ...(card.preset ? { preset: card.preset } : {}),
                    })
                  }
                >
                  {language.t(
                    card.actions.includes("reconnect") ? "corp.connectors.reconnect" : "corp.connectors.connect",
                  )}
                </Button>
              </Show>
              <Show when={card.actions.includes("permissions")}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={action.isPending || card.blocked}
                  onClick={() => dialog.push(() => <DialogConnectorPermissions card={card} />)}
                >
                  {language.t("corp.connectors.permissions")}
                </Button>
              </Show>
              <Show when={card.actions.includes("disconnect")}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={action.isPending}
                  onClick={() => action.mutate({ kind: "disconnect", alias: card.alias })}
                >
                  {language.t("corp.connectors.disconnect")}
                </Button>
              </Show>
              <Show when={card.actions.includes("open_hub") && card.hub_url}>
                <a
                  class="text-11-regular text-text-weaker underline"
                  href={card.hub_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {language.t("corp.connectors.openHub")}
                </a>
              </Show>
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
