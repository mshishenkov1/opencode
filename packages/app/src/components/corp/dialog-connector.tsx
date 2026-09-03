import { Component, createMemo, createSignal, For, Show } from "solid-js"
import type {
  CorpAuthMethodField,
  CorpAuthMethodView,
  CorpCatalogCard,
  CorpPermissionGroups,
  CorpPermissionMode,
  CorpPermissionModel,
  CorpPermissionState,
  CorpPermissionToolClass,
  CorpPermissionToolState,
} from "@opencode-ai/sdk/v2"
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { SegmentedControlItemV2, SegmentedControlV2 } from "@opencode-ai/ui/v2/segmented-control-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { SettingsListV2 } from "@/components/settings-v2/parts/list"
import { SettingsRowV2 } from "@/components/settings-v2/parts/row"
import {
  actionFailureText,
  connectErrorKey,
  connectFailureKey,
  connectTokenFailure,
  useConnectToken,
  useConnectorAction,
  useCorpCatalog,
} from "@/context/corp"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import { ConnectorIcon } from "./connector-icon"
import { statusKey, statusTone } from "./dialog-connectors"
import { CorpDialog } from "./dialog-shell"

/**
 * Страница коннектора (S-D11, ревизия 1.10).
 *
 * Открывается со строки витрины через `useDialog().push`: витрина остаётся в стеке живой, поэтому
 * возврат (`Esc` или «Назад») приводит пользователя ровно туда, откуда он ушёл — с той же вкладкой,
 * той же строкой поиска и той же позицией прокрутки. `show` уничтожил бы её вместе с состоянием.
 *
 * Состав сверху вниз (макет заказчика от 30.08): хлебная крошка «‹ Коннекторы / <имя>» в
 * заголовке окна; шапка страницы — значок, имя с бейджами «Подключено» и «устаревший»,
 * техническое имя под ним и ряд действий («Убрать из списка» — в меню из трёх точек, S-V17);
 * статус с объяснением ошибки и предлагаемым действием (S-V19); описание абзацами; свойства
 * (владелец, способ подключения, документация); «Инструменты»; блок подключения (S-D13) и
 * «Разрешения» (S-V9, S-V20). Размер окна страница получает от `CorpDialog`, ничего про размеры
 * не зная (S-D10); прокручивается содержимое, а не окно.
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
 * Подсказки тристейта (ревизия 1.14): у иконки без подписи имя обязано быть — и в подсказке при
 * наведении, и в `aria-label`. Короткие подписи `MODE_KEY` для этого не годятся: «Разрешить» не
 * говорит, чем разрешение отличается от «Спрашивать».
 */
const MODE_HINT_KEY = {
  allow: "corp.permissions.allowHint",
  ask: "corp.permissions.askHint",
  deny: "corp.permissions.denyHint",
} as const

/**
 * Значки трёх режимов (утверждённый макет от 30.08, экран 3): круг с галочкой, ПОДНЯТАЯ РУКА,
 * перечёркнутый круг.
 *
 * Средним значком была реплика: руки в наборе `packages/ui` не было, и её заменили ближайшим. Это
 * расхождение с макетом заказчик отклонил 31.08 — рука заведена в набор глифом `hand` ровно тем
 * контуром, который нарисован в исходнике макета.
 */
const MODE_ICON = {
  allow: "circle-check",
  ask: "hand",
  deny: "circle-ban-sign",
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
 * Есть ли что показывать в ряду действий шапки (S-C10 п.7–8, ревизия 1.14).
 *
 * Ревизией 1.14 из ряда ушла ссылка «Открыть в Hub» — решением заказчика от 30.08: человек
 * должен понимать, что он подключает, не выходя из окна, поэтому действие `open_hub` оболочка не
 * рисует, даже когда сервер прислал его в наборе. Причины недоступности остались на прежних
 * местах: `oauth_disabled` — общей строкой рядом с неактивной кнопкой, `facade_needs_hub` — на
 * месте кнопки, которой нет (S-V28 п.4), и `connect_needs_hub` по-прежнему делает ряд непустым.
 *
 * Пустой ряд не рисуется вовсе: пустой flex-контейнер с отступами оставил бы на экране полосу, за
 * которой ничего нет.
 */
export function hasActions(card: CorpCatalogCard): boolean {
  if (card.connect_needs_hub) return true
  if (card.actions.includes("connect") || card.actions.includes("reconnect")) return true
  if (card.actions.includes("disconnect")) return true
  if (card.actions.includes("forget")) return true
  return connectByToken(card)
}

/**
 * Показывается ли на странице отдельная строка состояния (решение заказчика от 31.08).
 *
 * В макете такой строки нет ни на экране 2, ни на экране 3, и в обоих случаях по одной причине:
 * она повторяет то, что уже сказано рядом. У подключённого это делает бейдж «Подключено» возле
 * имени; у неподключённого — сама страница: кнопка «Подключить» и форма ввода токена не оставляют
 * места вопросу, подключён ли он.
 *
 * Остаются два тона из четырёх — `warning` и `danger`: «соединение потеряно», «подключение не
 * удалось», «нужна повторная авторизация», «отключено вами», «недоступен». Их не дублирует ничто,
 * и молчать о них нельзя (S-V19): именно ради них строка и существует. Объяснение ошибки и
 * признак устаревшей записи живут отдельными строками и этим правилом не трогаются.
 */
export function statusVisible(card: Pick<CorpCatalogCard, "state" | "status">): boolean {
  const tone = statusTone(card)
  return tone === "warning" || tone === "danger"
}

/**
 * Описание карточки абзацами (S-D11, ревизия 1.14).
 *
 * Разделитель абзацев в данных — пустая строка; одиночный перенос абзаца не начинает. Текст
 * абзацев не правится: это данные каталога и рендерятся они как есть (S-I6). До ревизии 1.14
 * описание рисовалось одним `<p>`, и два абзаца слипались в стену текста.
 */
export function descriptionParagraphs(description: string | undefined): string[] {
  if (!description) return []
  return description
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

/**
 * Способ подключения в строке свойств (макет заказчика от 30.08, экран 2).
 *
 * Отвечает на вопрос «чем этот коннектор подключается», и потому это свойство КАРТОЧКИ, а не
 * состояния связи: в макете строка стоит и у неподключённого коннектора. Берётся первый
 * **доступный** способ; доступных нет — строки нет вовсе.
 *
 * Отката на первый объявленный способ здесь нет намеренно (решение заказчика от 31.08): недоступный
 * способ не показывается пользователю нигде, а строка свойств — такое же «нигде», как ряд выбора и
 * причина у кнопки. Прежний откат печатал в свойствах имя закрытого способа («Корпоративная
 * авторизация ТЭГ»), то есть называл подключением ровно то, чем подключиться нельзя.
 *
 * Название способа — данные каталога и рисуется как есть (S-I6). Каким способом подключение было
 * выполнено ФАКТИЧЕСКИ, карточка не сообщает — такого поля в контракте нет.
 */
export function connectionMethodTitle(card: CorpCatalogCard): string | undefined {
  const methods = card.auth_methods ?? []
  return methods.find((method) => method.available)?.title
}

/**
 * Человеческое имя ссылки на документацию (макет заказчика от 30.08, экран 2).
 *
 * В строке свойств стоит имя места, куда ведёт ссылка, а не адрес целиком: адрес со схемой,
 * путём и параметрами читать человеку незачем, а строка свойств от него распухает и переносится.
 *
 * Имя приносит каталог — поле `docs_label` («внутренний портал» макета). Ревизия 1.14 писала, что
 * такого поля нет и выдумывать название нельзя; поле появилось, и теперь оно и есть источник.
 * Не прислали — прежнее поведение: имя узла, то же данное, прочитанное так, как его читает
 * человек. Неразобранный адрес показывается как есть: спрятать ссылку хуже, чем показать её
 * адресом.
 */
export function docsLabel(url: string, label?: string): string {
  const named = label?.trim()
  if (named) return named
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return url
  }
}

/**
 * Когда токен подключения в последний раз проверен целевой системой — **вид** подписи, без языка
 * (макет заказчика от 30.08, экран 3: «проверен сегодня в 21:40»).
 *
 * Считается разница КАЛЕНДАРНЫХ дней, а не часов: проверка вчера в 23:50 и сейчас 00:10 — это
 * «вчера», а не «сегодня», сколько бы минут между ними ни прошло. Время из будущего (часы машины
 * ушли назад) — «сегодня»: врать про завтра хуже, чем округлить к сегодняшнему дню.
 *
 * `undefined` — поля нет или оно нечитаемо: подпись тогда не рисуется вовсе, а не подменяется
 * временем сохранения записи или сегодняшним днём.
 */
export type VerifiedShape = { kind: "today" | "yesterday" | "date"; at: Date }

export function verifiedShape(verifiedAt: string | undefined, now: Date): VerifiedShape | undefined {
  if (!verifiedAt) return undefined
  const at = new Date(verifiedAt)
  if (Number.isNaN(at.getTime())) return undefined
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return { kind: "today", at }
  if (days === 1) return { kind: "yesterday", at }
  return { kind: "date", at }
}

/**
 * ВИД страницы коннектора — состав блоков зависит от СОСТОЯНИЯ (решение заказчика от 31.08).
 *
 * До этого решения страница показывала всё подряд в любом состоянии, и заказчик, глядя на собранное
 * приложение, назвал это расхождением с макетом: в макете экраны 2 и 3 отличаются не оформлением, а
 * СОСТАВОМ. Экран 2 (не подключён) — витрина товара: «Скопировать ссылку», описание абзацами, строка
 * свойств, плитки инструментов; человек читает, что он собирается подключить. Экран 3 (подключён) —
 * пульт управления: шапка с бейджем и строкой «учётная запись · способ · когда проверено» и сразу
 * «Разрешения»; ни описания, ни свойств, ни плиток там нет. Рекламу того, что уже стоит, показывать
 * незачем, а список инструментов у подключённого и так стоит строками экрана разрешений — плитками
 * он дублировался бы дважды на одной странице.
 *
 * `"account"` — вид экрана 3, `"catalog"` — вид экрана 2. Промежуточные состояния (соединение
 * потеряно, подключение не удалось, нужна повторная авторизация) макет не рисует, и решение по ним
 * принято по его духу: делит их наличие СОХРАНЁННЫХ учётных данных. Есть `has_credentials` — про
 * коннектор уже известно «кем» и «когда проверено», человек им пользовался, и ему нужен пульт, а не
 * витрина: вид `"account"`. Нет — подключение не состоялось ни разу (или данные забыты), и человеку
 * снова нужно понять, что он подключает: вид `"catalog"`.
 *
 * Строка состояния с объяснением (S-V19) в состав НЕ входит и этим правилом не трогается: она есть
 * в обоих видах всегда — именно в промежуточных состояниях она и объясняет, что случилось.
 */
export type ConnectorPageView = "catalog" | "account"

export function pageView(card: CorpCatalogCard): ConnectorPageView {
  return card.state === "connected" || card.has_credentials === true ? "account" : "catalog"
}

/**
 * Строка под именем подключённого коннектора: «учётная запись · способ · когда проверено»
 * (макет заказчика от 30.08, экран 3).
 *
 * Строка есть у коннектора, подключение к которому **состоялось**: либо связь держится сейчас
 * (`state: "connected"`, случай макета), либо для него сохранены учётные данные, которыми он
 * подключался (`has_credentials`) — у такого коннектора «кем» и «когда проверено» правда, даже
 * когда связь потеряна, и строка об этом говорит, пока строка состояния говорит об обрыве.
 * У коннектора, которого не подключали, строки нет вовсе: способ подключения — свойство каталога,
 * оно живёт в строке свойств и в одиночку под именем не встаёт.
 *
 * Собирается **только из того, что известно**. Учётную запись называет целевая система при
 * проверке токена, время проверки записывается в тот же момент — ни того, ни другого у карточки
 * может не быть, и тогда часть просто не рисуется. Разделители стоят между существующими частями:
 * из одной известной части выходит строка из одной части, а не строка с висящими точками.
 */
export function identityParts(
  card: CorpCatalogCard,
  method: string | undefined,
  verified: string | undefined,
): string[] {
  if (pageView(card) !== "account") return []
  return [card.account, method, verified].filter((part): part is string => Boolean(part))
}

/**
 * Запись в буфер обмена — та же последовательность, какой копирует остальное приложение
 * (`pages/session/use-session-commands.tsx`, `ui/components/message-part.tsx`): сперва скрытая
 * `textarea` с `document.execCommand("copy")`, и только потом асинхронный `navigator.clipboard`.
 *
 * Порядок именно такой, потому что асинхронному буферу браузер отказывает там, где обычному
 * копированию не отказывает: в неактивной вкладке, без выданного разрешения, в невнимательном к
 * жесту окружении. Возвращается **исход**, а не `void`: сказать «скопировано» о том, чего не
 * произошло, приложение не вправе.
 *
 * Копия, а не общий помощник: своего помощника в `packages/app/src/utils` форк не заводит — там
 * начинается зона upstream, и правка её ради корп-экрана дороже, чем эти двадцать строк (S-B6).
 */
export async function writeClipboard(value: string): Promise<boolean> {
  const body = typeof document === "undefined" ? undefined : document.body
  if (body && typeof document.execCommand === "function") {
    const textarea = document.createElement("textarea")
    textarea.value = value
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(value).then(
    () => true,
    () => false,
  )
}

/** Сколько плиток инструментов показывается до нажатия «Показать все» (S-D11, ревизия 1.14). */
export const TOOLS_PREVIEW = 30

/**
 * Место кликабельной части внутри фразы «и ещё 59 — раскрывается по «Показать все»» (макет
 * заказчика, экран 2).
 *
 * Подставляется вместо `{{action}}` перед разрезанием и в готовый текст не попадает никогда:
 * `U+0000` не набирается на клавиатуре и не встречается ни в одном словаре, поэтому спутать его с
 * содержимым фразы нельзя.
 */
export const TOOLS_ACTION_MARK = "\u0000"

/**
 * Разрез фразы «и ещё N — …» на две части вокруг кликабельного «Показать все».
 *
 * Возвращается пара «до» и «после»; порядок слов и знаки препинания остаются такими, какими их
 * задал словарь. Метки в строке нет (перевод сделан без `{{action}}`) — вся фраза уходит в «до», и
 * кнопка встаёт после неё: экран остаётся рабочим, хоть и не дословно по макету.
 */
export function toolsRestSplit(text: string): [string, string] {
  const at = text.indexOf(TOOLS_ACTION_MARK)
  if (at < 0) return [text, ""]
  return [text.slice(0, at), text.slice(at + TOOLS_ACTION_MARK.length)]
}

/**
 * Список инструментов коннектора для блока «Инструменты» (S-D11, S-V20 версии 2).
 *
 * Источник один — раздел `tools` словаря разрешений. Нет словаря или нет раздела — пустой список,
 * и блок не рисуется: выдумывать список инструментов не из чего. Порядок — порядок каталога.
 * Человеческое имя показывается, когда оно есть; без него — техническое, а не заглушка.
 */
export function connectorTools(card: CorpCatalogCard): { name: string; label: string }[] {
  const tools = card.permission_groups?.tools
  if (!tools) return []
  return Object.entries(tools).map(([name, def]) => ({ name, label: def.title ?? name }))
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
 * Три класса риска — три секции экрана разрешений, в этом порядке (ТЗ ревизии 1.14, референс
 * заказчика). Порядок и есть требование: сверху то, что ничего не меняет, снизу то, что действует
 * от имени пользователя.
 */
export const TOOL_CLASSES: CorpPermissionToolClass[] = ["read_only", "write_delete", "interactive"]

const CLASS_KEY = {
  read_only: "corp.permissions.class.readOnly",
  write_delete: "corp.permissions.class.writeDelete",
  interactive: "corp.permissions.class.interactive",
} as const

const CLASS_HINT_KEY = {
  read_only: "corp.permissions.class.readOnlyHint",
  write_delete: "corp.permissions.class.writeDeleteHint",
  interactive: "corp.permissions.class.interactiveHint",
} as const

/** Строка экрана разрешений: один инструмент — человеческое имя и техническое под ним. */
export interface ToolRow {
  name: string
  title: string
}

/** Секция экрана разрешений: класс риска либо «Остальные» (S-V20). */
export interface ToolSection {
  id: CorpPermissionToolClass | typeof REST_GROUP_ID
  tools: ToolRow[]
}

/**
 * Раскладка инструментов по секциям (ТЗ ревизии 1.14, S-V20 версии 2).
 *
 * Состав строк — объединение инструментов групп и раздела `tools` словаря, в порядке словаря: то
 * же множество, по которому сервер считает `permission_tool_state`, поэтому строки без режима не
 * бывает. Секция выбирается классом инструмента; инструмент, которого в разделе `tools` нет вовсе
 * (он назван группой, но не описан), попадает в «Остальные» — четвёртую секцию. Неизвестный класс
 * сюда не доходит: его в `interactive` перевёл разбор словаря (S-V20), и это решение про данные, а
 * не про экран.
 *
 * Пустая секция не возвращается — рисовать заголовок над пустотой нечего.
 */
export function toolSections(groups: CorpPermissionGroups | undefined): ToolSection[] {
  const dictionary = groups?.tools
  if (!dictionary) return []
  const order: string[] = []
  const seen = new Set<string>()
  const add = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    order.push(name)
  }
  for (const group of groups!.groups) for (const tool of group.tools) add(tool)
  for (const tool of Object.keys(dictionary)) add(tool)

  const buckets = new Map<ToolSection["id"], ToolRow[]>()
  for (const id of [...TOOL_CLASSES, REST_GROUP_ID] as ToolSection["id"][]) buckets.set(id, [])
  for (const name of order) {
    const def = dictionary[name]
    const id: ToolSection["id"] = def ? def.class : REST_GROUP_ID
    buckets.get(id)!.push({ name, title: def?.title ?? name })
  }
  return [...buckets.entries()]
    .filter(([, tools]) => tools.length > 0)
    .map(([id, tools]) => ({ id, tools }))
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
          <div class="text-14-regular text-v2-text-text-base break-all">{tools().join(", ")}</div>
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
          <div class="text-14-regular text-v2-text-text-base break-all">{always().join(", ")}</div>
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
 * Одна правка разрешений: режимы СТРОК по их ключу (имя инструмента) и, отдельно, режим wildcard,
 * когда его двигает эта же правка.
 */
interface PermissionEdit {
  rows: Record<string, CorpPermissionMode>
  rest?: CorpPermissionMode
}

/**
 * Очередь записи разрешений с ВРЕМЕННЫМ ВИДОМ выбора (ревизия 1.14, дефект «экран запирается»).
 *
 * До неё занятость экрана бралась из `action.isPending` одной мутации на весь блок, и один
 * переключённый инструмент гасил все 77 строк и все селекторы секций разом. Наблюдение на стенде:
 * после одного нажатия недоступны 231 сегмент из 231, и держится это столько, сколько идёт запрос
 * с последующим перечитыванием витрины (на замедленном моке — девять секунд); при недоступном Hub
 * — до конца жизни экрана. Занятость обязана жить на строке, которую меняют.
 *
 * **Почему очередь, а не «кто успел» и не отмена предыдущего запроса.** Запись перезаписывает блок
 * alias ЦЕЛИКОМ (S-V21): в теле идут режимы всех групп и всех показанных инструментов. Поэтому две
 * записи, ушедшие одновременно, не складываются — тело второй собрано из состояния ДО первой и
 * молча отменяет её (наблюдено зондом на настоящем роуте: три одновременные записи трёх разных
 * секций оставили в конфиге правку только последней). Отмена предыдущего запроса
 * (`AbortController`) не годится по другой причине: роут пишет конфиг двумя вызовами
 * `updateGlobal`, и оборванный HTTP-запрос запись не отменяет — оборвана была бы только доставка
 * ответа, а экран разошёлся бы с файлом. Остаётся очередь.
 *
 * Подряд идущие правки при этом СЛИВАЮТСЯ: пока летит запись, они копятся в накопителе, и после
 * ответа уходит один запрос с их итогом. Отсюда сразу два требуемых свойства — ни одна правка не
 * теряется, а «туда-обратно» по одной строке кончается последним нажатием, а не гонкой.
 *
 * **Временный вид и S-V23.** Действующий режим по-прежнему считает сервер и присылает в
 * `permission_state`/`permission_tool_state`; клиент его не пересчитывает и из режима группы не
 * выводит. Временный вид — не вычисление, а показ собственного нажатия человека, и живёт он ровно
 * до ответа: сервер его подтверждает (тогда он снимается — то же значение уже пришло сверху) или
 * отменяет (тогда строка возвращается к серверному режиму и получает знак отказа). Строка, у
 * которой есть временный вид, и есть ЗАНЯТАЯ строка — отдельного признака занятости не заводится,
 * иначе их стало бы два и они разошлись бы.
 *
 * Очередь заведена для экрана ревизии 1.14, о котором и говорит дефект. Прежний экран по группам
 * (`ConnectorPermissionGroups`, деградация для словаря версии 1) остаётся на прежнем поведении:
 * его вид закреплён мерами AC-205 и AC-212 в форме прежней реализации, и перевод его на очередь —
 * отдельное изменение вместе с этими мерами.
 */
function createPermissionWriter(send: (edit: PermissionEdit) => Promise<void>) {
  const [preview, setPreview] = createSignal<PermissionEdit>({ rows: {} })
  /** Строки, чью правку сервер не принял: ключ строки → техническая подробность для подсказки. */
  const [rejected, setRejected] = createSignal<Record<string, string>>({})

  /** Накопитель: правки, ждущие своей очереди. `undefined` — ждать нечему. */
  let waiting: PermissionEdit | undefined
  let running = false

  const forget = (keys: string[]) =>
    setRejected((current) => {
      const next = { ...current }
      for (const key of keys) delete next[key]
      return next
    })

  /** Снять временный вид отработавшей правки — но не у строк, изменённых ещё раз, пока она летела. */
  const settle = (edit: PermissionEdit) =>
    setPreview((current) => {
      const rows = { ...current.rows }
      for (const key of Object.keys(edit.rows)) if (!waiting || !(key in waiting.rows)) delete rows[key]
      const next: PermissionEdit = { rows }
      const keepRest = edit.rest === undefined || waiting?.rest !== undefined
      if (keepRest && current.rest !== undefined) next.rest = current.rest
      return next
    })

  async function drain() {
    running = true
    try {
      while (waiting) {
        const edit = waiting
        waiting = undefined
        try {
          await send(edit)
          forget(Object.keys(edit.rows))
        } catch (error) {
          // Молчаливой неудачи не бывает: тост про сорванный запрос показывает `useConnectorAction`,
          // а здесь отказ получает адрес — те самые строки, чей режим не сохранился.
          const detail = actionFailureText(error) ?? ""
          setRejected((current) => {
            const next = { ...current }
            for (const key of Object.keys(edit.rows)) next[key] = detail
            return next
          })
        }
        settle(edit)
      }
    } finally {
      running = false
    }
  }

  /** Поставить правку в очередь и сразу показать её временным видом. */
  function push(edit: PermissionEdit) {
    const merge = (base: PermissionEdit | undefined): PermissionEdit => {
      const next: PermissionEdit = { rows: { ...base?.rows, ...edit.rows } }
      const rest = edit.rest ?? base?.rest
      if (rest !== undefined) next.rest = rest
      return next
    }
    waiting = merge(waiting)
    setPreview(merge)
    // Новое нажатие по строке снимает с неё прежний знак отказа: человек уже ответил на него.
    forget(Object.keys(edit.rows))
    if (!running) void drain()
  }

  return { preview, rejected, push }
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

/**
 * Экран разрешений ревизии 1.14: три класса риска и тристейт на КАЖДОМ инструменте (ТЗ §4,
 * референс заказчика — экран коннектора Claude Desktop).
 *
 * Что изменилось против прежнего экрана по группам: строка теперь на инструмент, а не на группу
 * из пятнадцати; секций три (плюс «Остальные», если есть чему в неё попасть), и делят они
 * инструменты по риску, а не по смыслу. Согласованные формулировки словаря при этом никуда не
 * делись — они живут в именах строк, а групповая раскладка остаётся деградацией для словаря
 * версии 1, у которого раздела `tools` нет вовсе.
 *
 * Действующий режим строки приходит готовым в `permission_tool_state` (S-V23): клиент его не
 * пересчитывает и из режима группы не выводит. «Наследуется от группы, пока не задан лично» —
 * результат правил конфига, посчитанный сервером, а не догадка экрана.
 *
 * Запись — та же детерминированная перезапись блока alias (S-V21): в теле идут режимы всех групп
 * (включая `rest`, то есть wildcard) и режимы **всех** показанных инструментов, а не один
 * изменённый. Отправить только правку значило бы молча сбросить остальные решения пользователя.
 */
const ConnectorPermissionTools: Component<{ card: CorpCatalogCard }> = (props) => {
  const language = useLanguage()
  const action = useConnectorAction()

  /** Ответ роута прав — источник истины сразу после записи (S-V23), как и на прежнем экране. */
  const [applied, setApplied] = createSignal<{ groups?: CorpPermissionState; tools?: CorpPermissionToolState }>()
  const groupState = createMemo(() => applied()?.groups ?? props.card.permission_state)
  const toolState = createMemo(() => applied()?.tools ?? props.card.permission_tool_state)

  /**
   * Свёрнутые секции: выбор живёт, пока открыта страница, и в конфиг не попадает.
   *
   * `permissionGroups` выделен отдельным мемо, чтобы `sections()` не пересчитывался при
   * рефетче каталога после записи прав (invalidate): новая карточка приходит другим объектом,
   * но `permission_groups` в ней тот же — мемо сравнивает по ссылке и не пускает пересчёт
   * дальше. Без этого `<For>` пересоздавал бы DOM-узлы и скролл сбрасывался наверх.
   */
  const permissionGroups = createMemo(() => props.card.permission_groups)
  const [folded, setFolded] = createSignal<Record<string, boolean>>({})

  const sections = createMemo(() => toolSections(permissionGroups()))
  const rest = createMemo(() => permissionGroups()?.rest)

  function sectionTitle(id: ToolSection["id"]) {
    if (id === REST_GROUP_ID) return rest()?.title ?? language.t("corp.permissions.restTitle")
    return language.t(CLASS_KEY[id])
  }

  function sectionHint(id: ToolSection["id"]) {
    if (id === REST_GROUP_ID) return rest()?.description ?? language.t("corp.permissions.restDescription")
    return language.t(CLASS_HINT_KEY[id])
  }

  /**
   * Запись: полное тело блока (S-V21).
   *
   * `modes` — режимы всех групп, как их посчитал сервер; группа в состоянии `mixed` в набор не
   * попадает намеренно (для неё запись возьмёт `default` каталога), но её инструменты названы
   * поимённо в `tools` и потому своих значений не теряют.
   *
   * Тело собирается из `modeOf`/`restMode`, то есть с учётом ВРЕМЕННОГО ВИДА: в нём и правка,
   * которую сейчас отправляют, и все прежние, которых сервер ещё не подтвердил. Собирать тело из
   * одного лишь серверного состояния значило бы отправить его без собственной правки.
   */
  const writer = createPermissionWriter(async () => {
    const tools: Record<string, CorpPermissionMode> = {}
    for (const section of sections())
      for (const row of section.tools) {
        const mode = modeOf(row.name)
        if (mode) tools[row.name] = mode
      }
    const modes: Record<string, CorpPermissionMode> = {}
    for (const [id, value] of Object.entries(groupState() ?? {}))
      if (value === "allow" || value === "ask" || value === "deny") modes[id] = value
    const wildcard = restMode()
    if (wildcard) modes[REST_GROUP_ID] = wildcard
    // Режим wildcard обязан быть в теле явно: без него запись возьмёт `default` каталога и молча
    // отменит прежнее решение пользователя про инструменты вне словаря (S-V21).
    if (!(REST_GROUP_ID in modes)) modes[REST_GROUP_ID] = rest()?.default ?? DEFAULT_MODE
    const result = await action.mutateAsync({ kind: "permissionTools", alias: props.card.alias, modes, tools })
    if (result && "permission_state" in result)
      setApplied({
        ...(result.permission_state === undefined ? {} : { groups: result.permission_state }),
        ...(result.permission_tool_state === undefined ? {} : { tools: result.permission_tool_state }),
      })
  })

  /** Режим строки: временный вид, пока сервер не ответил, иначе — посчитанный сервером (S-V23). */
  const modeOf = (name: string): CorpPermissionMode | undefined => writer.preview().rows[name] ?? toolState()?.[name]
  /** Занята та строка, чью правку сервер ещё не подтвердил и не отменил. */
  const busy = (name: string) => name in writer.preview().rows
  const rejectedOf = (name: string) => writer.rejected()[name]

  /**
   * Значение группового селектора секции (S-V23): одинаковый режим у всех её строк — этот режим,
   * иначе «Смешанно». У секции «Остальные» в свёртку входит и режим wildcard: строки этой секции и
   * wildcard — про одно и то же, инструменты вне словаря, и расходиться им незачем.
   */
  function sectionMode(section: ToolSection) {
    const modes = section.tools.map((tool) => modeOf(tool.name))
    if (section.id === REST_GROUP_ID) modes.push(restMode())
    return aggregateMode(modes)
  }

  const sectionBusy = (section: ToolSection) =>
    section.tools.some((tool) => busy(tool.name)) ||
    (section.id === REST_GROUP_ID && writer.preview().rest !== undefined)

  const restMode = () => {
    const shown = writer.preview().rest
    if (shown !== undefined) return shown
    const value = groupState()?.[REST_GROUP_ID]
    return value === "allow" || value === "ask" || value === "deny" ? value : undefined
  }

  /**
   * `blocked` — единственное, что имеет право погасить экран целиком (S-V28): карточка закрыта по
   * существу, и трогать на ней нечего. «Идёт запрос» с этим не смешивается: занятость живёт на
   * строке, а не на экране.
   */
  const disabled = () => props.card.blocked

  /**
   * Варианты группового селектора: объекты создаются ОДИН раз на язык и переиспользуются.
   *
   * Это не оптимизация, а исправление второго дефекта того же экрана. `SelectV2` — управляемый
   * компонент Kobalte: выбранное значение он сравнивает по ссылке. Прежде и `options`, и `current`
   * собирались новыми объектами на КАЖДОЙ отрисовке, поэтому после записи Kobalte видел «значение
   * сменилось» и звал `onSelect` снова — тот писал, отрисовка повторялась, и цикл замыкался.
   * Наблюдение на стенде до правки: одно изменение режима секции у карточки Jira отправило 1723
   * одинаковых запроса записи за четыре секунды и кончилось тремя тостами «Запрос не выполнен».
   * Стабильная ссылка разрывает цикл на входе, а проверка «выбран тот же режим» ниже — на выходе,
   * и вторая нужна независимо от первой: выбор того же режима писать нечего в любом случае.
   */
  const bulkOption = createMemo(() => {
    const map: Record<string, { value: string; label: string }> = {}
    for (const mode of MODES) map[mode] = { value: mode, label: language.t(BULK_KEY[mode]) }
    map["mixed"] = { value: "mixed", label: language.t("corp.permissions.mixed") }
    return map
  })

  function bulkOptions(section: ToolSection) {
    const options = MODES.map((mode) => bulkOption()[mode])
    // «Смешанно» показывается, только пока режимы расходятся, и выбрать его нельзя (S-V23).
    if (sectionMode(section) === "mixed") options.push(bulkOption()["mixed"])
    return options
  }

  /**
   * Ключи для `<For>`: ID секций и имена инструментов как примитивы (строки).
   *
   * SolidJS `<For>` отслеживает элементы по ссылке. Объекты `ToolSection` и `ToolRow`
   * создаются заново при каждом пересчёте `sections()`, а пересчёт запускается рефетчем
   * каталога после записи прав (invalidate). При пересоздании DOM скролл сбрасывается наверх.
   *
   * Итерация по строковым ключам с поиском объекта по ключу — стабильна: те же строки
   * дают те же DOM-узлы, и скролл сохраняется.
   */
  const sectionIds = createMemo(() => sections().map((s) => s.id))
  const sectionById = (id: ToolSection["id"]) => sections().find((s) => s.id === id)!

  return (
    <div class="flex flex-col gap-3" data-slot="corp-permissions">
      <div class="flex flex-col gap-1">
        <span class="text-14-medium text-text-strong">{language.t("corp.permissions.toolsTitle")}</span>
        <span class="text-12-regular text-text-weak">{language.t("corp.permissions.toolsHint")}</span>
      </div>
      <For each={sectionIds()}>
        {(sectionId) => {
          const section = createMemo(() => sectionById(sectionId))
          return (
          <div data-slot="corp-permission-section" data-section={sectionId}>
            <div data-slot="corp-permission-section-head">
              {/* Треугольник свёртки — он же кнопка: заголовок секции целиком её открывает. */}
              <button
                type="button"
                data-action="corp-permission-fold"
                data-section={sectionId}
                aria-expanded={!folded()[sectionId]}
                title={sectionHint(sectionId)}
                onClick={() => setFolded((value) => ({ ...value, [sectionId]: !value[sectionId] }))}
              >
                <Icon name={folded()[sectionId] ? "chevron-right" : "chevron-down"} size="small" />
                <span class="text-14-medium text-text-strong">{sectionTitle(sectionId)}</span>
                <Tag>{section().tools.length}</Tag>
              </button>
              <span class="flex-1" />
              {/* Секция занята, пока сервер не ответил хотя бы по одной её строке. */}
              <Show when={sectionBusy(section())}>
                <span data-slot="corp-permission-busy" title={language.t("corp.permissions.saving")} />
              </Show>
              <SelectV2
                appearance="inline"
                data-action="corp-permissions-bulk"
                data-section={sectionId}
                options={bulkOptions(section())}
                placement="bottom-end"
                gutter={6}
                disabled={disabled()}
                current={bulkOption()[sectionMode(section()) ?? ""]}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => {
                  if (!option || option.value === "mixed") return
                  // Выбран тот же режим, что и действует, — писать нечего. Проверка обязательна:
                  // без неё повторный `onSelect` управляемого селектора замыкает цикл записи.
                  if (option.value === sectionMode(section())) return
                  const mode = option.value as CorpPermissionMode
                  const edit: PermissionEdit = {
                    rows: Object.fromEntries(section().tools.map((tool) => [tool.name, mode])),
                  }
                  // Wildcard двигает только селектор секции «Остальные» — он и никто больше.
                  if (sectionId === REST_GROUP_ID) edit.rest = mode
                  writer.push(edit)
                }}
              />
            </div>
            <Show when={!folded()[sectionId]}>
              <For each={section().tools.map((t) => t.name)}>
                {(toolName) => {
                  const tool = createMemo(() => section().tools.find((t) => t.name === toolName)!)
                  return (
                  <div
                    data-slot="corp-tool-row"
                    data-tool={toolName}
                    // Занятость и отказ — признаки СТРОКИ, а не экрана: по ним же их и видно.
                    data-busy={busy(toolName) ? "" : undefined}
                    data-rejected={rejectedOf(toolName) === undefined ? undefined : ""}
                  >
                    <span class="flex flex-col min-w-0">
                      <span class="text-14-regular text-text-strong truncate">{tool().title}</span>
                      <span data-slot="corp-tool-name" class="text-12-regular text-text-weak truncate">
                        {toolName}
                      </span>
                    </span>
                    <span class="flex-1" />
                    {/*
                      Отказ записи не молчит: строка говорит, что режим не сохранился, теми же
                      человеческими словами, что и прочие отказы ревизии 1.14. Техническая
                      подробность — в подсказке при наведении, а не в тексте: в тексте отказа
                      место объяснению и следующему шагу.
                    */}
                    <Show when={rejectedOf(toolName)}>
                      {(detail) => (
                        <span
                          data-slot="corp-tool-rejected"
                          title={
                            detail().length > 0
                              ? `${language.t("corp.permissions.notSaved")}. ${language.t("corp.error.connect.details", { code: detail() })}`
                              : language.t("corp.permissions.notSaved")
                          }
                        >
                          <Icon name="warning" size="small" />
                          <span class="text-12-regular">{language.t("corp.permissions.notSaved")}</span>
                        </span>
                      )}
                    </Show>
                    <Show when={busy(toolName)}>
                      <span data-slot="corp-permission-busy" title={language.t("corp.permissions.saving")} />
                    </Show>
                    {/* Тристейт: подложка под активной иконкой ПЕРЕЕЗЖАЕТ между позициями, а не
                        перекрашивается (`thumb` компонента `SegmentedControlV2`). Тон подложки
                        задаётся классом активного режима на самом контроле. */}
                    <SegmentedControlV2
                      thumb
                      class="corp-tristate"
                      data-action="corp-permission-tool"
                      data-tool={toolName}
                      data-mode={modeOf(toolName) ?? "none"}
                      value={modeOf(toolName) ?? null}
                      disabled={disabled()}
                      onChange={(value) => {
                        if (!value) return
                        // Занятая строка остаётся рабочей: правки сливаются очередью, и «туда-обратно»
                        // кончается последним нажатием, а не потерянным.
                        writer.push({ rows: { [toolName]: value as CorpPermissionMode } })
                      }}
                    >
                      <For each={MODES}>
                        {(mode) => (
                          <SegmentedControlItemV2
                            value={mode}
                            aria-label={language.t(MODE_HINT_KEY[mode])}
                            title={language.t(MODE_HINT_KEY[mode])}
                          >
                            <Icon name={MODE_ICON[mode]} size="small" />
                          </SegmentedControlItemV2>
                        )}
                      </For>
                    </SegmentedControlV2>
                  </div>
                  )
                }}
              </For>
            </Show>
          </div>
          )
        }}
      </For>
    </div>
  )
}

/**
 * Три случая выбора способа на странице коннектора (S-V28 п.4).
 *
 * | Состав способов карточки | Что на экране |
 * |---|---|
 * | доступен ровно один | выбора нет вовсе; способ назван подзаголовком шапки формы, сразу поле ввода |
 * | доступных больше одного | компактный ряд выбора над формой — по элементу на каждый ДОСТУПНЫЙ способ |
 * | доступных нет ни одного | формы нет; ни одного поля ввода |
 *
 * Критерий — число ДОСТУПНЫХ способов, а не общее их число (решение заказчика от 31.08 по макету,
 * экран 4). До него «доступен ровно один, а рядом лежит недоступный» давало `"list"`, и у ТЭГ, где
 * OAuth закрыт администратором, над формой висел выбор из одного нажимаемого элемента и одного
 * серого. Выбор из одного — не выбор; способ в такой карточке называет подзаголовок шапки.
 *
 * **Недоступный способ не рисуется вовсе** (решение заказчика от 31.08, вторая половина того же
 * решения): ни элементом выбора, ни приглушённой строкой под формой. Прежняя редакция S-V28 п.4
 * требовала обратного — «недоступный способ не прячется», — и на данных живого каталога это
 * означало строку «Корпоративная авторизация ТЭГ — OAuth-приложение ещё не выдано
 * администраторами» под каждой формой. Заказчик решил, что до выдачи OAuth-приложений слова «OAuth»
 * в сборке не будет вовсе: способ, которым нельзя подключиться, пользователю не нужен, а обещание
 * несуществующей возможности хуже молчания о ней.
 *
 * Код разбора способов при этом не тронут: `available` приходит из каталога (S-V28 п.3), и способ
 * с `available: true` появляется на экране сам, без правки этого файла.
 */
export function methodChoice(methods: CorpAuthMethodView[]): "single" | "list" | "none" {
  const available = methods.filter((method) => method.available)
  if (available.length === 0) return "none"
  if (available.length === 1) return "single"
  return "list"
}

/**
 * Сообщение проверки длины (S-D13 п.4) — **до** сети: запрос не уходит вовсе.
 *
 * Прочих проверок значения форма не делает: годность токена решает целевая система, а не догадка о
 * его виде. Пустое поле сообщения не даёт — там просто неактивна кнопка.
 */
export function lengthError(value: string, field: CorpAuthMethodField | undefined) {
  if (value === "") return undefined
  const min = bound(field?.min_length)
  const max = bound(field?.max_length)
  if (min !== undefined && value.length < min) return { key: "corp.connect.tooShort" as const, n: min }
  if (max !== undefined && value.length > max) return { key: "corp.connect.tooLong" as const, n: max }
  return undefined
}

/**
 * Подпись поля ввода (S-D13 п.8, S-I6) — или её отсутствие.
 *
 * Название способа стоит над формой всегда: в шапке формы, когда выбирать не из чего, и в элементе
 * выбора, когда способов несколько. Каталог вправе назвать поле так же, как назван сам способ, — и
 * тогда одно и то же название печатается дважды подряд, что человек читает как дефект данных.
 * Совпадающая подпись не рисуется; отличающаяся (например, «Токен» при способе «Токен сессии ТЭГ»)
 * рисуется как прежде. Подпись, которой в каталоге нет, пустой строки не оставляет.
 */
export function fieldLabel(method: CorpAuthMethodView): string | undefined {
  const label = method.field?.label?.trim()
  if (!label) return undefined
  return label === method.title.trim() ? undefined : method.field?.label
}

/** Граница длины поля: нечисловое значение границей не является и ничего не ограничивает (S-V24 п.2). */
function bound(value: number | string | undefined): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Ключ исхода проверки (S-V25 п.3, S-I1) — по ключу на исход, общего «не получилось» среди них нет.
 * Успех с названным пользователем и успех без имени — разные тексты, а не один с подстановкой.
 */
export function verifyKey(result: string, account: string | undefined) {
  if (result === "verified") return account ? "corp.connect.verify.verifiedAs" : "corp.connect.verify.verified"
  if (result === "account_missing") return "corp.connect.verify.accountMissing"
  if (result === "token_rejected") return "corp.connect.verify.tokenRejected"
  if (result === "verify_failed") return "corp.connect.verify.verifyFailed"
  return "corp.connect.verify.unreachable"
}

/**
 * Тон исхода проверки (макет заказчика, экран 4, блок «Что человек видит, когда не получилось»).
 *
 * Три класса отказа макета ложатся на три исхода правила один к одному: отказ токена — красный,
 * отсутствие связи — жёлтый, недоступность сервиса — нейтральный. Тон меняет **подачу**, а не
 * текст: фраза у каждого исхода своя и остаётся прежней (S-V25 п.3), и она же — носитель смысла:
 * цвет ничего не сообщает сверх неё и в чёрно-белой печати ничего не теряется.
 *
 * `account_missing` идёт с отказом токена намеренно: система запрос приняла, но пользователя не
 * назвала — токен не подтверждён, и это про токен, а не про сервис.
 */
export function verifyTone(result: string): "success" | "danger" | "warning" | "neutral" {
  if (result === "verified") return "success"
  if (result === "token_rejected" || result === "account_missing") return "danger"
  if (result === "verify_failed") return "neutral"
  return "warning"
}

/**
 * Ключ исхода обмена (S-V25 п.5). Три неуспешных исхода различимы и сливать их запрещено:
 * различается **то, что известно**, а не совет. Отсутствие обмена (`null`) не показывает ничего.
 */
export function exchangeKey(result: string | null | undefined) {
  if (result === "exchanged") return "corp.connect.exchange.exchanged"
  if (result === "exchange_denied") return "corp.connect.exchange.denied"
  if (result === "exchange_failed") return "corp.connect.exchange.failed"
  if (result === "exchange_unreachable") return "corp.connect.exchange.unreachable"
  return undefined
}

/**
 * Подключается ли карточка ВВОДОМ ТОКЕНА (S-D13 п.1 в редакции решения заказчика от 31.08, вечер).
 *
 * Заказчик, глядя на собранное приложение: «нет окна для вставки токена отдельного, которое
 * открывается по клику connect — в общем опять не по референсам». Прежнее правило отвечало на
 * другой вопрос — «есть ли на СТРАНИЦЕ встроенный блок подключения», — и отвечало «да» у любой
 * карточки `connect_mode: "direct"`, из-за чего форма ввода токена стояла на странице всегда, а у
 * фасадной карточки не открывалась вовсе. Теперь форма живёт **отдельным окном** ({@link
 * ConnectorConnect}), встроенного блока на странице нет ни в одном состоянии, а это правило
 * отвечает на вопрос «открывает ли действие шапки форму ввода токена».
 *
 * Правило одно на ОБА режима подключения (решение заказчика от 31.08, вечер): и `direct`, и
 * `facade` открывают одну и ту же форму — различие между ними осталось только в том, куда уходит
 * проверка (в саму систему или в корпоративный шлюз), и это решает сервер по данным каталога.
 * Прежде у фасадной карточки формы не было вовсе, а «Подключить» уводило в браузерный шаг.
 *
 * Способ **не пересчитывается на клиенте** (S-V28 п.3): оболочка спрашивает `connect_mode` и
 * `available`, которые пришли из `GET /corp/catalog`. Карточка с `connect_mode: "none"` формы не
 * получает даже с доступным способом `user_token` в наборе: подключение ей закрыто на уровне
 * карточки (S-V28 п.2), и на месте действия стоит причина, а не форма.
 */
export function connectByToken(card: CorpCatalogCard | undefined): boolean {
  if (!card) return false
  if (card.connect_mode !== "direct" && card.connect_mode !== "facade") return false
  return (card.auth_methods ?? []).some((method) => method.type === "user_token" && method.available)
}

/**
 * Видимость блока подключения на странице коннектора (S-D13 п.1; AC-333, AC-330, AC-334).
 *
 * Блок стоит на странице только у карточки `connect_mode: "direct"` и только пока коннектор
 * не подключён. В состоянии «Подключено» блока нет — успех виден бейджем и строкой под именем.
 * Исключение — `justConnected`: только что показанный успех держит блок на экране, чтобы
 * пользователь увидел результат подключения, прежде чем блок уйдёт.
 */
export function connectBlockVisible(
  card: { connect_mode?: string; state?: string } | undefined,
  justConnected: boolean,
): boolean {
  if (!card) return false
  if (card.connect_mode !== "direct") return false
  if (card.state === "connected" && !justConnected) return false
  return true
}

/**
 * Куда уходит введённый токен — текст под полем (макет заказчика, экран 4; решение заказчика от
 * 31.08, вечер).
 *
 * У карточки `mode: "facade"` за адресом коннектора стоит корпоративный шлюз: и проверка
 * (`auth_methods[].verify.url`), и рабочие запросы идут туда, а не в саму целевую систему. Общий
 * текст «уходит только в саму систему» на такой карточке был **неправдой**, и заказчик это назвал
 * прямо. Слова «Hub» в фасадном тексте нет намеренно (D-43): в сборке без Hub карточка `facade` с
 * разобранным `upstream` подключается ровно так же, и назвать в ней то, чего в сборке нет, нельзя.
 */
export function storageKey(card: CorpCatalogCard) {
  return card.mode === "facade" ? ("corp.connect.storageFacade" as const) : ("corp.connect.storage" as const)
}

/**
 * Причина отсутствия действия «Подключить» на уровне карточки (S-V28 п.2, S-I1).
 *
 * Ветвление идёт по `connect_mode_unavailable_code`, а **не** по одному лишь `connect_mode`:
 * `oauth_disabled` рисует действие неактивным с причиной рядом, `facade_needs_hub` — прежнее
 * поведение ревизии 1.11 дословно (действия нет, причина на его месте). Сливать эти два вида
 * запрещено.
 *
 * Текст причины у `oauth_disabled` — **общий** и OAuth не называет (решение заказчика от 31.08):
 * «Способ подключения пока не настроен». Прежний ключ
 * `corp.connectors.methodUnavailable.oauthDisabled` говорил «Подключение через OAuth пока
 * недоступно: приложение авторизации ещё не выдано» — то есть предъявлял пользователю способ, о
 * котором заказчик просил в этой сборке не упоминать. Сам код причины и обе ветви разбора не
 * тронуты: различие «способ» / «карточка» по-прежнему несут имена полей, а снятие запрета вернёт
 * действие само.
 */
export function connectUnavailableKey(card: CorpCatalogCard) {
  if (card.connect_mode_unavailable_code === "oauth_disabled")
    return "corp.connectors.connectMethodNotConfigured" as const
  if (card.connect_mode_unavailable_code === "facade_needs_hub") return "corp.connectors.facadeNeedsHub" as const
  if (card.connect_mode_unavailable_code === "no_method") return "corp.connect.noMethod" as const
  return undefined
}

/**
 * Форма подключения — ОТДЕЛЬНОЕ ОКНО, открываемое действием «Подключить» / «Заменить токен»
 * (S-D13 в редакции решения заказчика от 31.08, вечер; макет заказчика, экран 4).
 *
 * До этого решения та же форма стояла встроенным блоком посреди страницы коннектора и была там
 * всегда, пока карточка не подключена. Заказчик назвал это расхождением с макетом дословно: «нет
 * окна для вставки токена отдельного, которое открывается по клику connect». Экран 4 макета —
 * самостоятельный экран, а не блок страницы, и открывается он действием.
 *
 * Окно — то же `Dialog fit`, каким показывается подтверждение «Убрать из списка»: своей шапки у
 * него нет, потому что шапка нарисована в самой форме (значок, «Подключение <имя>», подзаголовок —
 * название способа), ровно как в макете. Оно кладётся поверх страницы коннектора через
 * `useDialog().push`, поэтому страница под ним остаётся живой и возвращается со своим состоянием.
 *
 * Форма одна на ОБА режима подключения (`direct` и `facade`): различие между ними — в том, куда
 * сервер отправит проверку, и оно решается по данным каталога, а не вёрсткой. Поле никогда не
 * предзаполняется — ни сохранённым токеном, ни его маской: сохранённого токена в оболочке нет
 * вовсе, она его не получает (S-V24 п.7).
 */
export const ConnectorConnect: Component<{
  card: CorpCatalogCard
  /**
   * Успех: окно закрывается само, а вызвавшая страница получает ключ заметки об обмене токена —
   * той самой технической строки, которой в основном виде не место (решение заказчика от 31.08,
   * вечер). Заметка живёт подсказкой на бейдже «Подключено», а результат подключения человек
   * читает так же, как в макете: карточка стала подключённой, в шапке — строка идентичности.
   */
  onConnected?: (exchangeNote: ReturnType<typeof exchangeKey>) => void
}> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const connect = useConnectToken()

  /** Та же карточка под тем же именем, что и на самой странице: значок формы берётся из неё же. */
  const entry = () => props.card

  const methods = createMemo(() => entry().auth_methods ?? [])
  /**
   * На экране живут только ДОСТУПНЫЕ способы (S-V28 п.4, решение заказчика от 31.08). Недоступные
   * разобраны и лежат в `methods()`, но не рисуются ни в ряду выбора, ни под формой.
   */
  const available = createMemo(() => methods().filter((method) => method.available))
  const choice = createMemo(() => methodChoice(methods()))

  const [chosen, setChosen] = createSignal<string | undefined>()
  const selected = createMemo(() => {
    const explicit = available().find((method) => method.id === chosen())
    return explicit ?? available()[0]
  })

  /**
   * Введённое значение живёт только в состоянии смонтированного компонента (S-D13 п.6): уход со
   * страницы его теряет, в адрес страницы и в хранилище браузера оно не попадает никогда.
   */
  const [token, setToken] = createSignal("")
  /**
   * Исход последней попытки. Отдельного признака «показывать ли его» больше нет: окно живёт ровно
   * одну попытку подключения — закрылось (успехом или «Отменой») и открылось заново — это НОВЫЙ
   * компонент с пустой мутацией. Прежде форма была встроена в страницу и не исчезала никогда,
   * поэтому ей требовался признак «этот исход уже стёрт кнопкой „Отмена“».
   */
  const result = createMemo(() => connect.data)
  const failure = createMemo(() => (connect.error ? connectTokenFailure(connect.error) : undefined))
  const length = createMemo(() => lengthError(token(), selected()?.field))

  /**
   * «Отмена» (макет заказчика, экран 4) — закрывает окно формы.
   *
   * До решения заказчика от 31.08 (вечер) форма была встроена в страницу, и «Отмена» очищала поле,
   * никуда не уводя: закрывать было нечего. Теперь форма — САМОСТОЯТЕЛЬНОЕ окно, и «Отмена» в нём
   * значит ровно то, что значит в любом окне приложения, — «я передумал». Ничего сохранённого она
   * при этом не трогает: отменяется начатый ввод, а не подключение (для него есть «Отключить» в
   * шапке страницы). Кнопка активна всегда: окно закрыть можно и с пустым полем.
   */
  function cancel() {
    setToken("")
    connect.reset()
    dialog.close()
  }

  function submit() {
    // Пустое поле и непройденная проверка длины запроса не создают; повторное нажатие во время
    // запроса второго запроса не создаёт (S-D13 п.4, п.5).
    if (connect.isPending || token() === "" || length()) return
    const method = selected()
    connect.mutate(
      {
        alias: props.card.alias,
        ...(method && methods().length > 1 ? { method: method.id } : {}),
        token: token(),
      },
      {
        // S-D13 п.7 в редакции решения заказчика от 31.08 (вечер): после успеха формы НЕТ.
        // Результат человек читает там же, где в макете, — на карточке: она стала «Подключено», и
        // в шапке появилась строка «учётная запись · способ · когда проверено». Прежде на месте
        // формы оставался блок «Подключено · Connected as …» с технической заметкой об обмене
        // токена, и заказчик назвал это расхождением с макетом.
        onSuccess: (data) => {
          if (data.verify_result !== "verified") return
          setToken("")
          props.onConnected?.(exchangeKey(data.exchange_result))
          dialog.close()
        },
      },
    )
  }

  return (
    <Dialog fit>
      <div class="flex flex-col gap-3 pl-6 pr-6 pt-6 pb-6" data-slot="corp-connect">
      {/* Шапка формы (макет заказчика, экран 4). Форма — САМОСТОЯТЕЛЬНЫЙ блок со своей шапкой, а не
          поле, воткнутое посреди страницы: крупный значок коннектора, заголовок «Подключение <имя>»
          и под ним подзаголовок — название способа. Значок тот же, что в шапке страницы и в строке
          витрины, и берётся он из тех же полей карточки: своего значка форма не выдумывает. */}
      <div data-slot="corp-connect-head">
        <ConnectorIcon title={entry().title} icon={entry().icon} color={entry().icon_color} size="large" />
        <span>
          {/* Имя коннектора — данные каталога и подставляется как есть (S-I6); переводится только
              обрамляющая фраза. */}
          <span class="text-16-medium text-text-strong">
            {language.t("corp.connect.title", { title: entry().title })}
          </span>
          {/* Подзаголовок — название способа. Печатается ровно тогда, когда выбирать не из чего:
              при выборе его несут сами элементы выбора, и второй раз оно не повторяется. Подпись
              способа — данные каталога, клиент их не переводит (S-I6). */}
          <Show when={choice() === "single" ? selected() : undefined}>
            {(method) => <span class="text-12-regular text-text-weak">{method().title}</span>}
          </Show>
        </span>
      </div>

        {/* Выбор способа — только когда ДОСТУПНЫХ больше одного (случай 2 таблицы S-V28 п.4), и
            стоит он компактным рядом НАД формой, как в макете. Выбор из одного элемента не выбор:
            в случае 1 способ назван подзаголовком шапки выше, а недоступные способы вместе с
            причинами стоят приглушёнными строками ПОД формой — они не спрятаны ни в одном случае.

            Заголовок «Способ подключения» ушёл из отрисовки в `aria-label` группы: голой строкой
            над списком названий он читался как сырая подпись поля данных, а не как выбор. Для
            скринридера группа названа по-прежнему, и текст ключа не тронут. */}
        <Show when={choice() === "list"}>
          <div
            data-slot="corp-connect-methods"
            role="radiogroup"
            aria-label={language.t("corp.connect.chooseMethod")}
          >
            <For each={available()}>
              {(method) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected()?.id === method.id ? "true" : "false"}
                  data-action="corp-connect-method"
                  data-method={method.id}
                  data-selected={selected()?.id === method.id ? "true" : undefined}
                  class="text-14-regular"
                  onClick={() => setChosen(method.id)}
                >
                  {/* Подпись способа — данные каталога, клиент их не переводит (S-I6). */}
                  {method.title}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* Случай 3: доступных способов нет ни одного — формы нет, поля ввода нет, кнопки нет. */}
        <Show when={selected()}>
          {(method) => (
            <div class="flex flex-col gap-3">
              {/* Подпись поля — из каталога (S-I6, S-D13 п.8). Она не печатается, когда дословно
                  повторяет название способа, уже стоящее выше: одно и то же слово дважды подряд
                  человек читает как дефект, а не как подпись. */}
              <Show when={fieldLabel(method())}>
                {(label) => (
                  <label class="text-12-regular text-text-weak" for={`corp-connect-${props.card.alias}`}>
                    {label()}
                  </label>
                )}
              </Show>
              {/*
                Видимое поле ввода (макет заказчика, экран 4). Оформление — правилом
                `[data-slot="corp-connect-token"]` в `dialog-shell.css`: класс
                `bg-background-element` просил токен, которого нет ни в одной теме приложения, и
                поле оставалось совершенно прозрачным — человек не видел, куда печатать.
              */}
              <input
                id={`corp-connect-${props.card.alias}`}
                data-slot="corp-connect-token"
                type={method().field?.secret === false ? "text" : "password"}
                autocomplete="off"
                // Окно открывается ради этого поля — курсор стоит в нём сразу (`onOpenAutoFocus`
                // окна ищет именно `[autofocus]`). Прежде фокус наводило отдельное действие
                // `corp-connect-focus` шапки страницы, потому что форма была встроена в страницу и
                // «Подключить» не открывало ничего, а только прокручивало к полю.
                autofocus
                placeholder={method().field?.placeholder ?? ""}
                value={token()}
                disabled={connect.isPending}
                onInput={(event) => setToken(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit()
                }}
              />
              {/* Где живёт введённое значение (макет заказчика, экран 4) — сразу под полем, как в
                  макете. Утверждение проверяемое: токен кладётся в `connector-credentials.json` с
                  правами `0o600` (S-V26 п.1), а уходит он туда, куда указывает карточка. Куда
                  именно — решает {@link storageKey} по режиму карточки: у `facade` за адресом
                  коннектора стоит корпоративный шлюз, и общий текст «уходит только в саму систему»
                  был бы на ней неправдой (решение заказчика от 31.08, вечер). */}
              <span class="text-12-regular text-text-weak" data-slot="corp-connect-storage">
                {language.t(storageKey(entry()))}
              </span>
              {/* Подсказка каталога и ссылка на документацию — ОДНОЙ приглушённой строкой под полем.
                  В макете их нет вовсе, но это данные каталога, и прятать их нельзя: без них человек
                  не знает, где взять токен. Поэтому они не спрятаны, а сделаны второстепенными по
                  весу — приглушённый текст в одну строку вместо двух самостоятельных блоков, каждый
                  из которых спорил за внимание с полем ввода.

                  Отсутствующее необязательное поле строки не рисует — пустой строки не появляется, и
                  сама строка не рисуется, когда нет ни подсказки, ни ссылки. */}
              <Show when={method().field?.hint || method().field?.docs_url}>
                <span class="text-12-regular text-text-weak" data-slot="corp-connect-note">
                  <Show when={method().field?.hint}>
                    {(hint) => <span data-slot="corp-connect-hint">{hint()}</span>}
                  </Show>
                  <Show when={method().field?.docs_url}>
                    {(docs) => (
                      <a
                        class="underline break-all"
                        data-slot="corp-connect-docs"
                        href={docs()}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {language.t("corp.connect.docs")}
                      </a>
                    )}
                  </Show>
                </span>
              </Show>
              <Show when={length()}>
                {(error) => (
                  <span class="text-12-regular text-text-error" data-slot="corp-connect-error">
                    {language.t(error().key, { n: error().n })}
                  </span>
                )}
              </Show>
              {/* Ряд кнопок макета: «Подключить» первичная, «Отмена» прозрачная. «Отмена» активна
                  всегда: она закрывает окно формы, а закрыть его можно и с пустым полем. */}
              <div data-slot="corp-connect-actions">
                <Button
                  size="small"
                  variant="primary"
                  data-action="corp-connect-submit"
                  disabled={connect.isPending || token() === "" || length() !== undefined}
                  onClick={() => submit()}
                >
                  {language.t("corp.connect.submit")}
                </Button>
                <Button
                  size="small"
                  variant="ghost"
                  data-action="corp-connect-cancel"
                  disabled={connect.isPending}
                  onClick={() => cancel()}
                >
                  {language.t("corp.connect.cancel")}
                </Button>
                <Show when={connect.isPending}>
                  <span class="text-12-regular text-text-weak" data-slot="corp-connect-pending" aria-busy="true">
                    &hellip;
                  </span>
                </Show>
              </div>
            </div>
          )}
        </Show>

        {/* Недоступных способов под формой нет (S-V28 п.4, решение заказчика от 31.08): способ с
            `available: false` не рисуется нигде — ни элементом выбора, ни приглушённой строкой.
            Прежде здесь стоял блок `corp-connect-methods-unavailable` со строками «способ —
            причина», и на живом каталоге он был ровно одной строкой: закрытым OAuth. Пока
            OAuth-приложения не выданы, пользователю о нём не говорится ничего.

            Разбор способов не тронут: `available` считает сервер (S-V28 п.3), и способ, ставший
            доступным, появится в ряду выбора выше сам. */}

      {/* S-D13 п.6: исход показывается В ТОЙ ЖЕ ФОРМЕ — не тостом на витрине и не в другой части
          страницы. На экране остаются только НЕУСПЕШНЫЕ исходы: успех формы не рисует, потому что
          после успеха формы нет вовсе (решение заказчика от 31.08, вечер), а неуспех обязан
          остаться перед глазами вместе с введённым значением, чтобы человек исправил опечатку.
          Три класса отказа макета (экран 4) различаются тоном разметки, а не текстом. */}
      <Show when={result()}>
        {(outcome) => (
          <div
            data-slot="corp-connect-outcome"
            data-tone={verifyTone(outcome().verify_result)}
            role="alert"
          >
            <Icon name="warning" size="small" />
            <span class="text-12-regular" data-slot="corp-connect-verify">
              {language.t(verifyKey(outcome().verify_result, undefined), {
                status: outcome().verify_status ?? "",
              })}
            </span>
          </div>
        )}
      </Show>
      {/* Заметки об обмене токена здесь больше нет: она техническая («Постоянный токен выдать
          нельзя — подключение работает на введённом токене»), приходит только вместе с успехом, а
          после успеха формы нет. Ключ не потерян и текст не потерян: {@link exchangeKey} зовётся в
          `onSuccess`, и заметка живёт подсказкой на бейдже «Подключено» в шапке страницы
          (решение заказчика от 31.08, вечер). */}
      <Show when={connectFailureKey(failure())}>
        {(key) => (
          <div data-slot="corp-connect-outcome" data-tone="danger" role="alert">
            <Icon name="warning" size="small" />
            <span class="text-12-regular" data-slot="corp-connect-failure">
              {language.t(key())}
            </span>
          </div>
        )}
      </Show>
      </div>
    </Dialog>
  )
}

export const DialogConnector: Component<{ alias: string }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const action = useConnectorAction()
  const catalog = useCorpCatalog(() => true)

  /** Карточка берётся из каталога по alias, а не копируется в пропсы: после действия она обновится. */
  const card = createMemo(() => catalog.data?.servers.find((entry) => entry.alias === props.alias))

  /** Раскрыт ли список инструментов целиком (S-D11): выбор живёт только пока открыта страница. */
  const [allTools, setAllTools] = createSignal(false)

  /**
   * Заметка об обмене токена, пришедшая с последним успешным подключением (S-V25 п.5) — ключ
   * словаря либо `undefined`, когда обмена у способа нет вовсе.
   *
   * Живёт ПОДСКАЗКОЙ на бейдже «Подключено» и больше нигде (решение заказчика от 31.08, вечер):
   * «Постоянный токен выдать нельзя — подключение работает на введённом токене» — техническая
   * строка, и в основном виде страницы ей не место. Ставить её в подсказку, а не выбрасывать, —
   * потому что смысл в ней есть: она объясняет, почему подключение живёт ровно столько, сколько
   * живёт введённый токен. Заметка держится, пока открыта страница: она про ЭТО подключение, а не
   * свойство карточки, и после ухода со страницы утверждать её нечем.
   */
  const [exchangeNote, setExchangeNote] = createSignal<ReturnType<typeof exchangeKey>>()

  /**
   * Вид страницы (решение заказчика от 31.08): состав блоков зависит от состояния карточки.
   * Пока карточка не получена, страница показывает только крошку, и вид ни на что не влияет — но
   * значение у него всё равно должно быть определённым, и это `"catalog"`: про непришедшую карточку
   * неизвестно ничего, а вид `"account"` утверждал бы, что подключение состоялось.
   */
  const view = createMemo<ConnectorPageView>(() => {
    const entry = card()
    return entry ? pageView(entry) : "catalog"
  })

  /**
   * Задан ли адрес Hub в этой сборке (S-C10 п.7). Тот же признак, которым сервер решает судьбу
   * `open_hub`; отсутствие поля означает «сборка с Hub» — поведение до ревизии 1.11.
   */
  const hubConfigured = createMemo(() => catalog.data?.hub_configured !== false)

  /**
   * Подпись ошибки подключения (S-V19): объяснение своего класса и ничего сверх него.
   * Класс есть у любой неудачи, включая `unknown`, поэтому необъяснённой ошибки не бывает (D-32).
   *
   * Ревизия 1.14 убрала отсюда код ошибки. До неё код подставлялся прямо в предложение класса
   * `unknown` («Подключение не удалось: {{code}}») и приписывался в скобках к любому другому, а
   * приходит он от MCP-службы пустой строкой всякий раз, когда причина ей неизвестна. На экране
   * оставалось «Подключение не удалось:» — двоеточие, обещавшее причину, и пустота после него.
   * Теперь основной текст техники не содержит вовсе, а код живёт в подсказке (`details`).
   */
  function explain(entry: CorpCatalogCard): string | undefined {
    if (!entry.error_class && !entry.error) return undefined
    return language.t(connectErrorKey(entry.error_class))
  }

  /**
   * Технические подробности ошибки — подсказка при наведении (S-V19, ревизия 1.14).
   *
   * Пустого кода не бывает: пустая строка подсказкой не становится, и `title=""` на элементе не
   * появляется. Пользователю подсказка нужна, чтобы назвать код поддержке, а не чтобы читать её.
   */
  function details(entry: CorpCatalogCard): string | undefined {
    const code = entry.error?.trim()
    if (!code) return undefined
    return language.t("corp.error.connect.details", { code })
  }

  /**
   * «когда проверено» человеческим языком (макет заказчика от 30.08, экран 3). Время и дата
   * форматируются локалью приложения, а не выкладываются вручную: «21:40» и «28 августа» — это
   * `Intl` того же языка, каким говорит остальное окно.
   */
  function verified(entry: CorpCatalogCard): string | undefined {
    const shape = verifiedShape(entry.verified_at, new Date())
    if (!shape) return undefined
    if (shape.kind === "today")
      return language.t("corp.connector.verifiedToday", {
        time: new Intl.DateTimeFormat(language.intl(), { timeStyle: "short" }).format(shape.at),
      })
    if (shape.kind === "yesterday") return language.t("corp.connector.verifiedYesterday")
    return language.t("corp.connector.verifiedOn", {
      date: new Intl.DateTimeFormat(language.intl(), { day: "numeric", month: "long" }).format(shape.at),
    })
  }

  /**
   * Фраза «и ещё 59 — раскрывается по «Показать все»» с меткой на месте кликабельной части
   * (макет заказчика от 30.08, экран 2). Резать её на куски — дело `toolsRestSplit`.
   */
  function toolsRest(rest: number): string {
    return language.t("corp.connector.toolsRest", { rest, action: TOOLS_ACTION_MARK })
  }

  /** Части строки «учётная запись · способ · когда проверено» — только известные (экран 3). */
  function identity(entry: CorpCatalogCard): string[] {
    return identityParts(entry, connectionMethodTitle(entry), verified(entry))
  }

  /**
   * «Скопировать ссылку» (макет заказчика от 30.08, экран 2) — копируется адрес ДОКУМЕНТАЦИИ.
   *
   * Своей страницы у коннектора в вебе нет, копировать её адрес нечего; адрес документации —
   * честный аналог: человек получает ссылку, которой можно поделиться. Действие есть тогда и
   * только тогда, когда документация у карточки есть (`docs_url`).
   *
   * Подтверждение — тот же `showToast`, которым приложение подтверждает прочие копирования.
   * Копирование не состоялось (буфера нет, доступ запрещён) — об этом говорится тем же способом:
   * сказать «скопировано» о том, чего не произошло, приложение не вправе.
   */
  async function copyLink(url: string) {
    const copied = await writeClipboard(url)
    showToast(
      copied
        ? { variant: "success", title: language.t("corp.connector.linkCopied") }
        : { variant: "error", title: language.t("corp.connector.linkCopyFailed") },
    )
  }

  return (
    // Заголовок окна — настоящая хлебная крошка «‹ Коннекторы / <имя>» (макет заказчика от 30.08,
    // экраны 2 и 3): она называет и место, откуда пришёл человек, и место, где он сейчас. Первая
    // ступень — то же действие, что и «Назад» справа: возврат закрывает верхний диалог, и живая
    // витрина под ним всплывает со своей вкладкой, строкой поиска и позицией прокрутки (S-D11).
    // Крупное представление (значок, техническое имя, бейдж «устаревший») живёт в шапке страницы.
    <CorpDialog
      title={
        <span data-slot="corp-connector-crumbs">
          <button
            type="button"
            data-action="corp-connector-up"
            class="text-text-weak"
            onClick={() => dialog.close()}
          >
            <Icon name="chevron-left" size="small" />
            {language.t("corp.connectors.title")}
          </button>
          <span aria-hidden="true">/</span>
          <span class="truncate">{card()?.title ?? props.alias}</span>
        </span>
      }
      action={
        // Строка с хлебной крошкой макета несёт справа «Скопировать ссылку» (экран 2) — оно и
        // стоит крайним справа, как в макете; «Назад» осталось в том же ряду, левее.
        //
        // «Скопировать ссылку» есть ТОЛЬКО в виде «catalog»: в макете оно стоит на экране 2 и
        // отсутствует на экране 3 (решение заказчика от 31.08). Копируется адрес документации —
        // ссылка, которой делятся с тем, кто коннектор ещё НЕ подключил; у себя на пульте
        // управления уже подключённым она не нужна.
        <div class="flex items-center gap-2">
          <Button size="small" variant="ghost" onClick={() => dialog.close()}>
            {language.t("corp.connector.back")}
          </Button>
          <Show when={view() === "catalog" ? card()?.docs_url : undefined}>
            {(value) => (
              <Button
                size="small"
                variant="ghost"
                data-action="corp-connector-copy-link"
                onClick={() => void copyLink(value())}
              >
                {language.t("corp.connector.copyLink")}
              </Button>
            )}
          </Show>
        </div>
      }
    >
      {/* Прокручивается содержимое страницы внутри окна; окно целиком не прокручивается и высоту
          от длины описания или числа групп разрешений не меняет (S-D10). */}
      <div class="corp-connector">
        <Show when={card()}>
          {(entry) => (
            <>
              {/* 1. Шапка страницы (S-D11, макет заказчика от 30.08): крупный значок, название,
                  под ним техническое имя, справа — действие и меню из трёх точек. */}
              <div data-slot="corp-connector-hero">
                <ConnectorIcon title={entry().title} icon={entry().icon} color={entry().icon_color} size="large" />
                <div class="flex flex-col gap-0.5 min-w-0">
                  <span class="flex items-center gap-2 min-w-0">
                    <span class="text-16-medium text-text-strong truncate">{entry().title}</span>
                    {/* Бейдж «Подключено» РЯДОМ С ИМЕНЕМ (макет заказчика от 30.08, экран 3):
                        главное про коннектор человек читает там же, где его имя, а не строкой
                        ниже. Отдельная строка состояния при этом остаётся — она несёт ВСЕ
                        состояния, их тон и объяснение ошибки (S-V18, S-V19), а бейдж есть только
                        у подключённого, как в макете. Текст тот же, каким подключение названо в
                        блоке подключения после успеха: одно состояние — одно слово. Бейдж
                        нейтральный, как в макете: цвет состояния несёт строка ниже, а рядом с
                        именем стоит факт, а не тревога. */}
                    <Show when={entry().state === "connected"}>
                      {/* Подсказка бейджа — заметка об обмене токена, если она пришла с последним
                          подключением (см. `exchangeNote`). Пустой подсказки не бывает: без
                          заметки `title` на элементе не появляется вовсе. */}
                      <span title={exchangeNote() ? language.t(exchangeNote()!) : undefined}>
                        <Tag>{language.t("corp.connectors.connected")}</Tag>
                      </span>
                    </Show>
                    <Show when={entry().deprecated}>
                      <Tag>{language.t("corp.connectors.deprecated")}</Tag>
                    </Show>
                  </span>
                  {/* Строка под именем (макет заказчика от 30.08). У подключённого коннектора это
                      «учётная запись · способ · когда проверено» (экран 3) — ровно те части, что
                      известны; у остальных — короткая суть коннектора из каталога (экран 2):
                      «Каналы, треды, поиск и опросы корпоративного мессенджера».

                      Сути в карточке может не быть — тогда строка деградирует на техническое имя,
                      как было до ревизии 1.14: пусто под именем не остаётся и выдуманного там не
                      появляется. Само техническое имя из шапки ушло, но не пропало — оно стоит
                      свойством в строке ниже. */}
                  <span class="text-12-regular text-text-weak truncate" data-slot="corp-connector-subtitle">
                    {identity(entry()).length > 0
                      ? identity(entry()).join(" · ")
                      : (entry().summary ?? props.alias)}
                  </span>
                </div>
                <span class="flex-1" />
                {/* Предлагаемое действие показывается тем же элементом, которым выполняется
                    (S-V19): отдельной «кнопкой-советом» страница не обзаводится. Пустого ряда
                    действий не бывает — контейнер тогда не рисуется вовсе, а не висит пустой
                    полосой. Ссылки «Открыть в Hub» здесь нет ни в одном состоянии (решение
                    заказчика от 30.08): человек должен понимать, что он подключает, не выходя из
                    окна. */}
                <Show when={hasActions(entry())}>
                  <div class="flex items-center gap-2" data-slot="corp-connector-actions">
                    {/* S-V7, S-C10 п.8: подключение `facade` идёт через Hub-фасад, а Hub в этой
                        сборке нет — действия в наборе уже нет, и причина названа НА ЕГО МЕСТЕ, в
                        том же ряду (S-V28 п.4, AC-252). */}
                    <Show when={entry().connect_needs_hub}>
                      <span class="text-12-regular text-text-weak">
                        {language.t("corp.connectors.facadeNeedsHub")}
                      </span>
                    </Show>
                    {/* Действие, ОТКРЫВАЮЩЕЕ форму ввода токена отдельным окном (решение заказчика
                        от 31.08, вечер; макет, экран 4). Оно одно на оба режима подключения —
                        `direct` и `facade`, — потому что и форма одна: различие режимов в том, куда
                        сервер отправит проверку, а не в том, что видит человек. Роут `connect` при
                        этом не зовётся: alias с действующими прямыми учётными данными фасадом не
                        подключается (S-V29 п.1).

                        Прежде здесь стояли ДВА разных действия: у `direct` — кнопка, наводившая
                        фокус на форму, уже стоявшую посреди страницы, у `facade` — кнопка
                        браузерного шага, и формы у неё не было вовсе. Заказчик назвал это дословно:
                        «нет окна для вставки токена отдельного, которое открывается по клику
                        connect».

                        ПОДПИСЬ зависит от ВИДА страницы, а не от набора действий сервера (решение
                        заказчика от 31.08). Вид «catalog» — коннектор человеку ещё не принадлежит:
                        сохранённых учётных данных нет, заменять нечего, и в макете (экран 2) на
                        этом месте стоит ровно одно слово — «Подключить». «Заменить токен» живёт
                        только в виде «account», где токен и правда есть. Прежде подпись бралась
                        одна на оба вида, и карточка с действием `reconnect` от сервера (была
                        подключена когда-то, данных не осталось) предлагала заменить то, чего у
                        неё нет. */}
                    <Show when={connectByToken(entry())}>
                      <Button
                        size="small"
                        data-action="corp-connect-open"
                        onClick={() =>
                          dialog.push(() => (
                            <ConnectorConnect card={entry()} onConnected={(note) => setExchangeNote(note)} />
                          ))
                        }
                      >
                        {language.t(view() === "catalog" ? "corp.connectors.connect" : "corp.connect.replace")}
                      </Button>
                    </Show>
                    <Show when={entry().actions.includes("connect") || entry().actions.includes("reconnect")}>
                      <Show when={!connectByToken(entry())}>
                        {/* S-V28 п.4: у карточки, которой сейчас нечем подключиться, действие
                            ОТРИСОВАНО неактивным, а не спрятано — спрятанное действие неотличимо от
                            несуществующего. Прячется (решением заказчика от 31.08) не действие, а
                            НАЗВАНИЕ закрытого способа: причина рядом с кнопкой общая. Ветвление
                            идёт по `connect_mode_unavailable_code`, а не по одному лишь
                            `connect_mode`: у `facade_needs_hub` действует прежнее правило ревизии
                            1.11 (кнопки нет, причина названа в блоке состояния). */}
                        <Button
                          size="small"
                          data-action="corp-connect"
                          disabled={
                            action.isPending ||
                            entry().blocked ||
                            entry().connect_mode_unavailable_code === "oauth_disabled"
                          }
                          onClick={() => {
                            if (entry().connect_mode_unavailable_code === "oauth_disabled") return
                            action.mutate({
                              kind: "connect",
                              alias: entry().alias,
                              ...(entry().preset ? { preset: entry().preset } : {}),
                            })
                          }}
                        >
                          {/* S-V16 давал состоянию 3 подпись «Повторить»: попытка уже была, и
                              честнее это назвать. Решением заказчика от 31.08 подпись в виде
                              «catalog» — всегда «Подключить», как в макете (экран 2): у карточки
                              без сохранённых данных человек начинает подключение с нуля, каким бы
                              ни был её прошлый опыт. В виде «account» прежнее правило в силе. */}
                          {language.t(
                            view() !== "catalog" && entry().actions.includes("reconnect")
                              ? "corp.connectors.retry"
                              : "corp.connectors.connect",
                          )}
                        </Button>
                      </Show>
                    </Show>
                    {/* Причина неактивного действия — в том же ряду, рядом с ним (S-V28 п.4).
                        `facade_needs_hub` сюда не попадает: у него кнопки нет вовсе, а причина
                        показана на её месте веткой выше — сливать эти две отрисовки запрещено.

                        Текст — ОБЩИЙ, без слова «OAuth» (решение заказчика от 31.08): пользователю
                        сообщается, что способа подключения пока нет, а не то, какой именно способ
                        закрыт. Ключ берётся у `connectUnavailableKey`, чтобы текст этой строки и
                        текст той же причины в любом другом месте не разъезжались. */}
                    <Show when={entry().connect_mode_unavailable_code === "oauth_disabled"}>
                      <span class="text-12-regular text-text-weak" data-slot="corp-connect-disabled-reason">
                        {language.t("corp.connectors.connectMethodNotConfigured")}
                      </span>
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
                    {/* Меню из трёх точек (макет заказчика): редкое и необратимое действие
                        «Убрать из списка» (S-V17) живёт здесь, а не отдельной кнопкой внизу
                        страницы. Своё подтверждение у него осталось прежним. */}
                    <Show when={entry().actions.includes("forget")}>
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          as={IconButton}
                          icon="dot-grid"
                          size="small"
                          variant="ghost"
                          data-action="corp-connector-menu"
                          aria-label={language.t("corp.connector.menu")}
                          title={language.t("corp.connector.menu")}
                        />
                        <DropdownMenu.Portal>
                          {/* Меню портируется в `body` и там оказывается ПОД накладкой окна
                              (`dialog-overlay`, z-index 60), потому что своя у него 50. Приём тот
                              же, каким это решено у `select-v2`: z-index объявляется содержимому, а
                              Kobalte зеркалит его на позиционер. */}
                          <DropdownMenu.Content class="mt-1" data-slot="corp-connector-menu">
                            <DropdownMenu.Item
                              disabled={action.isPending}
                              onSelect={() => dialog.push(() => <DialogForgetConnector card={entry()} />)}
                            >
                              <DropdownMenu.ItemLabel>
                                {language.t("corp.connectors.forget")}
                              </DropdownMenu.ItemLabel>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                    </Show>
                  </div>
                </Show>
              </div>

              {/* 2. Статус: подпись состояния тем же тоном и тем же значком, что в колонке витрины
                  (S-V18), и объяснение ошибки подключения по её классу (S-V19). Причины, по которым
                  действие недоступно, живут не здесь, а в ряду действий шапки — рядом с самим
                  действием либо на его месте (S-V28 п.4).

                  Строка состояния есть только там, где ей есть что СКАЗАТЬ (решение заказчика от
                  31.08). Два тона из четырёх её не получают, потому что в макете их нет и потому
                  что оба дублируют соседа: «Подключено» уже стоит бейджем рядом с именем (экран 3),
                  а «Не подключено» на экране 2 не написано вовсе — про неподключённый коннектор это
                  говорит вся страница целиком, от кнопки «Подключить» до формы ввода токена.
                  Ошибочные состояния (`warning`, `danger`) показываются как прежде: честность
                  ошибок этим решением не трогается (S-V19), и объяснение под строкой — тоже. */}
              <div class="flex flex-col gap-2">
                <Show when={statusVisible(entry())}>
                  <span data-slot="corp-status-line" data-tone={statusTone(entry())}>
                    <span class="text-14-regular">{language.t(statusKey(entry()))}</span>
                  </span>
                </Show>
                <Show when={explain(entry())}>
                  {(value) => (
                    <span
                      class="text-12-regular text-text-weak"
                      data-slot="corp-connect-explain"
                      title={details(entry())}
                    >
                      {value()}
                    </span>
                  )}
                </Show>
                <Show when={entry().blocked}>
                  <span class="text-12-regular text-text-weak">{language.t("corp.connectors.stale")}</span>
                </Show>
              </div>

              {/* 3–5. Витрина товара: описание, свойства и плитки инструментов. Все три блока
                  живут ТОЛЬКО в виде «catalog» (макет заказчика, экран 2; решение заказчика от
                  31.08): на экране 3 подключённого коннектора их нет ни одного. Охранник вида
                  стоит НАД тройкой, а не внутри каждого блока: правило одно на все три, и
                  собственные условия блоков (есть ли описание, есть ли хоть одно свойство, есть ли
                  словарь инструментов) он не подменяет — они остаются на своих местах. */}
              <Show when={view() === "catalog"}>
              {/* 3. Описание — то, чего на витрине нет (S-D6, S-D11), и рисуется оно абзацами:
                  разделитель абзацев в данных — пустая строка. До ревизии 1.14 описание шло одним
                  блоком, и два абзаца слипались в стену текста. */}
              <Show when={descriptionParagraphs(entry().description).length > 0}>
                <div class="flex flex-col gap-3" data-slot="corp-connector-description">
                  <For each={descriptionParagraphs(entry().description)}>
                    {(paragraph) => <p class="text-14-regular" style={{ color: "var(--v2-text-text-base, #ffffff)" }}>{paragraph}</p>}
                  </For>
                </div>
              </Show>

              {/* 4. Свойства — ниже описания и мельче его (S-D11): одной строкой.
                  Заказчик от 01.09: из строки свойств убраны владелец и способ подключения,
                  осталась только документация. */}
              <Show when={entry().docs_url}>
                {(value) => (
                  <div class="text-12-regular text-text-weak" data-slot="corp-connector-properties">
                    <span data-slot="corp-connector-property" data-property="docs">
                      {language.t("corp.connector.docs")} &mdash;{" "}
                      <a
                        class="underline"
                        href={value()}
                        target="_blank"
                        rel="noreferrer"
                        title={value()}
                      >
                        {docsLabel(value(), entry().docs_label)}
                      </a>
                    </span>
                  </div>
                )}
              </Show>

              {/* 5. «Инструменты» (S-D11, ревизия 1.14): что именно коннектор умеет — видно ДО
                  подключения. Источник один — раздел `tools` словаря разрешений; словаря нет —
                  блока нет, выдумывать список не из чего.

                  На плитке стоит ТЕХНИЧЕСКОЕ имя моноширинным, как в утверждённом макете (экран 2:
                  `whoami`, `list_my_channels`, `get_channel_posts`), а человеческое имя из словаря
                  уходит в подсказку при наведении. Прежде было наоборот — заказчик это расхождение
                  отклонил 31.08. Человеческие имена при этом не пропали: экран разрешений строит по
                  ним каждую свою строку. */}
              <Show when={connectorTools(entry()).length > 0}>
                <div class="flex flex-col gap-2" data-slot="corp-connector-tools">
                  <span class="flex items-center gap-2">
                    <span class="text-14-medium text-text-strong">{language.t("corp.connector.tools")}</span>
                    <Tag>{connectorTools(entry()).length}</Tag>
                  </span>
                  <div data-slot="corp-tool-chips">
                    <For
                      each={
                        allTools() ? connectorTools(entry()) : connectorTools(entry()).slice(0, TOOLS_PREVIEW)
                      }
                    >
                      {(tool) => (
                        <span
                          data-slot="corp-tool-chip"
                          class="text-12-regular"
                          // Подсказка — человеческое имя, и ТОЛЬКО когда оно есть: у инструмента без
                          // строки в словаре `label` равен `name`, и подсказка повторяла бы плитку
                          // слово в слово. Пустой подсказки на плитке не остаётся.
                          title={tool.label === tool.name ? undefined : tool.label}
                        >
                          {tool.name}
                        </span>
                      )}
                    </For>
                  </div>
                  {/* Подпись под плитками — ОДНА ФРАЗА макета (экран 2): «и ещё 59 — раскрывается
                      по «Показать все»», где «Показать все» — кликабельная часть той же фразы, а не
                      кнопка рядом с ней. Прежде здесь стояли кнопка и отдельная приписка «и ещё 59»,
                      и заказчик 31.08 назвал это расхождением с макетом.

                      Фраза приходит из словаря целиком, вместе с кавычками и тире: разрезать её в
                      коде на «до» и «после» значило бы задать порядок слов за переводчика. Место
                      кликабельной части названо в самой строке подстановкой `{{action}}` — по ней
                      строка и делится на два куска, между которыми встаёт кнопка. Число настоящее:
                      сколько инструментов не поместилось, столько и сказано.

                      После раскрытия фразы нет: там «Свернуть», как было. */}
                  <Show when={connectorTools(entry()).length > TOOLS_PREVIEW}>
                    <Show
                      when={!allTools()}
                      fallback={
                        <div class="flex items-center gap-2">
                          <Button
                            size="small"
                            variant="ghost"
                            data-action="corp-tools-toggle"
                            onClick={() => setAllTools(false)}
                          >
                            {language.t("corp.connector.toolsLess")}
                          </Button>
                        </div>
                      }
                    >
                      <p class="text-12-regular text-text-weak" data-slot="corp-tools-rest">
                        {toolsRestSplit(toolsRest(connectorTools(entry()).length - TOOLS_PREVIEW))[0]}
                        <button
                          type="button"
                          data-action="corp-tools-toggle"
                          onClick={() => setAllTools(true)}
                        >
                          {language.t("corp.connector.toolsAll")}
                        </button>
                        {toolsRestSplit(toolsRest(connectorTools(entry()).length - TOOLS_PREVIEW))[1]}
                      </p>
                    </Show>
                  </Show>
                </div>
              </Show>
              </Show>

              {/* 6. Встроенного блока подключения на странице НЕТ ни в одном состоянии (решение
                  заказчика от 31.08, вечер; S-D13 п.1 в новой редакции). Форма ввода токена живёт
                  отдельным окном ({@link ConnectorConnect}) и открывается действием шапки —
                  «Подключить» в виде «catalog», «Заменить токен» в виде «account». Пока окно не
                  открыто, на странице стоит ровно то, что в макете: шапка, строка состояния при
                  ошибке и — по виду страницы — витрина товара либо «Разрешения».

                  Прежде здесь стоял блок с полем ввода, и стоял он всегда, пока карточка не
                  подключена: страница экрана 2 макета кончалась формой, которой в макете нет. */}
              {/* S-V26 п.3: запись хранилища перестала применяться (каталог сменил адрес сервера
                  или файл нечитаем) — карточка прямо об этом говорит, а не молчит. Это строка
                  СОСТОЯНИЯ, а не блок подключения: она ничего не предлагает ввести и правилом
                  «встроенного блока нет» не трогается. */}
              <Show
                when={entry().connect_mode === "direct" && entry().configured && entry().has_credentials === false}
              >
                <span class="text-12-regular text-text-weak" data-slot="corp-credentials-missing">
                  {language.t("corp.connect.credentialsMissing")}
                </span>
              </Show>

              {/* 7. «Разрешения»: блок есть всегда. Вид `permission_groups` — режим каждой группы
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
                      {/* Словарь версии 2 (раздел `tools` разобран) — экран ревизии 1.14: три
                          класса риска и строка на каждый инструмент. Словарь версии 1 раздела
                          `tools` не имеет, и экран деградирует на прежний вид по группам —
                          это проверяется, а не подразумевается (ТЗ §1). */}
                      <Show
                        when={toolSections(entry().permission_groups).length > 0}
                        fallback={<ConnectorPermissionGroups card={entry()} />}
                      >
                        <ConnectorPermissionTools card={entry()} />
                      </Show>
                    </Show>
                  </Show>
                </div>
              </Show>

            </>
          )}
        </Show>
      </div>
    </CorpDialog>
  )
}
