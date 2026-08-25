import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type * as CorpSchema from "./schema"
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

/** Ссылка «Открыть в Hub» (S-V10, I-3 §17). */
export function hubServerUrl(hubUrl: string | undefined, alias: string) {
  if (!hubUrl) return undefined
  return `${hubUrl.replace(/\/+$/, "")}/ui/servers/${encodeURIComponent(alias)}`
}
