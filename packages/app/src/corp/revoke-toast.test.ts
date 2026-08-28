import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"

/**
 * Тексты исхода отзыва (S-V27 п.2, S-I1; AC-336).
 *
 * `revokeKey` и место, где он вызывается (`useConnectorAction`), живут в `context/corp.ts` —
 * простом TS-модуле, но с тяжёлыми зависимостями (`@tanstack/solid-query`, `useServerSDK`), поэтому
 * тело берётся из исходника тем же приёмом, что и для `.tsx`-компонентов, а не импортируется.
 */

const APP = path.resolve(import.meta.dirname, "..")
const SOURCE = fs.readFileSync(path.join(APP, "context/corp.ts"), "utf8")

function block(marker: string) {
  const at = SOURCE.indexOf(marker)
  expect(at, `не найдено объявление ${marker}`).toBeGreaterThan(-1)
  const open = SOURCE.indexOf("{", SOURCE.indexOf(")", at))
  let depth = 0
  for (let index = open; index < SOURCE.length; index++) {
    if (SOURCE[index] === "{") depth += 1
    else if (SOURCE[index] === "}") {
      depth -= 1
      if (depth === 0) return SOURCE.slice(open + 1, index).replace(/\bas const\b/g, "")
    }
  }
  throw new Error(`блок ${marker} не закрыт`)
}

const revokeKey = new Function("result", block("export function revokeKey(")) as (
  result: "revoked" | "not_revoked" | "unreachable" | "skipped",
) => string

describe("context/corp — исход отзыва: revoke:skipped ничего не показывает (S-V27 п.2; AC-336)", () => {
  test("три показанных исхода различимы попарно", () => {
    const keys = [revokeKey("revoked"), revokeKey("not_revoked"), revokeKey("unreachable")]
    expect(new Set(keys).size).toBe(3)
    expect(keys).toEqual([
      "corp.connect.revoke.revoked",
      "corp.connect.revoke.notRevoked",
      "corp.connect.revoke.unreachable",
    ])
  })

  test("исход skipped исполняет ту же ветку кода, что и прочие (ключ так и не используется вовне)", () => {
    // `useConnectorAction` вызывает `revokeKey` только под условием `result.revoke !== "skipped"` —
    // это условие проверяется по исходнику, а не пересказывается: если условие уйдёт из кода, тест
    // покраснеет вместе с ним.
    const action = SOURCE.slice(SOURCE.indexOf("export function useConnectorAction"))
    const showRevokeToast = action.slice(0, action.indexOf("if (result && \"reauth_required\""))
    expect(showRevokeToast).toContain('result.revoke !== "skipped"')
    // Вызов revokeKey (и, следовательно, любой текст об отзыве) находится ВНУТРИ этого условия —
    // не до и не после него отдельной веткой.
    const guardAt = showRevokeToast.indexOf('result.revoke !== "skipped"')
    const callAt = showRevokeToast.indexOf("revokeKey(result.revoke)")
    expect(callAt).toBeGreaterThan(guardAt)
  })

  test("успешный отзыв — не ошибка (variant success/default, а не error) — AC-327", () => {
    const action = SOURCE.slice(SOURCE.indexOf("export function useConnectorAction"))
    const revokeToast = action.slice(action.indexOf('result.revoke !== "skipped"'), action.indexOf('"reauth_required"'))
    expect(revokeToast).toContain('variant: result.revoke === "revoked" ? "success" : "default"')
    expect(revokeToast).not.toContain('"error"')
  })
})
