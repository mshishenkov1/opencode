import { corpEnabled } from "@opencode-ai/core/corp/constants"

/**
 * Минимальный словарь корпоративных экранов TUI (S-I4, S-I5).
 *
 * Используется **только** нашими экранами; upstream-строки TUI не трогаются. Язык берётся из
 * `OPENCODE_CORP_LANG` (`ru`/`en`), иначе `ru` при включённых корп-функциях, иначе `en`.
 */

const ru = {
  "login.title": "Вход через корпоративный SSO",
  "login.hub": "Hub",
  "login.code": "Код",
  "login.open": "Откройте в браузере",
  "login.waiting": "Ожидание подтверждения…",
  "login.copy": "скопировать код",
  "login.retry": "повторить",
  "login.otherProvider": "другой провайдер",
  "login.teamTitle": "Выберите команду",
  "login.success": "Вход выполнен",
  "login.cancelled": "Вход отменён",
  "login.browserFailed": "Не удалось открыть браузер — перейдите по адресу выше вручную",

  "connectors.title": "Коннекторы",
  "connectors.command": "Витрина коннекторов",
  "connectors.loginCommand": "Вход через корпоративный SSO",
  "connectors.search": "Поиск",
  "connectors.empty": "Каталог пуст",
  "connectors.hubDown": "Hub недоступен",
  "connectors.hubDownCached": "Hub недоступен, данные от",
  "connectors.needsLogin": "Требуется вход",
  "connectors.refresh": "обновить",
  "connectors.connect": "подключить",
  "connectors.reconnect": "переподключить",
  "connectors.disconnect": "отключить",
  "connectors.permissions": "права",
  "connectors.openHub": "открыть в Hub",
  "connectors.login": "войти",
  "connectors.authorizing": "⋯ Авторизация в браузере",
  "connectors.deprecated": "устаревший",
  "connectors.stale": "данные устарели, действия недоступны",
  "connectors.presetTitle": "Права коннектора",
  "connectors.reauth": "Требуется повторная авторизация",

  "status.connected": "✓ Подключён",
  "status.needs_auth": "⚠ Требуется авторизация",
  "status.not_connected": "○ Не подключён",
  "status.unavailable": "✗ Недоступен",

  "preset.readonly": "только чтение",
  "preset.readwrite": "чтение и запись",

  "error.corp_disabled": "Корпоративный режим не настроен",
  "error.hub_unavailable": "Hub недоступен",
  "error.hub_invalid_response": "Hub вернул неожиданный ответ",
  "error.login_expired": "Сессия входа истекла",
  "error.forbidden": "Доступ запрещён",
  "error.invalid_team": "Неизвестная команда",
  "error.team_selection_not_required": "Выбор команды не требуется",
  "error.rate_limited": "Слишком много попыток, повторите позже",
  "error.litellm_unavailable": "Сервис ключей недоступен",
  "error.litellm_invalid_response": "Сервис ключей вернул неожиданный ответ",
  "error.unauthorized": "Нужен вход: ключ не найден",
  "error.not_found": "Не найдено",
  "error.invalid_request": "Некорректный запрос",
  "error.unknown": "Неизвестная ошибка",
} as const

export type Key = keyof typeof ru

const en: Record<Key, string> = {
  "login.title": "Corporate SSO sign-in",
  "login.hub": "Hub",
  "login.code": "Code",
  "login.open": "Open in browser",
  "login.waiting": "Waiting for confirmation…",
  "login.copy": "copy code",
  "login.retry": "retry",
  "login.otherProvider": "other provider",
  "login.teamTitle": "Select a team",
  "login.success": "Signed in",
  "login.cancelled": "Sign-in cancelled",
  "login.browserFailed": "Could not open the browser — open the address above manually",

  "connectors.title": "Connectors",
  "connectors.command": "Connector catalog",
  "connectors.loginCommand": "Corporate SSO sign-in",
  "connectors.search": "Search",
  "connectors.empty": "Catalog is empty",
  "connectors.hubDown": "Hub unavailable",
  "connectors.hubDownCached": "Hub unavailable, data from",
  "connectors.needsLogin": "Sign-in required",
  "connectors.refresh": "refresh",
  "connectors.connect": "connect",
  "connectors.reconnect": "reconnect",
  "connectors.disconnect": "disconnect",
  "connectors.permissions": "permissions",
  "connectors.openHub": "open in Hub",
  "connectors.login": "sign in",
  "connectors.authorizing": "⋯ Authorizing in browser",
  "connectors.deprecated": "deprecated",
  "connectors.stale": "data is stale, actions unavailable",
  "connectors.presetTitle": "Connector permissions",
  "connectors.reauth": "Re-authorization required",

  "status.connected": "✓ Connected",
  "status.needs_auth": "⚠ Needs auth",
  "status.not_connected": "○ Not connected",
  "status.unavailable": "✗ Unavailable",

  "preset.readonly": "read only",
  "preset.readwrite": "read and write",

  "error.corp_disabled": "Corporate mode is not configured",
  "error.hub_unavailable": "Hub unavailable",
  "error.hub_invalid_response": "Hub returned an unexpected response",
  "error.login_expired": "Sign-in session expired",
  "error.forbidden": "Access denied",
  "error.invalid_team": "Unknown team",
  "error.team_selection_not_required": "Team selection is not required",
  "error.rate_limited": "Too many attempts, try again later",
  "error.litellm_unavailable": "Key service unavailable",
  "error.litellm_invalid_response": "Key service returned an unexpected response",
  "error.unauthorized": "Sign-in required: no key found",
  "error.not_found": "Not found",
  "error.invalid_request": "Invalid request",
  "error.unknown": "Unknown error",
}

export const dictionaries = { ru, en } as const

export function language(): "ru" | "en" {
  const explicit = process.env["OPENCODE_CORP_LANG"]?.toLowerCase()
  if (explicit === "ru" || explicit === "en") return explicit
  return corpEnabled() ? "ru" : "en"
}

export function t(key: Key): string {
  return language() === "ru" ? ru[key] : en[key]
}

/** Текст ошибки по стабильному коду корп-роутов (S-A5); неизвестный код отдаётся как есть. */
export function errorText(code: string | undefined): string {
  if (!code) return t("error.unknown")
  const key = `error.${code}` as Key
  return key in ru ? t(key) : code
}
