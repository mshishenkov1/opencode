/**
 * Корпоративный слой: build-константы (S-C2, S-C5).
 *
 * Константы подставляются бандлером (`define` в `packages/opencode/script/build.ts`) по образцу
 * `OPENCODE_VERSION` (F25). В dev-режиме и в ванильной сборке они не определены — тогда корпоративные
 * возможности выключены целиком (S-C5/S-C6) и поведение бинарника совпадает с upstream.
 */

declare global {
  const OPENCODE_CORP_HUB_URL: string
  const OPENCODE_CORP_CONFIG: string
}

function present(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/** Идентификатор провайдера корпоративной модели; он же ключ записи в auth-store (D-3). */
export const CORP_PROVIDER_ID = "magnit_prod"

/** Нормализация адреса Hub: пустое значение → `undefined`, хвостовые `/` отбрасываются (S-C2). */
export function normalizeHubUrl(value: string | undefined): string | undefined {
  const trimmed = present(value)
  return trimmed === undefined ? undefined : trimmed.replace(/\/+$/, "")
}

/** Адрес Hub из build-константы. */
export const CorpHubUrlBuild = normalizeHubUrl(
  typeof OPENCODE_CORP_HUB_URL === "string" ? OPENCODE_CORP_HUB_URL : undefined,
)

/** JSON корпоративного конфига из build-константы (сырой текст, разбирается слоем конфига, S-C3). */
export const CorpConfigBuild = present(typeof OPENCODE_CORP_CONFIG === "string" ? OPENCODE_CORP_CONFIG : undefined)

/**
 * Действующий адрес Hub (S-C5), в порядке убывания приоритета:
 * 1) `override` — флаг `--hub` команд `opencode corp *`;
 * 2) переменная окружения `OPENCODE_CORP_HUB_URL`;
 * 3) build-константа `OPENCODE_CORP_HUB_URL`.
 */
export function corpHubUrl(override?: string): string | undefined {
  return normalizeHubUrl(override) ?? normalizeHubUrl(process.env["OPENCODE_CORP_HUB_URL"]) ?? CorpHubUrlBuild
}

/** Корпоративные возможности включены, если известен адрес Hub (S-C5). */
export function corpEnabled(override?: string): boolean {
  return corpHubUrl(override) !== undefined
}

/**
 * Подпись пользователя для показа человеку (S-A13, D-19).
 *
 * Email может быть неизвестен: корпоративный LiteLLM его не возвращает, и Hub присылает поле
 * отсутствующим или `null`. В этом случае пользователь показывается по `user_id` — единственному
 * обязательному идентификатору. Пустая подстановка, «null» и «undefined» на экране запрещены,
 * поэтому пустая строка приравнивается к неизвестному email.
 */
export function corpUserEmail(user: { email?: string | null }): string | undefined {
  const email = typeof user.email === "string" ? user.email.trim() : ""
  return email === "" ? undefined : email
}

/** Значение подписи: email, а при неизвестном email — `user_id` (S-A13). */
export function corpUserLabel(user: { user_id: string; email?: string | null }): string {
  return corpUserEmail(user) ?? user.user_id
}
