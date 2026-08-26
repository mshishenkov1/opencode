import { TextAttributes } from "@opentui/core"
import type { CorpCatalogCard, CorpPermissionMode, CorpPermissionStateMode } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal } from "solid-js"
import { useSDK } from "../../context/sdk"
import { useTheme } from "../../context/theme"
import { errorText, t } from "../../corp/i18n"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { useToast } from "../../ui/toast"

/**
 * Экран разрешений по группам для TUI (S-V20, S-V21, S-V23, S-D11, S-T10).
 *
 * Пятый вид модели прав (S-V9): вместо пресетов Hub — курируемый словарь групп из карточки каталога.
 * Первая строка — групповой селектор на весь коннектор, дальше группы в порядке каталога и
 * «Остальное» последней. `enter` на строке открывает подсписок трёх режимов с отметкой текущего;
 * выбор уходит в `PUT /corp/connectors/:alias/permissions` телом `{modes}`, и экран перерисовывается
 * по `permission_state` из ответа — по действующему режиму, а не по выбранному (S-V23).
 *
 * Тексты групп (`title`/`description`) приходят из каталога и рендерятся как есть (S-I6); из словаря
 * TUI берётся только обрамление и тексты группы «Остальное», когда каталог их не прислал (S-V20).
 */

/** Идентификатор группы «Остальное» в `permission_state` и в теле роута прав (S-V23). */
const REST_ID = "rest"

/** Псевдогруппа группового селектора: выбор ставит режим всем группам сразу, включая `rest` (S-V23). */
const ALL_ID = "*"

/** Режим по умолчанию там, где действующий режим не определён: спрашивать, а не разрешать (S-V20). */
const FALLBACK_MODE: CorpPermissionMode = "ask"

/** Три режима в порядке «мягче → строже» (S-V21). */
const MODES: readonly CorpPermissionMode[] = ["allow", "ask", "deny"] as const

/** Отметка действующего режима в подсписке: читается и в монохромном терминале (S-V18). */
const MARK = "* "

/** Подписи режима в строке группы (S-I1). */
const MODE_KEY = {
  allow: "permissions.allow",
  ask: "permissions.ask",
  deny: "permissions.deny",
} as const

/** Подписи того же режима в групповом селекторе: он ставит режим всем группам сразу (S-V23). */
const ALL_MODE_KEY = {
  allow: "permissions.allowAll",
  ask: "permissions.ask",
  deny: "permissions.denyAll",
} as const

/** Подпись режима; «Смешанно» — только отображаемое значение, выбрать его нельзя (S-V23). */
export function modeLabel(mode: CorpPermissionStateMode, all = false) {
  if (mode === "mixed") return t("permissions.mixed")
  return t(all ? ALL_MODE_KEY[mode] : MODE_KEY[mode])
}

/** Строка экрана: групповой селектор, группа либо один из трёх режимов в подсписке. */
type Row = { kind: "all" } | { kind: "group"; id: string } | { kind: "mode"; id: string; mode: CorpPermissionMode }

interface Entry {
  id: string
  title: string
  description?: string
  /** Режим каталога: действует, только пока конфиг для этого alias пуст (S-V23). */
  fallback: CorpPermissionMode
}

export interface DialogPermissionsProps {
  card: CorpCatalogCard
}

/**
 * Возврат к вызвавшему экрану (странице коннектора или витрине) делает `esc`: экран открывается
 * через `dialog.replace` с обработчиком закрытия, поэтому отдельного действия «Назад» ему не нужно.
 */
export function DialogPermissions(props: DialogPermissionsProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const toast = useToast()

  const [state, setState] = createSignal<Record<string, CorpPermissionStateMode>>({
    ...(props.card.permission_state ?? {}),
  })
  const [busy, setBusy] = createSignal(false)
  /** Открытый подсписок режимов: `undefined` — показан список групп. */
  const [editing, setEditing] = createSignal<string>()

  /**
   * Группы экрана: порядок массива каталога, «Остальное» всегда последней — независимо от того,
   * пришёл ли блок `rest` из каталога (S-V20).
   */
  const entries = createMemo<Entry[]>(() => {
    const groups = props.card.permission_groups?.groups ?? []
    const rest = props.card.permission_groups?.rest
    return [
      ...groups.map((group) => ({
        id: group.id,
        title: group.title,
        ...(group.description === undefined ? {} : { description: group.description }),
        fallback: group.default ?? FALLBACK_MODE,
      })),
      {
        id: REST_ID,
        // Единственное место, где тексты группы берутся не из каталога, а из словаря (S-V20).
        title: rest?.title ?? t("permissions.restTitle"),
        description: rest?.description ?? t("permissions.restDescription"),
        fallback: rest?.default ?? FALLBACK_MODE,
      },
    ]
  })

  /** Действующий режим группы: `permission_state` сервера, до первой записи — `default` каталога. */
  function shown(entry: Entry): CorpPermissionStateMode {
    return state()[entry.id] ?? entry.fallback
  }

  /**
   * Агрегат группового селектора (S-V23): одинаковый режим у всех групп — этот режим, иначе
   * «Смешанно». «Смешанно» исчезает из селектора, как только выбран любой из трёх режимов.
   */
  const aggregate = createMemo<CorpPermissionStateMode>(() => {
    let folded: CorpPermissionStateMode | undefined
    for (const entry of entries()) {
      const mode = shown(entry)
      if (folded === undefined) folded = mode
      else if (folded !== mode) return "mixed"
    }
    return folded ?? "mixed"
  })

  /** Текущее значение открытого подсписка: у группы — её режим, у селектора — агрегат. */
  const current = createMemo<CorpPermissionStateMode | undefined>(() => {
    const open = editing()
    if (open === undefined) return undefined
    if (open === ALL_ID) return aggregate()
    const entry = entries().find((item) => item.id === open)
    return entry ? shown(entry) : undefined
  })

  /**
   * Тело роута прав (S-V21): режим нужен **каждой** группе — блок alias перезаписывается целиком,
   * а не по группе за раз. «Смешанно» конкретным режимом не является и сворачивается в
   * «Спрашивать»: неизвестное спрашивает, а не разрешает (S-V20, S-V21).
   */
  function modesFor(changes: Record<string, CorpPermissionMode>) {
    const modes: Record<string, CorpPermissionMode> = {}
    for (const entry of entries()) {
      const chosen = changes[entry.id]
      if (chosen !== undefined) {
        modes[entry.id] = chosen
        continue
      }
      const value = state()[entry.id]
      modes[entry.id] = value === undefined ? entry.fallback : value === "mixed" ? FALLBACK_MODE : value
    }
    return modes
  }

  /**
   * Применение режимов (S-V21). Hub в этом не участвует ни на шаг (D-35): запись делает сервер в
   * раздел `permission` глобального конфига одной перезаписью блока alias. Отмена (`esc` без выбора
   * режима) не пишет ничего — ни одного вызова роута не выполняется (S-V9, AC-212).
   */
  async function apply(changes: Record<string, CorpPermissionMode>) {
    if (busy()) return
    setBusy(true)
    const modes = modesFor(changes)
    try {
      const result = await sdk.client.corp.permissions({ alias: props.card.alias, modes }).catch(() => undefined)
      const data = result?.data
      if (!data) {
        toast.show({ variant: "error", message: errorText(undefined) })
        return
      }
      if (data.hub_error) {
        toast.show({ variant: "warning", message: errorText(data.hub_error) })
        return
      }
      // Показывается пересчитанное сервером состояние, а не выбор пользователя (S-V23).
      setState(data.permission_state ?? modes)
      toast.show({ variant: "info", message: t("permissions.saved") })
    } finally {
      setBusy(false)
      setEditing(undefined)
    }
  }

  function choose(row: Row) {
    if (row.kind === "all") {
      setEditing(ALL_ID)
      return
    }
    if (row.kind === "group") {
      setEditing(row.id)
      return
    }
    if (row.id === ALL_ID) {
      // S-V23: выбор в групповом селекторе ставит режим всем группам сразу, включая `rest`,
      // и записывается тем же правилом S-V21 — одной перезаписью блока.
      const changes: Record<string, CorpPermissionMode> = {}
      for (const entry of entries()) changes[entry.id] = row.mode
      void apply(changes)
      return
    }
    void apply({ [row.id]: row.mode })
  }

  const options = createMemo<DialogSelectOption<Row>[]>(() => {
    const open = editing()
    if (open !== undefined) {
      const active = current()
      return MODES.map((mode) => ({
        title: `${active === mode ? MARK : "  "}${modeLabel(mode, open === ALL_ID)}`,
        value: { kind: "mode", id: open, mode } as Row,
      }))
    }
    return [
      // Групповой селектор — отдельная строка над списком групп (S-V23).
      {
        title: t("permissions.title"),
        value: { kind: "all" } as Row,
        footer: <text fg={theme.textMuted}>{modeLabel(aggregate(), true)}</text>,
      },
      ...entries().map((entry) => ({
        // S-I6: `title` и `description` группы — данные каталога, рендерятся как есть.
        title: entry.title,
        value: { kind: "group", id: entry.id } as Row,
        ...(entry.description === undefined ? {} : { description: entry.description }),
        footer: <text fg={theme.textMuted}>{modeLabel(shown(entry))}</text>,
      })),
    ]
  })

  return (
    <DialogSelect
      title={t("permissions.title")}
      renderFilter={false}
      skipFilter={true}
      locked={busy()}
      titleView={
        <box flexDirection="row" gap={2}>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>
            {t("permissions.title")}
          </text>
          {/* S-I6: название коннектора — данные каталога, клиент их не переводит. */}
          <text fg={theme.textMuted}>{props.card.title}</text>
        </box>
      }
      options={options()}
      onSelect={(option) => choose(option.value)}
      // Пока открыт подсписок режимов, `esc` возвращает к списку групп, а не закрывает экран.
      // Если своя привязка проиграет привязке диалога, поведение останется прежним — экран
      // закроется, и ничего не будет записано: пишет только выбор режима (S-V21).
      bindings={
        editing() === undefined
          ? undefined
          : [{ key: "escape", desc: "Back to permission groups", group: "Dialog", cmd: () => setEditing(undefined) }]
      }
      footerHints={[{ title: t("connector.back"), label: "esc" }]}
    />
  )
}
