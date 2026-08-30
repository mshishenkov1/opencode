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
 * `{type, url, enabled, oauth: false}` — и больше ничего: **без** блока `oauth` со `scope` (в прямом
 * режиме scope не участвует, D-57) и **без** ключа `headers` (D-60, S-V26 п.2). Ключ `headers` этот
 * патч не создаёт и не изменяет: если он у пользователя был, он остаётся как был и участвует в
 * слиянии заголовков (S-V26 п.4); если не было — его не появляется. Токен в конфиг не попадает ни
 * при каких обстоятельствах.
 *
 * **`oauth: false` — не «пустое поле», а разоружение MCP-OAuth** (D-63, MAJ-C ревью
 * `review-i4-rev113-2`).
 * `mcp/index.ts` считает OAuth выключенным **только** при `mcp.oauth === false`; у записи без ключа
 * `oauth` провайдер создаётся — это утверждает дословно пре-существующий upstream-тест
 * `test/mcp/headers.test.ts` («OAuth should be enabled by default»). Пока ключа не было, у любого
 * прямо подключённого корп-сервера MCP-OAuth оставался **вооружённым**, и цепочка `native`
 * достигалась в два разрешённых шага мимо корп-роутов: `POST …/connect-token` создаёт запись
 * `mcp.<alias>` (S-V25 п.6б), после чего upstream-роут `POST /mcp/:alias/auth/authenticate`
 * авторизует уже существующую запись. Довод S-V28 п.5 о пустоте этой дыры («записи запрет появиться
 * не даёт») опирается на строку 2 таблицы — роут `connect`; с ревизии 1.13 запись создаёт и
 * `connect-token`, в том числе на `native`-карточке с разобранным `upstream`, где прямое
 * подключение разрешено строкой 1 таблицы S-V7. Тем же одним значением прекращает действие и сам
 * upstream-роут: `MCP.startAuth` (`mcp/index.ts:764`) бросает на `mcpConfig.oauth === false` **до**
 * единого исходящего запроса — граница правила в upstream при этом не переносится и строки в
 * `corp/patches.md` не требуется: значение `oauth: OAuth | false` схема конфига upstream допускает
 * сама. Второе следствие того же ключа: S-V25 п.7 требует
 * от отказа целевой системы `401/403` исхода «соединение не поднимается, класс `token_rejected`», а
 * вооружённый провайдер на `401` запускал OAuth-поток транспорта (discovery, при неудаче DCR) — то
 * есть исходящие OAuth-запросы в сборке, где OAuth запрещён.
 *
 * Адрес — `upstream.url`, а **не** `mcp_url`: у `facade`-карточки `mcp_url` указывает на прокси
 * Hub, и подставить его сюда значило бы вернуть Hub в путь, из которого его убрал заказчик.
 */
export function directConnectPatch(alias: string, upstreamUrl: string): ConnectPatch {
  return { mcp: { [alias]: { type: "remote", url: upstreamUrl, enabled: true, oauth: false } } }
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
 * Что известно о **действующем подключении** alias в момент правки его записи (BLK-3, ревизия
 * 1.13.5). Оба поля обязательны и оба берутся у вызывающего: `permissionsPatch` — единственный
 * патч, который запись `mcp.<alias>` не создаёт, а **изменяет**, и обязанность S-V28 п.10
 * («создающие **или изменяющие** запись») держится здесь типом, а не текстом.
 */
export interface PermissionsConnection {
  /**
   * Подключён ли alias **прямым** способом. Признак — не режим карточки, а наличие учётных данных
   * (`has_credentials`, S-V26 п.3): у `facade`-карточки с разобранным `upstream` и способом
   * `user_token` строка 1 таблицы S-V7 даёт `connect_mode == "direct"`, то есть по режиму прямое
   * подключение не опознаётся вовсе. Ровно этим предикат `nativeConnectDisabled` мимо BLK-3 и
   * промахивался: он честно отвечает про **режим**, а действие относится к **способу**.
   */
  directConnected: boolean
  /**
   * Действующая запись `mcp.<alias>` (эффективный конфиг) либо `undefined`, если её нет. Нужна
   * потому, что разоружение D-63 переживает свой признак: `disconnect` удаляет учётные данные, но
   * оставляет в конфиге `{…, url: <адрес целевой системы>, oauth: false}`, а нечитаемый файл
   * хранилища по S-V26 п.5 трактуется как «данных нет». В обоих случаях `directConnected` уже
   * `false`, а запись всё ещё указывает на целевую систему и всё ещё разоружена.
   *
   * Тип берётся у самого конфига (`ConfigV1.Info["mcp"]`), а не у `ConfigMCPV1.Info`: значение
   * записи — union из трёх форм, третья (`{enabled}`) и есть то, что оставляет после себя
   * `disconnectPatch`.
   */
  current: NonNullable<ConfigV1.Info["mcp"]>[string] | undefined
}

/**
 * Разоружена ли запись `mcp.<alias>` (D-63): ключ `oauth` присутствует и равен **ровно** `false`.
 *
 * Единственное место, где это условие записано (S-V28 п.3): его спрашивают и патч прав, и охранник
 * браузерного шага в роуте `permissions`. `mcp/index.ts` считает MCP-OAuth выключенным ровно по
 * этому значению — у записи без ключа `oauth` провайдер создаётся (`test/mcp/headers.test.ts`).
 *
 * Проверяется **форма**, а не дискриминант `type`: запись в конфиге пользователя могла быть
 * дописана руками, а «Отключить» оставляет после себя `{enabled:false, …, oauth:false}` — третью
 * форму значения, которую допускает схема конфига.
 */
export function oauthDisarmed(entry: NonNullable<ConfigV1.Info["mcp"]>[string] | undefined): boolean {
  return entry !== undefined && "oauth" in entry && entry.oauth === false
}

/**
 * Патч для «Права» (S-V9): при `mode:"facade"` обновляется `mcp.<alias>.oauth.scope`.
 * Для `mode:"native"` локальный scope не меняется — возвращается `undefined`.
 *
 * **Ключ `oauth` не перевооружается никогда** (BLK-3, ревью `review-i4-rev113-3`). До ревизии
 * 1.13.5 этот патч переписывал `mcp.<alias>.oauth` с `false` на `{scope}` у любого alias с
 * `facade`-карточкой — то есть снимал разоружение D-63 у alias, подключённого **прямым** способом,
 * чей `url` указывает на **целевую систему**, а не на прокси Hub. Дальше оживало всё, что этим
 * одним значением закрыто: `MCP.startAuth` (`mcp/index.ts:764`) переставал бросать, и вместе с ним
 * возвращались upstream-роут `POST /mcp/:alias/auth/authenticate`, CLI `opencode mcp auth` и
 * подсказка оболочки при `needs_auth`; отказ целевой системы `401` снова уводил транспорт в
 * OAuth-поток вместо `token_rejected` (S-V25 п.7).
 *
 * Отказ — **два** независимых условия, и ни одно не покрывает другое:
 * 1) `directConnected` — способ подключения назван вызывающим по учётным данным;
 * 2) `current.oauth === false` — свойство самой записи, которое переживает и удаление учётных
 *    данных (`disconnect`), и нечитаемый файл хранилища (S-V26 п.5). Разоружённую запись этот
 *    патч не трогает, кем бы она ни была разоружена.
 *
 * Права в Hub при этом сохраняются как прежде: закрыт локальный ключ `oauth`, а не выбор пресета
 * (та же граница, что у охранника браузерного шага в роуте, S-V28 п.5).
 *
 * **`current: undefined` этой функции больше не подаётся** (MAJ-H, errata 1.13.6, §13 п.11).
 * Записи, которой в правимом слое нет, патч заводить не вправе: у alias без записи он давал
 * **обрывок** `mcp.<alias> = {oauth:{scope}}` — без `type` и без `url`, — а обрывок MCP-сервером не
 * является: `ConfigParse.schema` на нём БРОСАЕТ `ConfigInvalidError`, и бросает синхронно внутри
 * `Effect.fnUntraced`, то есть **дефектом**, мимо `orElseSucceed` в `Config.loadGlobal`. Наблюдение
 * зондом на настоящих роутах: сам `PUT …/permissions {preset}` отвечал `500` с пустым телом, а
 * следующий `GET /corp/catalog` — **тоже** `500`, потому что глобальный конфиг пользователя
 * оставался нечитаемым до правки файла руками. Отсечка стоит в роуте `permissions`
 * (`handlers/corp.ts`, `if (server && entry !== undefined)`) — там же, где читается `entry` и где
 * живёт охранник браузерного шага, чтобы оба решения принимались по одному значению одного слоя.
 * Здесь она НЕ продублирована намеренно: критерии AC-64 и AC-164 зовут эту функцию с
 * `current: undefined` и ждут патч, то есть закрепляют на уровне юнита ровно то поведение, которое
 * §13 п.11 запрещает. Тест не правится ролью dev — заведён `disputes/test-dispute-MAJ-H.json`.
 */
export function permissionsPatch(server: CorpSchema.CatalogServer, preset: string, connection: PermissionsConnection) {
  if (connection.directConnected) return undefined
  if (oauthDisarmed(connection.current)) return undefined
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
