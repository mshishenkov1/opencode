import { Component, createMemo, createSignal, For, Show } from "solid-js"
import type { CorpCatalogCard, CorpPermissionMode, CorpPermissionModel, CorpPermissionState } from "@opencode-ai/sdk/v2"
import { connectorType } from "@opencode-ai/core/corp/constants"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tag } from "@opencode-ai/ui/tag"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import { connectErrorKey, useConnectorAction, useCorpCatalog } from "@/context/corp"
import { useLanguage } from "@/context/language"
import { statusKey, statusTone } from "./dialog-connectors"
import { CorpDialog } from "./dialog-shell"

/**
 * Страница коннектора (S-D11, ревизия 1.10).
 *
 * Открывается со строки витрины через `useDialog().push`: витрина остаётся в стеке живой, поэтому
 * возврат (`Esc` или «Назад») приводит пользователя ровно туда, откуда он ушёл — с той же вкладкой,
 * той же строкой поиска и той же позицией прокрутки. `show` уничтожил бы её вместе с состоянием.
 *
 * Состав сверху вниз: заголовок с `title` и бейджем «устаревший», описание карточки, свойства
 * (тип, владелец, документация), статус с объяснением ошибки и предлагаемым действием (S-V19),
 * блок «Разрешения» (S-V9) и блок «Убрать из списка» (S-V17). Размер окна страница получает от
 * `CorpDialog`, ничего про размеры не зная (S-D10); прокручивается содержимое, а не окно.
 */

/** Идентификатор группы «Остальное» в словаре и в `permission_state` (S-V20, S-V23). */
const REST_GROUP_ID = "rest"

/** Режим по умолчанию, когда его не задали ни каталог, ни конфиг (S-V20): неизвестное спрашивает. */
const DEFAULT_MODE: CorpPermissionMode = "ask"

const MODES: CorpPermissionMode[] = ["allow", "ask", "deny"]

const MODE_KEY = {
  allow: "corp.permissions.allow",
  ask: "corp.permissions.ask",
  deny: "corp.permissions.deny",
} as const

/** Подписи группового селектора (S-V23): он ставит режим всем группам сразу, отсюда и «всё». */
const BULK_KEY = {
  allow: "corp.permissions.allowAll",
  ask: "corp.permissions.ask",
  deny: "corp.permissions.denyAll",
} as const

/**
 * Пресеты карточки для прежнего экрана прав (S-V9): по одной строке таблицы на вид модели прав.
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

/** Строка экрана разрешений: группа словаря либо «Остальное» (S-V20). */
interface PermissionRow {
  id: string
  title: string
  description: string
  /** `default` каталога — им пользуемся, только если действующего режима у группы нет (S-V23). */
  fallback: CorpPermissionMode
}

/**
 * Действующий режим строки (S-V23): считает его сервер и присылает в `permission_state`, клиент
 * не пересчитывает. `mixed` — не режим, а признак разнобоя: ни один сегмент не выбран, и в
 * сохраняемый набор такая группа не попадает (тогда запись возьмёт `default` каталога, S-V21).
 */
export function rowMode(state: CorpPermissionState | undefined, row: PermissionRow): CorpPermissionMode | undefined {
  const value = state?.[row.id]
  if (value === "allow" || value === "ask" || value === "deny") return value
  if (value === "mixed") return undefined
  return row.fallback
}

/**
 * Есть ли что показывать в ряду действий (S-C10 п.7–8).
 *
 * В сборке без Hub карточка `mode:"facade"` теряет и «Подключить», и «Открыть в Hub»: набор
 * действий становится пустым, и ряд не рисуется вовсе — пустой flex-контейнер с отступами оставил
 * бы на экране полосу, за которой ничего нет. Причина недоступности при этом всё равно видна:
 * `connect_needs_hub` сам по себе делает ряд непустым.
 */
export function hasActions(card: CorpCatalogCard): boolean {
  if (card.connect_needs_hub) return true
  if (card.actions.includes("connect") || card.actions.includes("reconnect")) return true
  if (card.actions.includes("disconnect")) return true
  return card.actions.includes("open_hub") && !!card.hub_url
}

/**
 * Агрегат группового селектора (S-V23): одинаковый режим у всех групп — этот режим, иначе
 * «Смешанно». «Смешанно» — только отображаемое значение.
 */
export function aggregateMode(modes: (CorpPermissionMode | undefined)[]): CorpPermissionMode | "mixed" {
  const first = modes[0]
  if (first === undefined || modes.length === 0) return "mixed"
  return modes.every((mode) => mode === first) ? first : "mixed"
}

/**
 * Ключ причины для последней строки таблицы S-V9 — «модель прав не разобрана» (микроревизия 1.11.1).
 *
 * Текст ревизии 1.7 заканчивается советом «правами можно управлять в Hub». В сборке без Hub это
 * совет пойти туда, чего у пользователя нет (D-43), поэтому там показывается та же причина без
 * совета. Заменяется **только** совет: сообщение о деградации разбора (S-V14) остаётся видимым —
 * оно про дефект данных, а не про Hub.
 *
 * Признак — тот же, которым определяется наличие действия `open_hub` (S-V16, S-C10 п.7): сервер
 * убирает `open_hub` из наборов ровно при незаданном адресе Hub и тем же значением заполняет
 * `hub_configured` вьюшки. Оболочка берёт его из данных и build-константу второй раз не читает.
 */
export function permissionsUnavailableKey(hubConfigured: boolean) {
  return hubConfigured ? "corp.connectors.permissionsUnavailable" : "corp.connectors.permissionsUnavailableNoHub"
}

/**
 * Прежний экран пресетов (S-V9) — деградация для видов модели прав, отличных от `permission_groups`
 * (S-V20). Содержимое общее у страницы коннектора и у отдельного окна `DialogConnectorPermissions`.
 */
const ConnectorPresets: Component<{ card: CorpCatalogCard; hubConfigured: boolean; onApplied?: () => void }> = (
  props,
) => {
  const language = useLanguage()
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
    <div class="flex flex-col gap-4">
      {/* S-V9, строка 5: вид модели прав неизвестен или не разобран — выбор заблокирован, причина
          названа; «Открыть в Hub», «Подключить» и «Отключить» при этом работают как обычно. */}
      <Show when={unavailable()}>
        <div class="text-12-regular text-text-weak">
          {language.t(permissionsUnavailableKey(props.hubConfigured))}
        </div>
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
          <For each={groups()}>
            {(group) => (
              <div class="flex items-center justify-between gap-x-3">
                {/* Заголовок группы — данные каталога, клиент его не переводит (S-I6). */}
                <span class="text-14-regular text-text-strong">{group.title}</span>
                <Show when={group.preset}>
                  <span class="text-12-regular text-text-weak">{group.preset}</span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={always().length > 0}>
        <div class="flex flex-col gap-1">
          <div class="text-12-regular text-text-weak">{language.t("corp.connectors.always")}</div>
          <div class="text-14-regular text-text-base break-all">{always().join(", ")}</div>
        </div>
      </Show>
      <div class="flex items-center gap-2">
        <For each={options()}>
          {(option) => (
            <Button
              size="large"
              variant={props.card.preset === option.value ? "primary" : "ghost"}
              disabled={action.isPending || props.card.blocked}
              onClick={() => {
                action.mutate({ kind: "permissions", alias: props.card.alias, preset: option.value })
                props.onApplied?.()
              }}
            >
              {option.labelKey ? language.t(option.labelKey as "corp.preset.readonly") : option.value}
            </Button>
          )}
        </For>
      </div>
    </div>
  )
}

/**
 * Прежний экран прав отдельным окном (S-V9, S-D10).
 *
 * Ревизия 1.10 переводит его на `CorpDialog`: «как настройки» — свойство контейнера, а не
 * отдельного экрана (D-33), и экран прав получает правильный размер, ничего про размеры не зная.
 */
export const DialogConnectorPermissions: Component<{ card: CorpCatalogCard }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const catalog = useCorpCatalog(() => true)

  return (
    <CorpDialog title={language.t("corp.connectors.presetTitle", { title: props.card.title })}>
      <div class="corp-connector">
        <ConnectorPresets
          card={props.card}
          hubConfigured={catalog.data?.hub_configured !== false}
          onApplied={() => dialog.close()}
        />
      </div>
    </CorpDialog>
  )
}

/**
 * Подтверждение действия «Убрать из списка» (S-V17).
 *
 * Действие удаляет данные из конфига и, в отличие от «Отключить», в один клик не отменяется,
 * поэтому спрашивается один раз явно; отмена не меняет ничего.
 */
export const DialogForgetConnector: Component<{ card: CorpCatalogCard }> = (props) => {
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

/**
 * Блок «Разрешения» вида `permission_groups` (S-V9, S-V20, S-V21, S-V23).
 *
 * Групповой селектор ставит режим **всем** группам сразу, включая «Остальное»; сегментированный
 * переключатель строки — режим одной группы. И то и другое уходит одной перезаписью блока alias
 * (S-V21): сервер получает режимы всех групп, а не одну правку, потому что запись детерминирована
 * и инкрементальная правка отдельных ключей запрещена.
 */
const ConnectorPermissionGroups: Component<{ card: CorpCatalogCard }> = (props) => {
  const language = useLanguage()
  const action = useConnectorAction()

  /**
   * Ответ роута прав — источник истины сразу после записи (S-V23): он посчитан по конфигу, каким
   * тот стал. До первой записи и после инвалидации каталога состояние приходит с карточкой.
   */
  const [applied, setApplied] = createSignal<CorpPermissionState | undefined>()
  const state = createMemo(() => applied() ?? props.card.permission_state)

  const rows = createMemo<PermissionRow[]>(() => {
    const dictionary = props.card.permission_groups
    if (!dictionary) return []
    const rest = dictionary.rest
    return [
      // Порядок групп на экране — порядок массива `groups` каталога (S-V20).
      ...dictionary.groups.map((group) => ({
        // `title` и `description` — данные каталога и рендерятся как есть (S-I6).
        id: group.id,
        title: group.title,
        description: group.description ?? "",
        fallback: group.default ?? DEFAULT_MODE,
      })),
      // «Остальное» всегда последней, пришла она из каталога или нет (S-V20). Тексты берутся из
      // словаря клиента — единственное место, где тексты групп не из каталога.
      {
        id: REST_GROUP_ID,
        title: rest?.title ?? language.t("corp.permissions.restTitle"),
        description: rest?.description ?? language.t("corp.permissions.restDescription"),
        fallback: rest?.default ?? DEFAULT_MODE,
      },
    ]
  })

  const aggregate = createMemo(() => aggregateMode(rows().map((row) => rowMode(state(), row))))

  const bulkOptions = createMemo(() => {
    const options = MODES.map((mode) => ({ value: mode as string, label: language.t(BULK_KEY[mode]) }))
    // «Смешанно» показывается, только пока режимы расходятся, и исчезает, как только выбран любой
    // из трёх режимов; выбрать его нельзя — это отображаемое значение, а не команда (S-V23).
    if (aggregate() === "mixed") options.push({ value: "mixed", label: language.t("corp.permissions.mixed") })
    return options
  })

  /**
   * Набор режимов для записи (S-V21): в теле идут **все** группы, а не одна изменённая. Группа,
   * которой в наборе нет, получает `default` каталога, поэтому «отправить только правку» значило
   * бы молча сбросить все прежние решения пользователя. Группа в состоянии `mixed` в набор не
   * попадает намеренно: конкретного режима у неё нет, и запись возьмёт для неё `default`.
   */
  function modesWith(override: Record<string, CorpPermissionMode>): Record<string, CorpPermissionMode> {
    const modes: Record<string, CorpPermissionMode> = {}
    for (const row of rows()) {
      const mode = rowMode(state(), row)
      if (mode) modes[row.id] = mode
    }
    return { ...modes, ...override }
  }

  async function apply(override: Record<string, CorpPermissionMode>) {
    try {
      const result = await action.mutateAsync({
        kind: "permissionModes",
        alias: props.card.alias,
        modes: modesWith(override),
      })
      if (result && "permission_state" in result && result.permission_state) setApplied(result.permission_state)
    } catch {
      // Отказ роута уже объяснён тостом `onError` мутации: молчаливой неудачи здесь не бывает.
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3">
        <span class="text-12-regular text-text-weak">{language.t("corp.permissions.title")}</span>
        <SelectV2
          appearance="inline"
          data-action="corp-permissions-bulk"
          options={bulkOptions()}
          placement="bottom-end"
          gutter={6}
          disabled={action.isPending || props.card.blocked}
          current={bulkOptions().find((option) => option.value === aggregate())}
          value={(option) => option.value}
          label={(option) => option.label}
          onSelect={(option) => {
            if (!option || option.value === "mixed") return
            // Выбор в групповом селекторе ставит режим всем группам сразу, включая «Остальное».
            const mode = option.value as CorpPermissionMode
            void apply(Object.fromEntries(rows().map((row) => [row.id, mode])))
          }}
        />
      </div>
      <SettingsListV2>
        <For each={rows()}>
          {(row) => (
            <SettingsRowV2 title={row.title} description={row.description}>
              <SegmentedControlV2
                data-action="corp-permissions-group"
                data-group={row.id}
                value={rowMode(state(), row) ?? null}
                disabled={action.isPending || props.card.blocked}
                onChange={(value) => {
                  if (!value) return
                  void apply({ [row.id]: value as CorpPermissionMode })
                }}
              >
                <For each={MODES}>
                  {(mode) => (
                    <SegmentedControlItemV2 value={mode}>{language.t(MODE_KEY[mode])}</SegmentedControlItemV2>
                  )}
                </For>
              </SegmentedControlV2>
            </SettingsRowV2>
          )}
        </For>
      </SettingsListV2>
    </div>
  )
}

export const DialogConnector: Component<{ alias: string }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const action = useConnectorAction()
  const catalog = useCorpCatalog(() => true)

  /** Карточка берётся из каталога по alias, а не копируется в пропсы: после действия она обновится. */
  const card = createMemo(() => catalog.data?.servers.find((entry) => entry.alias === props.alias))

  /**
   * Задан ли адрес Hub в этой сборке (S-C10 п.7). Тот же признак, которым сервер решает судьбу
   * `open_hub`; отсутствие поля означает «сборка с Hub» — поведение до ревизии 1.11.
   */
  const hubConfigured = createMemo(() => catalog.data?.hub_configured !== false)

  /**
   * Подпись ошибки подключения (S-V19): объяснение своего класса плюс код ошибки как есть.
   * Класс есть у любой неудачи, включая `unknown`, поэтому необъяснённой ошибки не бывает (D-32).
   * Ревизией 1.10 изменилось только место показа — блок страницы вместо подписи строки витрины.
   */
  function explain(entry: CorpCatalogCard): string | undefined {
    if (!entry.error_class && !entry.error) return undefined
    const text = language.t(connectErrorKey(entry.error_class), { code: entry.error ?? "" })
    return entry.error ? `${text} (${entry.error})` : text
  }

  return (
    <CorpDialog
      title={
        <span class="flex items-center gap-2">
          <span>{card()?.title ?? props.alias}</span>
          {/* `alias` ушёл со строки витрины (S-D6, ревизия 1.12) и показывается здесь: он не
              лишние данные, а данные не для сканирования таблицы (D-53). */}
          <span class="text-12-regular text-text-weak">{props.alias}</span>
          <Show when={card()?.deprecated}>
            <Tag>{language.t("corp.connectors.deprecated")}</Tag>
          </Show>
        </span>
      }
      action={
        <Button size="small" variant="ghost" onClick={() => dialog.close()}>
          {language.t("corp.connector.back")}
        </Button>
      }
    >
      {/* Прокручивается содержимое страницы внутри окна; окно целиком не прокручивается и высоту
          от длины описания или числа групп разрешений не меняет (S-D10). */}
      <div class="corp-connector">
        <Show when={card()}>
          {(entry) => (
            <>
              {/* 2. Описание — то, чего на витрине нет (S-D6, S-D11). */}
              <Show when={entry().description}>
                <p class="text-14-regular text-text-base">{entry().description}</p>
              </Show>

              {/* 3. Свойства: отсутствующее поле строку не рисует, а не рисует пустую (S-D11). */}
              <div class="flex flex-col gap-1">
                <Show when={connectorType(entry())}>
                  {(value) => (
                    <div class="flex items-baseline gap-2">
                      <span class="text-12-regular text-text-weak">{language.t("corp.connector.type")}</span>
                      <span class="text-14-regular text-text-strong">{value()}</span>
                    </div>
                  )}
                </Show>
                <Show when={entry().owner}>
                  {(value) => (
                    <div class="flex items-baseline gap-2">
                      <span class="text-12-regular text-text-weak">{language.t("corp.connector.owner")}</span>
                      <span class="text-14-regular text-text-strong">{value()}</span>
                    </div>
                  )}
                </Show>
                <Show when={entry().docs_url}>
                  {(value) => (
                    <div class="flex items-baseline gap-2">
                      <span class="text-12-regular text-text-weak">{language.t("corp.connector.docs")}</span>
                      <a
                        class="text-14-regular text-text-strong underline break-all"
                        href={value()}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {value()}
                      </a>
                    </div>
                  )}
                </Show>
              </div>

              {/* 4. Статус: здесь признак «Подключено» — бейдж, а не колонка (S-V18). Рядом
                  объяснение ошибки подключения по её классу (S-V19). */}
              <div class="flex flex-col gap-2">
                <div class="flex items-center gap-2">
                  <Show when={entry().state === "connected"}>
                    <Tag class="corp-tag-connected">{language.t("corp.connectors.connected")}</Tag>
                  </Show>
                  <span class="text-14-regular text-text-strong">{language.t(statusKey(entry()))}</span>
                  <span data-slot="corp-status-dot" data-tone={statusTone(entry())} aria-hidden="true">
                    &bull;
                  </span>
                </div>
                <Show when={explain(entry())}>
                  {(value) => <span class="text-12-regular text-text-weak">{value()}</span>}
                </Show>
                <Show when={entry().blocked}>
                  <span class="text-12-regular text-text-weak">{language.t("corp.connectors.stale")}</span>
                </Show>
                {/* Предлагаемое действие показывается тем же элементом, которым выполняется
                    (S-V19): отдельной «кнопкой-советом» страница не обзаводится. Пустого ряда
                    действий не бывает: в сборке без Hub у карточки `facade` не остаётся ни одного
                    действия, и контейнер тогда не рисуется вовсе, а не висит пустой полосой. */}
                <Show when={hasActions(entry())}>
                <div class="flex items-center gap-2">
                  {/* S-V7, S-C10 п.8: подключение `facade` идёт через Hub-фасад, а Hub в этой
                      сборке нет — действия в наборе уже нет, и на его месте названа причина. */}
                  <Show when={entry().connect_needs_hub}>
                    <span class="text-12-regular text-text-weak">{language.t("corp.connectors.facadeNeedsHub")}</span>
                  </Show>
                  <Show when={entry().actions.includes("connect") || entry().actions.includes("reconnect")}>
                    <Button
                      size="small"
                      disabled={action.isPending || entry().blocked}
                      onClick={() =>
                        action.mutate({
                          kind: "connect",
                          alias: entry().alias,
                          ...(entry().preset ? { preset: entry().preset } : {}),
                        })
                      }
                    >
                      {/* S-V16: подпись действия в состоянии 3 — «Повторить»: попытка уже была, и
                          честнее это назвать; в состояниях 1 и 2 — «Подключить». */}
                      {language.t(
                        entry().actions.includes("reconnect") ? "corp.connectors.retry" : "corp.connectors.connect",
                      )}
                    </Button>
                  </Show>
                  {/* S-V8, S-V16: «Отключить» существует ровно в состоянии «Подключено» — набор
                      действий считает общий модуль corp/status.ts, оболочка его не пересчитывает. */}
                  <Show when={entry().actions.includes("disconnect")}>
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={action.isPending}
                      onClick={() => action.mutate({ kind: "disconnect", alias: entry().alias })}
                    >
                      {language.t("corp.connectors.disconnect")}
                    </Button>
                  </Show>
                  {/* S-C10 п.7: без адреса Hub `open_hub` из набора действий уже удалён сервером;
                      ссылка не рисуется и заблокированной не показывается — ссылка в никуда хуже
                      её отсутствия. Условие по `hub_url` остаётся вторым рубежом (S-V10). */}
                  <Show when={entry().actions.includes("open_hub") && entry().hub_url}>
                    <a
                      class="text-12-regular text-text-weak underline whitespace-nowrap"
                      href={entry().hub_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {language.t("corp.connectors.openHub")}
                    </a>
                  </Show>
                </div>
                </Show>
              </div>

              {/* 5. «Разрешения»: блок есть всегда. Вид `permission_groups` — режим каждой группы
                  (S-V9 ревизии 1.10); прочие виды — прежний экран пресетов (S-V20, деградация). */}
              <Show when={entry().actions.includes("permissions")}>
                <div class="flex flex-col gap-2">
                  <Show
                    when={!entry().permissions_need_hub}
                    fallback={
                      <>
                        <span class="text-12-regular text-text-weak">{language.t("corp.permissions.title")}</span>
                        {/* S-V9, S-C10 п.7: подтверждение этих видов модели прав идёт в Hub, а Hub
                            в этой сборке нет — экран заблокирован с названной причиной. Причина
                            отдельная от «модель прав не поддерживается этой версией приложения»:
                            «эта сборка без Hub» и «эта версия не умеет» — разные беды и разные
                            советы. Вид `permission_groups` целиком локален, и признак у него не
                            выставляется. */}
                        <span class="text-12-regular text-text-weak">
                          {language.t("corp.connectors.permissionsNeedHub")}
                        </span>
                      </>
                    }
                  >
                    <Show
                      when={entry().permission_groups}
                      fallback={
                        <>
                          <span class="text-12-regular text-text-weak">{language.t("corp.permissions.title")}</span>
                          <ConnectorPresets card={entry()} hubConfigured={hubConfigured()} />
                        </>
                      }
                    >
                      <ConnectorPermissionGroups card={entry()} />
                    </Show>
                  </Show>
                </div>
              </Show>

              {/* 6. «Убрать из списка» (S-V17) — со своим подтверждением; правило не изменено. */}
              <Show when={entry().actions.includes("forget")}>
                <div class="flex items-center">
                  <Button
                    size="small"
                    variant="ghost"
                    disabled={action.isPending}
                    onClick={() => dialog.push(() => <DialogForgetConnector card={entry()} />)}
                  >
                    {language.t("corp.connectors.forget")}
                  </Button>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </CorpDialog>
  )
}
