import { Component, createMemo, onCleanup, Show } from "solid-js"
import type { CorpCatalogCard, CorpPermissionModel } from "@opencode-ai/sdk/v2"
import { corpUserLabel } from "@opencode-ai/core/corp/constants"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tag } from "@opencode-ai/ui/tag"
import {
  connectErrorKey,
  corpErrorKey,
  useConnectorAction,
  useCorpCatalog,
  useCorpInvalidate,
  useCorpStatus,
} from "@/context/corp"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { CorpDialog } from "./dialog-shell"

/**
 * Витрина коннекторов для Desktop/web (S-D2, S-D6, S-D7, S-V6, S-V11, S-V12).
 *
 * Отдельный диалог, а не URL-маршрут: сегмент `/:dir` роутера перехватывает произвольные пути
 * (D-4). Группировка — по владельцу, порядок — как в каталоге Hub. Контейнер и габариты окна берутся
 * из `CorpDialog` — того же формата, что открытый у пользователя экран настроек (S-D6).
 */

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
 * собственным решением нельзя, поэтому подписи разные. Состояния 1 и 4 подписи не добавляют:
 * у первого её несёт статус, у второго — бейдж «Подключено» (S-V18).
 */
const STATE_KEY = {
  never: undefined,
  failed: "corp.connectors.neverConnected",
  lost: "corp.connectors.lost",
  disconnected: "corp.connectors.disconnected",
  connected: undefined,
} as const

/**
 * Пресеты карточки для экрана прав (S-V9): по одной строке таблицы на вид модели прав.
 *
 * `header_groups` — `readonly`/`readwrite` с локализованными названиями; `tool_filter` и `consent` —
 * имена ключей `presets` в порядке ответа Hub; неизвестный вид, отсутствующая или неразобранная
 * модель (S-V14) — пустой список: выбор недоступен, причина показывается отдельно.
 */
export function presetsFor(model: CorpPermissionModel | undefined): { value: string; labelKey?: string }[] {
  if (!model) return []
  if (model.kind === "header_groups")
    return [
      { value: "readonly", labelKey: "corp.preset.readonly" },
      { value: "readwrite", labelKey: "corp.preset.readwrite" },
    ]
  return Object.keys(model.presets).map((value) => ({ value }))
}

/**
 * Состав среза инструментов пресета (S-V9, вид `tool_filter`): имена и шаблоны как есть.
 * Для остальных видов список пуст — состав прав на экране не показывается.
 */
export function toolsFor(model: CorpPermissionModel | undefined, preset: string | undefined): string[] {
  if (!model || model.kind !== "tool_filter" || preset === undefined) return []
  return model.presets[preset]?.tools ?? []
}

const DialogConnectorPermissions: Component<{ card: CorpCatalogCard }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const action = useConnectorAction()

  const options = createMemo(() => presetsFor(props.card.permission_model))
  // Пресеты не предлагаются — вид модели прав клиенту неизвестен либо модель не разобрана (S-V9).
  const unavailable = createMemo(() => options().length === 0)
  const selected = createMemo(() => props.card.preset ?? options()[0]?.value)
  const tools = createMemo(() => toolsFor(props.card.permission_model, selected()))
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
        <Show when={unavailable()}>
          <div class="text-12-regular text-text-weak">{language.t("corp.connectors.permissionsUnavailable")}</div>
        </Show>
        <Show when={tools().length > 0}>
          <div class="flex flex-col gap-1">
            <div class="text-12-regular text-text-weak">
              {language.t("corp.connectors.toolsPreview", { preset: selected() ?? "" })}
            </div>
            <div class="text-14-regular text-text-base break-all">{tools().join(", ")}</div>
          </div>
        </Show>
        <Show when={groups().length > 0}>
          <div class="flex flex-col gap-1">
            {groups().map((group) => (
              <div class="flex items-center justify-between gap-x-3">
                <span class="text-14-regular text-text-base">{group.title}</span>
                <Show when={group.preset}>
                  <span class="text-12-regular text-text-weak">{group.preset}</span>
                </Show>
              </div>
            ))}
          </div>
        </Show>
        <Show when={always().length > 0}>
          <div class="flex flex-col gap-1">
            <div class="text-12-regular text-text-weak">{language.t("corp.connectors.always")}</div>
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

/**
 * Подтверждение действия «Убрать из списка» (S-V17).
 *
 * Действие удаляет данные из конфига и, в отличие от «Отключить», в один клик не отменяется,
 * поэтому спрашивается один раз явно; отмена не меняет ничего.
 */
const DialogForgetConnector: Component<{ card: CorpCatalogCard }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const action = useConnectorAction()

  return (
    <Dialog title={language.t("corp.connectors.forget")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.t("corp.connectors.forgetConfirm", { title: props.card.title })}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            disabled={action.isPending}
            onClick={() => {
              action.mutate({ kind: "forget", alias: props.card.alias })
              dialog.close()
            }}
          >
            {language.t("corp.connectors.forget")}
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
  const action = useConnectorAction()
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

  const cards = createMemo<CorpCatalogCard[]>(() => catalog.data?.servers ?? [])
  const connected = createMemo(() => cards().filter((card) => card.status === "connected").length)

  const banner = createMemo(() => {
    const data = catalog.data
    if (!data?.hub_error) return undefined
    if (data.hub_error === "unauthorized") return language.t("corp.connectors.needsLogin")
    if (!data.cached_at) return `${language.t("corp.connectors.hubDown")}: ${language.t(corpErrorKey(data.hub_error))}`
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

  const emptyMessage = createMemo(() => {
    const data = catalog.data
    if (!data) return language.t("corp.connectors.hubDown")
    if (data.hub_error === "unauthorized") return language.t("corp.connectors.needsLogin")
    if (data.hub_error) return `${language.t("corp.connectors.hubDown")}: ${language.t(corpErrorKey(data.hub_error))}`
    // Четвёртое состояние S-V12: Hub ответил, карточки были, но все отброшены разбором. Текст
    // обязан отличаться от «Каталог пуст» — это сообщение о дефекте клиента, а не правда о каталоге.
    if (dropped() > 0) return language.t("corp.empty.unparsed", { dropped: dropped() })
    return language.t("corp.connectors.empty")
  })

  async function openLogin() {
    const module = await import("@/components/corp/dialog-corp-login")
    dialog.show(() => <module.DialogCorpLogin />)
  }

  const needsLogin = createMemo(() => catalog.data?.hub_error === "unauthorized")

  /**
   * Подпись ошибки подключения (S-V19): объяснение своего класса плюс код ошибки как есть.
   * Класс есть у любой неудачи, включая `unknown`, поэтому необъяснённой ошибки не бывает (D-32).
   */
  function explain(card: CorpCatalogCard): string | undefined {
    if (!card.error_class && !card.error) return undefined
    const text = language.t(connectErrorKey(card.error_class), { code: card.error ?? "" })
    return card.error ? `${text} (${card.error})` : text
  }

  return (
    <CorpDialog
      title={language.t("corp.connectors.title")}
      description={language.t("corp.connectors.description", { connected: connected(), total: cards().length })}
      action={
        <div class="flex items-center gap-2">
          {/* AC-131: пользователь в заголовке — email, а при неизвестном email — `user_id`. */}
          <Show when={user()}>{(value) => <span class="text-12-regular text-text-weak">{value()}</span>}</Show>
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
      <Show when={banner()}>{(value) => <div class="px-3 pb-2 text-12-regular text-text-weak">{value()}</div>}</Show>
      <Show when={partial()}>{(value) => <div class="px-3 pb-2 text-12-regular text-text-weak">{value()}</div>}</Show>
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
            <div class="flex flex-col gap-0.5 min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate">{card.title}</span>
                {/* S-V18: признак подключения — отдельный положительный элемент того же средства и
                    размера, что бейдж «устаревший». Подписи мелким вспомогательным шрифтом для
                    этого недостаточно — именно она была единственным признаком в BUG-I4-010. */}
                <Show when={card.state === "connected"}>
                  <Tag class="corp-tag-connected">{language.t("corp.connectors.connected")}</Tag>
                </Show>
                {/* Подпись статуса сохраняется — бейдж её дополняет, а не заменяет (S-V18). */}
                <span class="text-12-regular text-text-weak">{language.t(STATUS_KEY[card.status])}</span>
                <Show when={STATE_KEY[card.state]}>
                  {(key) => <span class="text-12-regular text-text-weak">{language.t(key())}</span>}
                </Show>
                <Show when={card.deprecated}>
                  <Tag>{language.t("corp.connectors.deprecated")}</Tag>
                </Show>
                <Show when={card.preset}>
                  <span class="text-12-regular text-text-weak">{card.preset}</span>
                </Show>
              </div>
              {/* S-V19: ошибка подключения не остаётся голым кодом — рядом объяснение своего класса.
                  Предлагаемое действие показывается тем же элементом, которым оно выполняется
                  («Повторить»/«Подключить» и «Открыть в Hub»), отдельной кнопкой-советом — нет. */}
              <Show when={explain(card) || card.description}>
                <span class="text-12-regular text-text-weak truncate">{explain(card) ?? card.description}</span>
              </Show>
            </div>
            <div class="flex items-center gap-1 shrink-0" onClick={(event) => event.stopPropagation()}>
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
                  {/* S-V16: подпись действия в состоянии 3 — «Повторить»: попытка уже была, и
                      честнее это назвать; в состояниях 1 и 2 — «Подключить». Оба выполняют S-V7. */}
                  {language.t(card.actions.includes("reconnect") ? "corp.connectors.retry" : "corp.connectors.connect")}
                </Button>
              </Show>
              <Show when={card.actions.includes("permissions")}>
                {/* S-V9, строка 4: вид модели прав неизвестен или не разобран — действие видно,
                    но заблокировано, а рядом показана причина. Остальные действия работают. */}
                <Show when={!card.permission_model}>
                  <span class="text-12-regular text-text-weak truncate max-w-64">
                    {language.t("corp.connectors.permissionsUnavailable")}
                  </span>
                </Show>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={action.isPending || card.blocked || !card.permission_model}
                  onClick={() => dialog.push(() => <DialogConnectorPermissions card={card} />)}
                >
                  {language.t("corp.connectors.permissions")}
                </Button>
              </Show>
              {/* S-V8, S-V16: «Отключить» существует ровно в состоянии «Подключено» — набор действий
                  считает общий модуль corp/status.ts, оболочка его не пересчитывает. */}
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
              {/* S-V17: «Убрать из списка» — ровно в состоянии «Соединение потеряно»/«Отключено
                  вами». Остаётся доступной и на протухшем каталоге: она нужна пользователю именно
                  тогда, когда Hub недоступен. */}
              <Show when={card.actions.includes("forget")}>
                <Button
                  size="small"
                  variant="ghost"
                  disabled={action.isPending}
                  onClick={() => dialog.push(() => <DialogForgetConnector card={card} />)}
                >
                  {language.t("corp.connectors.forget")}
                </Button>
              </Show>
              <Show when={card.actions.includes("open_hub") && card.hub_url}>
                <a
                  class="text-12-regular text-text-weak underline whitespace-nowrap"
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
    </CorpDialog>
  )
}
