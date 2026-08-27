import type { Auth } from "@/auth"
import { Effect } from "effect"
import { CORP_PROVIDER_ID } from "./config"
import type * as CorpErrors from "./errors"
import * as CorpHub from "./hub"
import type * as CorpSchema from "./schema"

/**
 * Выход из корпоративного SSO (S-A14, S-A15).
 *
 * Выход состоит из двух по-разному надёжных частей: **отзыв ключа на сервере** (best effort) и
 * **удаление ключа у себя** (безусловно). Порядок обязателен — отзыв идёт до удаления, потому что
 * после удаления вызывать эндпоинт нечем: ключ и есть удостоверение вызова (S-A14 п.3).
 *
 * Модуль один на роут `POST /corp/logout` и на команду `opencode corp logout`: обе части и их
 * порядок описаны ровно в одном месте, иначе одна из оболочек рано или поздно поменяет порядок и
 * молча превратит выход в чисто локальный.
 */

export interface Outcome {
  /** Запись `magnit_prod` удалена из auth-store; `false` — её и не было (S-A14 п.5). */
  keyRemoved: boolean
  hub: CorpSchema.LogoutHubOutcome
  /** Код ошибки Hub при `hub:"unavailable"` (S-A5). */
  hubError?: CorpErrors.Code
  /**
   * Локальная часть не выполнена: запись auth-store не удалась. Наружу роутом не отдаётся — от неё
   * зависит **код выхода** команды (S-A15, D-49), а не форма ответа, которую фиксирует S-A1.
   */
  removeError?: string
}

export interface Input {
  /**
   * Auth-store (F58). Передаётся явно, а не берётся из контекста: иначе требование `Auth.Service`
   * протекло бы в окружение каждого обработчика корп-роутов, у которого служба и так уже есть.
   */
  auth: Auth.Interface
  /** Адрес Hub (S-C5); не задан — шага отзыва не существует вовсе (S-A14 п.6, сборка без Hub). */
  hubUrl?: string
  /** Подмена `fetch` в тестах — как у остальных вызовов Hub. */
  fetch?: typeof fetch
}

/**
 * Выполняет обе части выхода и описывает исход каждой (S-A14).
 *
 * Отказ Hub локальное удаление не отменяет и не откладывает: пользователь просил выйти у себя, и в
 * этом ему отказать нельзя (D-49). Ключ, который не удалось отозвать, остаётся живым на сервере — и
 * ответ говорит об этом честно, а не скрывает.
 */
export const perform = Effect.fn("CorpLogout.perform")(function* (input: Input) {
  const authSvc = input.auth
  const record = yield* authSvc.get(CORP_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
  const key = record?.type === "api" ? record.key : undefined

  // Идемпотентность (п.5): ключа нет — запрос к Hub не выполняется вовсе, и это не ошибка.
  if (key === undefined) return { keyRemoved: false, hub: "skipped" as const } satisfies Outcome

  // Шаг 1 — отзыв, best effort и строго до удаления (п.1, п.3).
  let hub: CorpSchema.LogoutHubOutcome = "skipped"
  let hubError: CorpErrors.Code | undefined
  if (input.hubUrl) {
    const client = CorpHub.make({
      hubUrl: input.hubUrl,
      key,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    })
    const revoked = yield* Effect.promise(() => client.logout())
    if (revoked.ok) hub = "revoked"
    else {
      hub = "unavailable"
      hubError = revoked.code
    }
  }

  // Шаг 2 — удаление, безусловно (п.2). Ошибка записи auth-store — единственный случай, когда
  // локальная часть не выполнена; исход серверной части от неё не зависит и не переписывается.
  const removed = yield* authSvc.remove(CORP_PROVIDER_ID).pipe(
    Effect.as(true as const),
    Effect.catch((error) => Effect.succeed(error.message || String(error))),
  )

  return {
    keyRemoved: removed === true,
    hub,
    ...(hubError === undefined ? {} : { hubError }),
    ...(removed === true ? {} : { removeError: removed }),
  } satisfies Outcome
})

/** Проекция исхода в ответ роута `POST /corp/logout` (S-A1): `removeError` наружу не уходит. */
export function toResult(outcome: Outcome): CorpSchema.LogoutResult {
  return {
    key_removed: outcome.keyRemoved,
    hub: outcome.hub,
    ...(outcome.hubError === undefined ? {} : { hub_error: outcome.hubError }),
  }
}
