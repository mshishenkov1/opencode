import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Option, Schema } from "effect"
import * as CorpConfig from "./config"
import * as CorpSchema from "./schema"
import { CorpPaths } from "@/server/routes/instance/httpapi/groups/corp"

/**
 * Роут выхода `POST /corp/logout` и роут возврата провайдера `POST /corp/provider/enable`
 * (S-A1, S-A14, S-C11; AC-279, AC-283, AC-300, AC-301).
 *
 * Обработчик поднимает половину сервера (`InstanceContextMiddleware`, `Config.Service`,
 * `Auth.Service`), поэтому, тем же приёмом, что в `permissions-route.test.ts`, здесь проверяется
 * то, что наблюдаемо без него: контракт путей и схем ответов, и **порядок шагов внутри самого
 * обработчика** — «отзыв до удаления», «инвалидация только после успешного удаления/патча» суть
 * утверждения о порядке, и они видны на исходнике текстом, без поднятия сервера.
 */

const decode = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownOption(schema)(value)

const HANDLER = path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/handlers/corp.ts")
const handlerSource = fs.readFileSync(HANDLER, "utf8")

/** Тело обработчика-генератора по его объявлению (приём из `permissions-route.test.ts`). */
function handlerBlock(marker: string) {
  const at = handlerSource.indexOf(marker)
  expect(at, `не найдено объявление ${marker} в обработчике корп-роутов`).toBeGreaterThan(-1)
  const args = handlerSource.indexOf("(", handlerSource.indexOf("function*", at))
  let round = 0
  let body = -1
  for (let index = args; index < handlerSource.length; index++) {
    if (handlerSource[index] === "(") round += 1
    else if (handlerSource[index] === ")") {
      round -= 1
      if (round === 0) {
        body = handlerSource.indexOf("{", index)
        break
      }
    }
  }
  expect(body, `не найдено тело ${marker}`).toBeGreaterThan(-1)
  let depth = 0
  for (let index = body; index < handlerSource.length; index++) {
    if (handlerSource[index] === "{") depth += 1
    else if (handlerSource[index] === "}") {
      depth -= 1
      if (depth === 0) return handlerSource.slice(body + 1, index)
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

describe("роут POST /corp/logout — путь, схема, порядок в обработчике (S-A1, S-A14; AC-279)", () => {
  test("AC-279: путь — /corp/logout, ответ описан схемой LogoutResult", () => {
    expect(CorpPaths.logout).toBe("/corp/logout")
    expect(Object.keys(CorpSchema.LogoutResult.fields).sort()).toEqual(
      ["key_removed", "hub", "hub_error", "revoke_error"].sort(),
    )
  })

  test("AC-279: обработчик зовёт CorpLogout.perform и инвалидирует конфиг ТОЛЬКО при keyRemoved", () => {
    const body = handlerBlock("const logout = Effect.fn(\"CorpHttpApi.logout\")")
    expect(body).toContain("CorpLogout.perform(")
    // Инвалидация — после удаления, а не безусловно: идемпотентный случай (ключа не было) конфиг
    // не трогает вовсе.
    expect(body).toContain("if (outcome.keyRemoved) yield* configSvc.invalidate()")
    // Ответ формируется проекцией одного и того же исхода — второй копии правила выхода в роуте нет.
    expect(body).toContain("return CorpLogout.toResult(outcome)")
    // Гейт — requireCatalog, а не requireHub: в сборке без Hub выход всё равно доступен (S-A14 п.6).
    expect(body).toContain("yield* requireCatalog()")
    expect(body).not.toContain("yield* requireHub()")
  })

  test("AC-279, AC-300: обработчик не выбрасывает ошибку ни при каком исходе Hub — HTTP-код всегда 200", () => {
    // Все четыре исхода Hub (S-A14 п.1) уходят в тело успешного ответа через `CorpLogout.toResult`,
    // а не в `CorpHubError`/`CorpDisabledError`: обработчик логаута ни разу не зовёт `Effect.fail`
    // и не пробрасывает `CorpHubError` (в отличие, например, от роутов витрины).
    const body = handlerBlock("const logout = Effect.fn(\"CorpHttpApi.logout\")")
    expect(body).not.toContain("Effect.fail")
    expect(body).not.toContain("CorpHubError")
    expect(body).not.toContain("throw ")
  })

  test("AC-279, AC-283: секреты в лог не попадают — только факт, исход и код ошибки (п.8)", () => {
    const body = handlerBlock("const logout = Effect.fn(\"CorpHttpApi.logout\")")
    const logCall = body.slice(body.indexOf('Effect.logInfo("corp logout"'), body.indexOf("if (outcome.removeError"))
    expect(logCall.length).toBeGreaterThan(0)
    for (const secret of ["record.key", "authSvc.get", "Authorization", "Bearer"]) expect(logCall, secret).not.toContain(secret)
    // Поле лога `key_removed` — булев признак (`outcome.keyRemoved`), а не сам ключ: сырого доступа
    // к значению ключа (`.key` не как часть `.keyRemoved`) в теле логирования нет.
    expect(/\.key(?!Removed)\b/.test(logCall)).toBe(false)
    // Код причины `not_revoked` уходит в лог дословно (S-A14 п.1, S-V3) — это единственное место,
    // где неизвестный код разбора остаётся виден.
    expect(logCall).toContain("revoke_error: outcome.revokeError")
  })
})

describe("схема LogoutResult — исход not_revoked не путается с unavailable (S-A14 п.1; AC-300)", () => {
  test("AC-300: revoke_error принимает значения из ответа Hub, hub:\"not_revoked\" разбирается", () => {
    for (const revokeError of ["not_permitted", "upstream_unavailable", "invalid_response"]) {
      const decoded = decode(CorpSchema.LogoutResult, { key_removed: true, hub: "not_revoked", revoke_error: revokeError })
      expect(Option.isSome(decoded), revokeError).toBe(true)
      if (Option.isNone(decoded)) continue
      expect(decoded.value.revoke_error).toBe(revokeError)
      expect("hub_error" in decoded.value).toBe(false)
    }
  })

  test("AC-300: неизвестный revoke_error схемой не отбрасывается — код объявлен строкой, а не набором (S-V3)", () => {
    // `revoke_error` объявлен `Schema.String`, а не закрытым перечислением: значение переносится
    // дословно, неизвестный код обязан дойти до лога (см. предыдущий describe), а не превратиться
    // в `hub_invalid_response` только потому, что схема его не узнала.
    const decoded = decode(CorpSchema.LogoutResult, {
      key_removed: true,
      hub: "not_revoked",
      revoke_error: "какой-то-новый-код-из-будущего",
    })
    expect(Option.isSome(decoded)).toBe(true)
  })

  test("AC-300: hub:\"unavailable\" и hub:\"not_revoked\" — разные литералы одного перечисления", () => {
    const notRevoked = decode(CorpSchema.LogoutResult, { key_removed: true, hub: "not_revoked", revoke_error: "not_permitted" })
    const unavailable = decode(CorpSchema.LogoutResult, { key_removed: true, hub: "unavailable", hub_error: "hub_unavailable" })
    expect(Option.isSome(notRevoked)).toBe(true)
    expect(Option.isSome(unavailable)).toBe(true)
    if (Option.isNone(notRevoked) || Option.isNone(unavailable)) return
    expect(notRevoked.value.hub).not.toBe(unavailable.value.hub)
    // Сливать поля тоже нельзя: у одного revoke_error, у другого hub_error.
    expect("revoke_error" in unavailable.value).toBe(false)
    expect("hub_error" in notRevoked.value).toBe(false)
  })

  test("AC-300: закрытая таблица из четырёх значений hub — пятого не существует", () => {
    expect(Option.isSome(decode(CorpSchema.LogoutHubOutcome, "revoked"))).toBe(true)
    expect(Option.isSome(decode(CorpSchema.LogoutHubOutcome, "not_revoked"))).toBe(true)
    expect(Option.isSome(decode(CorpSchema.LogoutHubOutcome, "unavailable"))).toBe(true)
    expect(Option.isSome(decode(CorpSchema.LogoutHubOutcome, "skipped"))).toBe(true)
    expect(Option.isSome(decode(CorpSchema.LogoutHubOutcome, "expired"))).toBe(false)
  })
})

describe("роут POST /corp/provider/enable — контракт и порядок (S-A1, S-C11 п.4; AC-301)", () => {
  const groupsSource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/groups/corp.ts"),
    "utf8",
  )
  const endpointBlock = groupsSource.slice(
    groupsSource.indexOf('HttpApiEndpoint.post("providerEnable"'),
    groupsSource.indexOf('HttpApiEndpoint.get("catalog"'),
  )

  test("AC-301: путь — /corp/provider/enable, тела у запроса нет", () => {
    expect(CorpPaths.providerEnable).toBe("/corp/provider/enable")
    expect(endpointBlock.length).toBeGreaterThan(0)
    // Ни имени провайдера, ни пути к файлу роут снаружи не принимает — оба вычисляет сервер:
    // у эндпоинта нет объявления `payload` (в отличие, например, от `connect`/`permissions`).
    expect(endpointBlock).not.toContain("payload:")
  })

  test("AC-301: идентификатор операции — плоский corp.providerEnable, как у соседей группы", () => {
    expect(endpointBlock).toContain('identifier: "corp.providerEnable"')
    // Точка внутри имени завела бы вложенный класс corp.provider.enable() в SDK — не должно быть.
    expect(endpointBlock).not.toContain('identifier: "corp.provider.enable"')
  })

  test("AC-301: ответ описан схемой с тремя состояниями", () => {
    const changed = decode(CorpSchema.ProviderEnableResult, { changed: true })
    expect(Option.isSome(changed)).toBe(true)

    const changedWithState = decode(CorpSchema.ProviderEnableResult, {
      changed: true,
      provider_disabled: { file: "/home/u/.config/opencode/config.json" },
    })
    expect(Option.isSome(changedWithState)).toBe(true)

    const notDisabled = decode(CorpSchema.ProviderEnableResult, { changed: false, reason: "not_disabled" })
    expect(Option.isSome(notDisabled)).toBe(true)

    const foreignLayer = decode(CorpSchema.ProviderEnableResult, {
      changed: false,
      reason: "foreign_layer",
      provider_disabled: { file: "/repo/opencode.json" },
    })
    expect(Option.isSome(foreignLayer)).toBe(true)

    // Причина — закрытая пара, третьего значения нет.
    expect(Option.isSome(decode(CorpSchema.ProviderEnableResult, { changed: false, reason: "unknown_reason" }))).toBe(
      false,
    )
  })

  test("AC-301: обработчик — providerDisabled() до любой правки; not_disabled — раньше foreign_layer", () => {
    const body = handlerBlock('const providerEnable = Effect.fn("CorpHttpApi.providerEnable")')
    const disabledAt = body.indexOf("providerDisabled()")
    const notDisabledAt = body.indexOf('reason: "not_disabled"')
    const foreignAt = body.indexOf('reason: "foreign_layer"')
    const updateAt = body.indexOf("configSvc.updateGlobal(patch)")
    const invalidateAt = body.indexOf("configSvc.invalidate()")
    for (const at of [disabledAt, notDisabledAt, foreignAt, updateAt, invalidateAt])
      expect(at, body).toBeGreaterThan(-1)
    // Признак вычислен раньше обеих отказных веток, а правка конфига — раньше инвалидации.
    expect(disabledAt).toBeLessThan(notDisabledAt)
    expect(disabledAt).toBeLessThan(foreignAt)
    expect(updateAt).toBeLessThan(invalidateAt)
    // «Не выключен» проверяется раньше «чужой слой» — снимать нечего решается первым.
    expect(notDisabledAt).toBeLessThan(foreignAt)
    // Патч и признак «чужой слой» вычисляются функциями модуля S-C11, а не второй копией разбора.
    expect(body).toContain("CorpConfig.enableProviderPatch(")
    expect(body).toContain("isGlobalConfigFile(disabled.file)")
  })

  test("AC-301: правится только глобальный слой — Config.updateGlobal, не Config.update (проектный)", () => {
    const body = handlerBlock('const providerEnable = Effect.fn("CorpHttpApi.providerEnable")')
    expect(body).toContain("configSvc.updateGlobal(patch)")
    expect(body).not.toContain("configSvc.update(")
  })
})

describe("CorpConfig.enableProviderPatch — правка ровно одного элемента (S-C11 п.4; AC-301, AC-293)", () => {
  test("AC-301: провайдер не выключен — undefined, править нечего", () => {
    expect(CorpConfig.enableProviderPatch(undefined)).toBeUndefined()
    expect(CorpConfig.enableProviderPatch([])).toBeUndefined()
    expect(CorpConfig.enableProviderPatch(["other"])).toBeUndefined()
  })

  test("AC-293: снят ровно один элемент magnit_prod, прочие сохранены в прежнем порядке", () => {
    const patch = CorpConfig.enableProviderPatch(["magnit_prod", "other"])
    expect(patch).toEqual({ disabled_providers: ["other"] })
  })

  test("AC-293: порядок элементов и повторы (если были) не переставляются, кроме снятого", () => {
    const patch = CorpConfig.enableProviderPatch(["a", "magnit_prod", "b", "c"])
    expect(patch).toEqual({ disabled_providers: ["a", "b", "c"] })
  })

  test("AC-301 п.4: массив, ставший пустым, остаётся пустым массивом, а не null/undefined", () => {
    const patch = CorpConfig.enableProviderPatch(["magnit_prod"])
    expect(patch).toEqual({ disabled_providers: [] })
    expect(Array.isArray(patch?.disabled_providers)).toBe(true)
  })
})
