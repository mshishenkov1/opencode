import type { Auth } from "@/auth"
import type { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { isRecord } from "@/util/record"
import { NamedError } from "@opencode-ai/core/util/error"
import { Effect, Schema } from "effect"
import { corpEnabled, CORP_PROVIDER_ID } from "./config"
import * as CorpDiagnostics from "./diagnostics"

/**
 * Обращение к корпоративной модели: проверки до запроса (S-C4b, S-C9, D-21, D-22).
 *
 * Две ситуации ломают целевой сценарий молча, и обе обязаны быть названы **до** обращения к LiteLLM:
 * 1) записи `magnit_prod` в auth-store нет — вход по SSO не выполнен (S-C4b). Запрос без заголовка
 *    `Authorization` не отправляется вовсе: на живом контуре он вернул бы 401, и пользователь увидел
 *    бы ошибку сервиса ключей вместо «вы не вошли». Ключ приходит только из auth-store: значение
 *    переменной `MAGNIT_COPILOT_KEY` ключом не считается;
 * 2) провайдер выключен личным конфигом (`disabled_providers`) — upstream отдаёт «модель не найдена»,
 *    что неотличимо от «вход не работает» (S-C9 п. 3).
 *
 * Ошибки поднимаются как дефекты: на HTTP-границе их разбирает `middleware/error.ts` (тем же путём,
 * что и ошибки конфига), в CLI — `FormatError` через `formatCliError`.
 */

/** Отображаемое имя корпоративной модели в текстах для человека (S-C4b, S-C9). */
export const CORP_MODEL_NAME = "Magnit Copilot"

export { CORP_PROVIDER_ID }

/** Тексты, которые видит пользователь при обращении к модели (S-C4b п. 1 и 3, S-C9 п. 3). */
export const MESSAGES = {
  /** Причина: записи `magnit_prod` в auth-store нет. */
  noKey: `Вход через корпоративный SSO не выполнен: нет ключа для ${CORP_MODEL_NAME}`,
  /** Действие, открывающее корп-экран входа (S-A6). */
  noKeyAction: "Войти через корпоративный SSO",
  /** Подсказка для неинтерактивного режима (S-C4b п. 3). */
  noKeyCliHint: "выполните opencode corp login",
  /** Провайдер выключен личным конфигом — вместо upstream-ошибки «модель не найдена». */
  providerDisabled: (file: string) =>
    `Провайдер ${CORP_MODEL_NAME} выключен в вашем конфиге (disabled_providers): ${file}`,
} as const

/** Вход по корпоративному SSO не выполнен: ключа для `magnit_prod` в auth-store нет (S-C4b). */
export const LoginRequiredError = NamedError.create("CorpLoginRequiredError", {
  message: Schema.String,
  /** Действие, открывающее корп-экран входа (S-A6). */
  action: Schema.String,
  /** Подсказка для неинтерактивного режима (S-C4b п. 3). */
  hint: Schema.String,
})

/** Провайдер корпоративной модели выключен личным конфигом пользователя (S-C9). */
export const ProviderDisabledError = NamedError.create("CorpProviderDisabledError", {
  message: Schema.String,
  /** Файл личного конфига, где записан `disabled_providers` — его называет и `corp status`. */
  file: Schema.String,
})

/**
 * Показывается ли корпоративный провайдер в списках моделей и провайдеров (решение заказчика
 * от 31.08).
 *
 * Провайдер `magnit_prod` приходит из корп-СЛОЯ КОНФИГА, а не из auth-store, поэтому в списках он
 * стоял всегда — и оставался там после выхода, предлагая выбрать модель, обратиться к которой
 * нечем. Заказчик назвал это расхождением с обещанием выхода: «выход убирает и ключ, и модель».
 *
 * Признак — ровно тот же, каким `guard` отличает «вошёл» от «не вошёл»: непустой ключ `api` в
 * auth-store. Ничего не удаляется и не правится: провайдер исчезает из ВЫДАЧИ, а его описание в
 * корп-слое остаётся на месте, и при следующем входе он возвращается сам, без перезапуска —
 * состояние провайдеров после смены ключа и так инвалидируется (S-A3, S-A14 п.4).
 *
 * В ванильной сборке (S-C6) правило молчит: корп-провайдера там нет вовсе.
 */
export function hiddenWithoutKey(input: { providerID: string; authenticated: boolean }): boolean {
  if (input.providerID !== CORP_PROVIDER_ID) return false
  if (!corpEnabled()) return false
  return !input.authenticated
}

/** Есть ли в auth-store пригодный ключ корпоративного провайдера (S-C4b): непустой ключ вида `api`. */
export function hasKey(record: { type: string; key?: string } | undefined): boolean {
  return record?.type === "api" && record.key !== undefined && record.key !== ""
}

/**
 * Проверка перед выдачей модели вызывающему (S-C4b, S-C9). Ничего не делает для чужих провайдеров и
 * в ванильной сборке (S-C6): корп-текстов там нет.
 *
 * `present` — есть ли провайдер в списке действующих. Причин его отсутствия теперь ДВЕ, и путать их
 * нельзя: выключен личным конфигом (`disabled_providers`) — тогда называется файл; ключа нет
 * (`hiddenWithoutKey`) — тогда говорится «вход не выполнен». Порядок сохранён с прежней редакции:
 * сперва спрашивается конфиг, потому что там пользователь выключил провайдера сам и сознательно.
 * Отсутствие по иной, неизвестной причине остаётся зоной upstream — его ошибка, его текст.
 */
export const guard = Effect.fnUntraced(function* (input: {
  providerID: string
  present: boolean
  config: Config.Interface
  auth: Auth.Interface
}) {
  if (input.providerID !== CORP_PROVIDER_ID) return
  if (!corpEnabled()) return

  if (!input.present) {
    const cfg = yield* input.config.get()
    if ((cfg.disabled_providers ?? []).includes(CORP_PROVIDER_ID)) {
      const directory = yield* InstanceState.directory
      const report = yield* Effect.promise(() =>
        CorpDiagnostics.inspect({ directory }).catch(() => CorpDiagnostics.EMPTY),
      )
      const file = report.providerDisabled?.file ?? directory
      return yield* Effect.die(new ProviderDisabledError({ message: MESSAGES.providerDisabled(file), file }))
    }
  }

  const record = yield* input.auth.get(CORP_PROVIDER_ID).pipe(Effect.orElseSucceed(() => undefined))
  if (hasKey(record)) return
  // Ключа нет. Провайдера в списках тоже нет — его убрало `hiddenWithoutKey`, — и назвать причину
  // обязано именно это место: «модель не найдена» от upstream сказало бы неправду про сборку.
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
  return data(input, LoginRequiredError.tag) !== undefined || data(input, ProviderDisabledError.tag) !== undefined
}

const line = (payload: Record<string, unknown>, key: string) =>
  typeof payload[key] === "string" ? (payload[key] as string) : undefined

/**
 * Текст корп-ошибки для CLI (S-C4b п. 3, S-C9 п. 3): причина, действие и подсказка отдельными строками.
 * `undefined` — ошибка не корпоративная, форматирование продолжает upstream.
 */
export function formatCliError(input: unknown): string | undefined {
  const login = data(input, LoginRequiredError.tag)
  if (login) {
    return [line(login, "message"), line(login, "action"), line(login, "hint")]
      .filter((value): value is string => value !== undefined)
      .join("\n")
  }
  const disabled = data(input, ProviderDisabledError.tag)
  if (disabled) return line(disabled, "message") ?? ""
  return undefined
}
