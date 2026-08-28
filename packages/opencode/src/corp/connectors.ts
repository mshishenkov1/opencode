import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { McpCatalog } from "@/mcp/catalog"
import { Permission } from "@/permission"
import * as CorpSchema from "./schema"
import { DEFAULT_PRESET, oauthScope } from "./status"

/**
 * Действия витрины над конфигом (S-V7, S-V8, S-V9).
 *
 * Здесь только вычисление патчей конфига — чистые функции. Запись выполняет `Config.updateGlobal`
 * (F21, D-7): `POST /mcp/:name/connect` правит лишь runtime и ничего не персистит (F17).
 */

export interface ConnectPatch extends ConfigV1.Info {
  mcp: Record<string, ConfigMCPV1.Remote>
}

/**
 * Патч для «Подключить» (S-V7, шаг 1).
 * `oauth.scope` пишется только для `mode:"facade"` (D-5); для `native` ключ `oauth` не задаётся.
 */
export function connectPatch(server: CorpSchema.CatalogServer, preset: string = DEFAULT_PRESET): ConnectPatch {
  const scope = oauthScope(server, preset)
  const entry: ConfigMCPV1.Remote = {
    type: "remote",
    url: server.mcp_url,
    enabled: true,
    ...(scope === undefined ? {} : { oauth: { scope } }),
  }
  return { mcp: { [server.alias]: entry } }
}

/**
 * Патч прямого подключения (S-V25 п.6б, ревизия 1.13).
 *
 * `{type, url, enabled}` — и больше ничего: **без** ключа `oauth` (в прямом режиме scope не
 * участвует, D-57) и **без** ключа `headers` (D-60, S-V26 п.2). Ключ `headers` этот патч не создаёт
 * и не изменяет: если он у пользователя был, он остаётся как был и участвует в слиянии заголовков
 * (S-V26 п.4); если не было — его не появляется. Токен в конфиг не попадает ни при каких
 * обстоятельствах.
 *
 * Адрес — `upstream.url`, а **не** `mcp_url`: у `facade`-карточки `mcp_url` указывает на прокси
 * Hub, и подставить его сюда значило бы вернуть Hub в путь, из которого его убрал заказчик.
 */
export function directConnectPatch(alias: string, upstreamUrl: string): ConnectPatch {
  return { mcp: { [alias]: { type: "remote", url: upstreamUrl, enabled: true } } }
}

/**
 * Патч для «Отключить» (S-V8, шаг 3): запись `mcp.<alias>` из конфига не удаляется, только гасится,
 * чтобы повторное подключение оставалось в один клик.
 */
export function disconnectPatch(alias: string): ConfigV1.Info {
  // `Config.updateGlobal` применяет точечный патч через `patchJsonc` (F21), поэтому неполная запись
  // `mcp.<alias>` здесь корректна: остальные поля в файле не трогаются.
  return { mcp: { [alias]: { enabled: false } } } as unknown as ConfigV1.Info
}

/**
 * Патч для «Убрать из списка» (S-V17, шаг 2): ключ `mcp.<alias>` **удаляется** целиком, а не
 * переводится в `enabled:false`. В этом и есть разница с «Отключить» (D-31): пользователь просит
 * убрать сервер у себя, а не отложить его до следующего раза.
 *
 * `Config.updateGlobal` применяет патч через `patchJsonc` (F21): значение `undefined` по пути
 * `mcp.<alias>` удаляет свойство и не трогает остальные ключи конфига пользователя (S-C7).
 */
export function forgetPatch(alias: string): ConfigV1.Info {
  return { mcp: { [alias]: undefined } } as unknown as ConfigV1.Info
}

/**
 * Патч для «Права» (S-V9): при `mode:"facade"` обновляется `mcp.<alias>.oauth.scope`.
 * Для `mode:"native"` локальный scope не меняется — возвращается `undefined`.
 */
export function permissionsPatch(server: CorpSchema.CatalogServer, preset: string) {
  const scope = oauthScope(server, preset)
  if (scope === undefined) return undefined
  return { mcp: { [server.alias]: { oauth: { scope } } } } as unknown as ConfigV1.Info
}

/**
 * Требуется ли повторная авторизация после смены пресета (S-V9, I-3 R-B).
 * Расширение прав `readonly → readwrite` Hub помечает `needs_reauth`.
 */
export function needsReauth(previous: string | undefined, next: string, hubStatus: CorpSchema.ConnectionStatus) {
  if (hubStatus === "needs_reauth") return true
  if (previous === undefined) return false
  return previous !== next
}

// --- S-V21: применение разрешений по группам (ревизия 1.10) ---

/**
 * Ключ раздела `permission`, соответствующий инструменту `tool` коннектора `alias` (S-V21).
 *
 * Та же функция, которой именуются инструменты MCP (`McpCatalog.sanitize`, F48, F19), и та же
 * склейка через `_`, что в `MCP.tools`: иначе записанное правило не совпало бы с именем, по которому
 * инструмент спрашивает разрешение. Дефис в alias `sanitize` сохраняет (D-8).
 */
export function permissionKey(alias: string, tool: string) {
  return McpCatalog.sanitize(alias) + "_" + McpCatalog.sanitize(tool)
}

/**
 * Ключ-wildcard блока alias (S-V21): им накрыты инструменты вне групп — в том числе появившиеся у
 * сервера после публикации словаря. `*` не пропускается через `sanitize`: это шаблон, а не имя.
 */
export function permissionWildcardKey(alias: string) {
  return McpCatalog.sanitize(alias) + "_*"
}

/** Префикс блока alias: по нему и только по нему опознаётся «своё» в разделе `permission` (S-V21). */
export function permissionPrefix(alias: string) {
  return McpCatalog.sanitize(alias) + "_"
}

export interface PermissionGroupsDecision {
  /** Разобранный словарь групп карточки (S-V20): он задаёт и состав ключей, и их порядок. */
  groups: CorpSchema.PermissionGroups
  /**
   * Выбранные режимы по `id` группы; ключ `rest` — режим группы «Остальное». Группа, которой в
   * решении нет, сохраняет `default` каталога.
   */
  modes: Record<string, CorpSchema.PermissionMode>
  /**
   * Ключи раздела `permission` действующего конфига. Из них удаляются принадлежащие alias — знать,
   * что именно там лежало, иначе неоткуда: `patchJsonc` удаляет по имени ключа, а не по шаблону.
   */
  existing: readonly string[]
}

export interface PermissionGroupsPatch {
  /**
   * Вызов 1 (S-V21): все ключи `^<sanitize(alias)>_` гасятся значением `undefined` — тем же
   * способом, что `forgetPatch` удаляет `mcp.<alias>` (F21). Без этого шага в конфиге остались бы
   * ключи снятых инструментов, а порядок блока зависел бы от истории правок.
   */
  clear: ConfigV1.Info
  /**
   * Вызов 2 (S-V21): блок пишется целиком, **wildcard первым**. `Permission.evaluate` берёт
   * последнее совпавшее правило (`findLast`, F47), поэтому обратный порядок молча отменил бы все
   * явные правила. Порядок ключей — часть контракта записи (D-36).
   */
  write: ConfigV1.Info
  /** Ключи блока в порядке записи: первый — wildcard. Порядок здесь и есть результат правила. */
  keys: string[]
}

/**
 * Патчи детерминированной перезаписи блока alias (S-V21).
 *
 * Возвращаются **два** патча, а не один: сохранение выполняется двумя вызовами `Config.updateGlobal`
 * в этом порядке. Инкрементальная правка отдельных ключей запрещена спецификацией.
 *
 * Инструмент, попавший сразу в две группы, получает один ключ — по первой группе в порядке каталога:
 * повторная запись того же ключа сдвинула бы значение, но не позицию, и порядок перестал бы читаться
 * из словаря.
 */
export function permissionGroupsPatch(alias: string, input: PermissionGroupsDecision): PermissionGroupsPatch {
  const prefix = permissionPrefix(alias)
  const clear: Record<string, undefined> = {}
  for (const key of input.existing) if (key.startsWith(prefix)) clear[key] = undefined

  const restMode = input.modes[CorpSchema.REST_GROUP_ID] ?? input.groups.rest?.default ?? CorpSchema.REST_DEFAULT_MODE
  // Первым — wildcard: режим `rest` для всего, что не названо явно ниже (S-V21, ПРАВИЛО ПОРЯДКА).
  const write: Record<string, CorpSchema.PermissionMode> = { [permissionWildcardKey(alias)]: restMode }
  for (const group of input.groups.groups) {
    const mode = input.modes[group.id] ?? group.default ?? CorpSchema.REST_DEFAULT_MODE
    for (const tool of group.tools) {
      const key = permissionKey(alias, tool)
      if (key in write) continue
      write[key] = mode
    }
  }

  return {
    clear: { permission: clear } as unknown as ConfigV1.Info,
    write: { permission: write } as unknown as ConfigV1.Info,
    keys: Object.keys(write),
  }
}

/**
 * Свёртка действующих режимов групп (S-V23).
 *
 * Режим одного инструмента — результат `Permission.evaluate` по **действующему** конфигу для ключа
 * `<sanitize(alias)>_<sanitize(tool)>`, а не чтение ключа: правило-wildcard и вышележащие слои
 * конфига обязаны учитываться. Шаблон запроса — `"*"`, как у любого MCP-инструмента (`Session.tools`).
 *
 * Все инструменты группы в одном режиме → этот режим, иначе `mixed`. Ключ `rest` есть всегда и
 * считается по wildcard: пустой группы не бывает, поэтому `mixed` не может означать «пусто».
 */
export function permissionState(
  alias: string,
  groups: CorpSchema.PermissionGroups,
  permission: ConfigPermissionV1.Info | undefined,
): CorpSchema.PermissionState {
  const ruleset = Permission.fromConfig(permission ?? {})
  const modeOf = (key: string) => Permission.evaluate(key, "*", ruleset).action

  const state: Record<string, CorpSchema.PermissionStateMode> = {}
  for (const group of groups.groups) {
    let folded: CorpSchema.PermissionStateMode | undefined
    for (const tool of group.tools) {
      const mode = modeOf(permissionKey(alias, tool))
      if (folded === undefined) folded = mode
      else if (folded !== mode) {
        folded = "mixed"
        break
      }
    }
    state[group.id] = folded ?? "mixed"
  }
  state[CorpSchema.REST_GROUP_ID] = modeOf(permissionWildcardKey(alias))
  return state
}

/**
 * Значение колонки «Тип» (S-V22): `type` → при его отсутствии или пустоте `owner` → `undefined`
 * (пустая ячейка). Правило одно на обе оболочки — как `CorpStatus.compute` (S-Q9): TUI и Desktop
 * берут значение отсюда и сами его не выводят, поэтому разойтись не могут.
 *
 * Живёт в `@opencode-ai/core/corp/constants` — единственном корп-модуле, который видят и сервер, и
 * `packages/app`, и `packages/tui` (по образцу `corpUserLabel`). Здесь оно переэкспортировано,
 * чтобы серверный код продолжал брать все правила витрины из одного места.
 */
export { connectorType } from "@opencode-ai/core/corp/constants"

/** Ссылка «Открыть в Hub» (S-V10, I-3 §17). */
export function hubServerUrl(hubUrl: string | undefined, alias: string) {
  if (!hubUrl) return undefined
  return `${hubUrl.replace(/\/+$/, "")}/ui/servers/${encodeURIComponent(alias)}`
}
