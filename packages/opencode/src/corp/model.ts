import type { Auth } from "@/auth"
import { isRecord } from "@/util/record"
import { NamedError } from "@opencode-ai/core/util/error"
import { Effect, Schema } from "effect"
import { corpEnabled, CORP_PROVIDER_ID } from "./config"

/**
 * Обращение к корпоративной модели: проверки до запроса (S-C4b, D-21).
 *
 * Если записи `magnit_prod` в auth-store нет, вход по SSO не выполнен — и запрос к LiteLLM **не
 * отправляется вовсе**: без заголовка `Authorization` он вернул бы 401, и пользователь увидел бы
 * ошибку сервиса ключей вместо «вы не вошли». Ключ приходит только из auth-store: значение
 * переменной `MAGNIT_COPILOT_KEY` ключом не считается.
 *
 * Ошибка поднимается как дефект: на HTTP-границе её разбирает `middleware/error.ts` (тем же путём,
 * что и ошибки конфига), в CLI — `FormatError` через `formatCliError`.
 */

/** Отображаемое имя корпоративной модели в текстах для человека (S-C4b). */
export const CORP_MODEL_NAME = "Magnit Copilot"

/** Тексты, которые видит пользователь при обращении к модели (S-C4b п. 1 и 3). */
export const MESSAGES = {
  /** Причина: записи `magnit_prod` в auth-store нет. */
  noKey: `Вход через корпоративный SSO не выполнен: нет ключа для ${CORP_MODEL_NAME}`,
  /** Действие, открывающее корп-экран входа (S-A6). */
  noKeyAction: "Войти через корпоративный SSO",
  /** Подсказка для неинтерактивного режима (S-C4b п. 3). */
  noKeyCliHint: "выполните opencode corp login",
} as const

/** Вход по корпоративному SSO не выполнен: ключа для `magnit_prod` в auth-store нет (S-C4b). */
export const LoginRequiredError = NamedError.create("CorpLoginRequiredError", {
  message: Schema.String,
  /** Действие, открывающее корп-экран входа (S-A6). */
  action: Schema.String,
  /** Подсказка для неинтерактивного режима (S-C4b п. 3). */
  hint: Schema.String,
})

/**
 * Проверка перед выдачей модели вызывающему (S-C4b). Ничего не делает для чужих провайдеров и в
 * ванильной сборке (S-C6): корп-текстов там нет.
 *
 * `present` — есть ли провайдер в списке действующих.
 */
export const guard = Effect.fnUntraced(function* (input: {
  providerID: string
  present: boolean
  auth: Auth.Interface
}) {
  if (input.providerID !== CORP_PROVIDER_ID) return
  if (!corpEnabled()) return
  if (!input.present) return

  const record = yield* input.auth.get(CORP_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
  if (record?.type === "api" && record.key !== "") return

  return yield* Effect.die(
    new LoginRequiredError({
      message: MESSAGES.noKey,
      action: MESSAGES.noKeyAction,
      hint: MESSAGES.noKeyCliHint,
    }),
  )
})

/** Разбор корп-ошибки в форме, в которой она приходит наружу: экземпляр, `toObject()` или тело ответа. */
function data(input: unknown, name: string): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  if (input["name"] !== name) return undefined
  const payload = input["data"]
  return isRecord(payload) ? payload : input
}

/** Корп-ошибка обращения к модели: её причина показывается пользователю вместо upstream-текста. */
export function isCorpModelError(input: unknown): boolean {
  return data(input, LoginRequiredError.tag) !== undefined
}

const line = (payload: Record<string, unknown>, key: string) =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined

/**
 * Текст корп-ошибки для CLI (S-C4b п. 3): причина, действие и подсказка отдельными строками.
 * `undefined` — ошибка не корпоративная, форматирование продолжает upstream.
 */
export function formatCliError(input: unknown): string | undefined {
  const login = data(input, LoginRequiredError.tag)
  if (login) {
    return [line(login, "message"), line(login, "action"), line(login, "hint")]
      .filter((value): value is string => value !== undefined)
      .join("\n")
  }
  return undefined
}
