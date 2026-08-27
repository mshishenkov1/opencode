import { describe, expect, test } from "bun:test"
import path from "path"
import { Option, Schema } from "effect"
import * as CorpSchema from "./schema"
import { CorpBadRequestError, CorpPaths, PermissionsPayload } from "@/server/routes/instance/httpapi/groups/corp"

/**
 * Роут применения разрешений (S-V1, S-V9, S-V21, S-V23; AC-206, AC-207, AC-212, AC-239).
 *
 * Ревизия 1.10 не заводит нового пути: тело существующего `PUT /corp/connectors/:alias/permissions`
 * получает второй, взаимоисключающий с `{preset}` вид `{modes}`. Ветка `modes` целиком локальна —
 * Hub в ней не участвует ни на шаг (D-35), — а прежняя ветка `{preset}` продолжает подтверждаться в
 * Hub через `PUT /api/me/connections/<alias>/permissions`.
 *
 * Обработчик поднимает половину сервера, поэтому проверяется то, что наблюдаемо без него: контракт
 * тела и ответа, набор путей и **порядок шагов в самом обработчике** — «до Hub дело не доходит» и
 * «до записи в конфиг дело не доходит» суть утверждения о порядке, и на исходнике они видны.
 */

const decode = <S extends Schema.Codec<any, any, never, never>>(schema: S, value: unknown) =>
  Schema.decodeUnknownOption(schema)(value)

const HANDLER = path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/handlers/corp.ts")
const handlerSource = await Bun.file(HANDLER).text()

/**
 * Тело генератора обработчика — по нему видно, какие шаги в нём есть и в каком порядке.
 *
 * Тело открывается фигурной скобкой после списка параметров `function* (…)`, а не первой скобкой
 * после маркера: у обоих обработчиков параметр — объектный тип, и он тоже в фигурных скобках.
 */
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

describe("корп-роут прав — путь и тело (S-V1; AC-239)", () => {
  test("AC-239: путь остался прежним, отдельного роута для групп не заведено", () => {
    expect(CorpPaths.permissions).toBe("/corp/connectors/:alias/permissions")
    // Ревизия 1.10 расширяет тело существующего роута, а не заводит второй способ сказать то же
    // самое: `permission-groups` в наборе путей нет.
    expect(Object.values(CorpPaths)).not.toContain("/corp/connectors/:alias/permission-groups")
    for (const value of Object.values(CorpPaths)) expect(value).not.toContain("permission-groups")
  })

  test("AC-239: тело принимает и {preset}, и {modes}; режим вне перечисления не принимается", () => {
    expect(Option.isSome(decode(PermissionsPayload, { preset: "readonly" }))).toBe(true)
    expect(Option.isSome(decode(PermissionsPayload, { modes: { read_posts: "allow", rest: "ask" } }))).toBe(true)
    expect(Option.isSome(decode(PermissionsPayload, { modes: { read_posts: "sometimes" } }))).toBe(false)
    // Взаимоисключение — правило запроса, а не формы: схема оба поля допускает, чтобы обработчик мог
    // отличить «переданы оба» от «поле пропущено».
    expect(Option.isSome(decode(PermissionsPayload, { preset: "readonly", modes: { rest: "ask" } }))).toBe(true)
  })

  test("AC-239: одновременные preset и modes — ошибка запроса 400 с названной причиной", () => {
    const error = new CorpBadRequestError({ error: "conflicting_body" })
    expect(error.error).toBe("conflicting_body")
    expect((CorpBadRequestError as any).ast.annotations.httpApiStatus).toBe(400)
    // Пустое тело тоже отвергается: молчаливый `readonly` снял бы права, о которых никто не просил.
    expect(new CorpBadRequestError({ error: "missing_body" }).error).toBe("missing_body")
  })

  test("AC-239: ответ несёт permission_state и reauth_required, а preset стал необязательным", () => {
    const groupsAnswer = decode(CorpSchema.PermissionsResult, {
      alias: "tag",
      status: "connected",
      reauth_required: false,
      permission_state: { read_posts: "allow", rest: "ask" },
    })
    expect(Option.isSome(groupsAnswer)).toBe(true)
    if (Option.isNone(groupsAnswer)) throw new Error("ожидался разбор")
    expect(groupsAnswer.value.reauth_required).toBe(false)
    expect(groupsAnswer.value.permission_state).toEqual({ read_posts: "allow", rest: "ask" })
    expect(groupsAnswer.value.preset).toBeUndefined()

    // Прежний вид ответа не изменён: `preset` заполнен, `permission_state` отсутствует.
    const presetAnswer = decode(CorpSchema.PermissionsResult, {
      alias: "gitlab",
      status: "connected",
      preset: "readonly",
      reauth_required: true,
    })
    expect(Option.isSome(presetAnswer)).toBe(true)

    // «Смешанно» — вычисляемое состояние группы, и в ответе оно допустимо (S-V23).
    expect(Option.isSome(decode(CorpSchema.PermissionState, { read_posts: "mixed" }))).toBe(true)
    expect(Option.isSome(decode(CorpSchema.PermissionState, { read_posts: "sometimes" }))).toBe(false)
  })
})

describe("корп-роут прав — ветка modes не ходит в Hub (S-V1, S-V21, D-35; AC-239)", () => {
  const permissions = handlerBlock("const permissions = Effect.fn(")
  const applyGroups = handlerBlock("const applyPermissionGroups = Effect.fnUntraced(")

  test("AC-239: запрос к Hub не выполняется вовсе — в ветке modes его нет", () => {
    expect(applyGroups).not.toContain("CorpHub")
    expect(applyGroups).not.toContain("hub.")
    expect(applyGroups).not.toContain("fetch(")
    // И `oauth.scope` она тоже не трогает — повторная авторизация не запускается (S-V9).
    expect(applyGroups).not.toContain("permissionsPatch")
    expect(applyGroups).not.toContain("authenticate")
    expect(applyGroups).toContain("reauth_required: false")
  })

  test("AC-239: ветка modes уходит раньше, чем обработчик добирается до Hub", () => {
    const branch = permissions.indexOf("ctx.payload.modes !== undefined) return")
    expect(branch, "ветка modes не найдена").toBeGreaterThan(-1)
    expect(permissions.indexOf("CorpHub.make")).toBeGreaterThan(branch)
    expect(permissions.indexOf("hub.setPermissions")).toBeGreaterThan(branch)
  })

  test("AC-239: при конфликте тела конфиг не изменяется — проверка стоит до любой записи", () => {
    const conflict = permissions.indexOf('error: "conflicting_body"')
    expect(conflict).toBeGreaterThan(-1)
    const missing = permissions.indexOf('error: "missing_body"')
    expect(missing).toBeGreaterThan(conflict)
    // Ни одной записи в конфиг и ни одного обращения к Hub до этих проверок в обработчике нет.
    const head = permissions.slice(0, conflict)
    expect(head).not.toContain("updateGlobal")
    expect(head).not.toContain("CorpHub")
    // Обе проверки — раньше ветки modes и раньше ветки preset.
    expect(permissions.indexOf("ctx.payload.modes !== undefined) return")).toBeGreaterThan(missing)
  })

  test("AC-239, AC-212: запись — ровно два updateGlobal подряд, состояние считается после них", () => {
    const clear = applyGroups.indexOf("updateGlobal(patch.clear)")
    const write = applyGroups.indexOf("updateGlobal(patch.write)")
    expect(clear).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(clear)
    expect(applyGroups.split("updateGlobal(").length - 1).toBe(2)
    // `permission_state` считается по конфигу ПОСЛЕ записи — иначе экран покажет вчерашнее.
    expect(applyGroups.indexOf("permissionState(")).toBeGreaterThan(write)
    // Словарь берётся из кэша каталога, а не запрашивается у Hub.
    expect(applyGroups).toContain("cachedServerFor")
  })

  test("AC-207: без разобранного словаря ветка modes ничего не пишет и называет причину", () => {
    const guard = applyGroups.slice(0, applyGroups.indexOf("updateGlobal"))
    expect(guard).toContain('error: "permission_groups_unavailable"')
    expect(guard).toContain("if (!parsed) return")
    expect(new CorpBadRequestError({ error: "permission_groups_unavailable" }).error).toBe(
      "permission_groups_unavailable",
    )
  })
})

describe("корп-роут прав — прежняя ветка {preset} не изменена (S-V9; AC-206)", () => {
  const permissions = handlerBlock("const permissions = Effect.fn(")

  test("AC-206: подтверждение по-прежнему уходит в Hub тем же вызовом", async () => {
    expect(permissions).toContain("hub.setPermissions(alias, preset, ctx.payload.groups)")
    const hub = await Bun.file(path.resolve(import.meta.dirname, "hub.ts")).text()
    expect(hub).toContain("`/api/me/connections/${encodeURIComponent(alias)}/permissions`")
  })

  test("AC-206: пресет по умолчанию и признак повторной авторизации остались прежними", () => {
    expect(permissions).toContain("ctx.payload.preset ?? CorpStatus.DEFAULT_PRESET")
    expect(permissions).toContain("CorpConnectors.needsReauth(previous, preset, updated.data.status)")
    expect(permissions).toContain("CorpConnectors.permissionsPatch(server, preset)")
  })
})
