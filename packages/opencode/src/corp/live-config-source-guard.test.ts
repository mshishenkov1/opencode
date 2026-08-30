import path from "path"
import { describe, expect, test } from "bun:test"

/**
 * Сторож класса BLK-4/MAJ-E (errata 1.13.6, S-V28 п.10ж): «единственный источник конфига корп-роутов
 * — `liveConfig()` = `configSvc.getGlobal()`; `configSvc.get()` в корп-обработчике не употребляется
 * нигде» (комментарий над `liveConfig` в `handlers/corp.ts`, ревью `review-i4-rev113-4`).
 *
 * Интеграционные тесты (`connect-token.test.ts` — BLK-4, `permission-state-live.test.ts` — MAJ-E)
 * ловят дефект в ДВУХ УЖЕ ИЗВЕСТНЫХ местах — охраннике роута `permissions` и своде `permission_state`
 * ветки `{modes}`. Наблюдательный сторож проверяет ровно то, что уже воспроизвёл прогоном; он молчит,
 * если тот же класс дефекта — прямой вызов `configSvc.get()` в обход `liveConfig()` — появится в
 * НОВОМ месте того же файла (например, в будущей ветке `providerEnable` или `catalog`). Этот сторож
 * ловит КЛАСС: грепом по исходнику, а не наблюдением поведения одной ветки.
 *
 * Комментарии исключены нарочно: сам файл неоднократно упоминает `` `configSvc.get()` `` дословно
 * внутри JSDoc, объясняя, почему им нельзя пользоваться (см. блок над `liveConfig`) — наивный греп
 * без вычитки комментариев горел бы всегда, независимо от кода.
 */

const HANDLER = path.resolve(import.meta.dirname, "../server/routes/instance/httpapi/handlers/corp.ts")

/**
 * Убирает комментарии (`//…` и `/*…*​/`), сохраняя содержимое строковых и шаблонных литералов —
 * `/` внутри путей вида `"/corp/catalog"` не должен читаться как начало комментария. Регэксп-литералы
 * в исходнике `handlers/corp.ts` не встречаются, поэтому неоднозначность `/` (комментарий vs деление
 * vs regex) здесь не возникает.
 */
function stripComments(source: string): string {
  let out = ""
  let index = 0
  let inLineComment = false
  let inBlockComment = false
  let inString: string | null = null
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        out += char
      }
      index++
      continue
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 2
        continue
      }
      index++
      continue
    }
    if (inString) {
      out += char
      if (char === "\\") {
        out += source[index + 1] ?? ""
        index += 2
        continue
      }
      if (char === inString) inString = null
      index++
      continue
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char
      out += char
      index++
      continue
    }
    if (char === "/" && next === "/") {
      inLineComment = true
      index += 2
      continue
    }
    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 2
      continue
    }
    out += char
    index++
  }
  return out
}

describe("греп-сторож: configSvc.get() запрещён в handlers/corp.ts вне комментариев (S-V28 п.10ж, BLK-4/MAJ-E)", () => {
  test("исходник не пуст и содержит хотя бы одно упоминание configSvc.get() ВНУТРИ комментария — сторож не ловит воздух", async () => {
    const source = await Bun.file(HANDLER).text()
    expect(source.length).toBeGreaterThan(0)
    // Предпосылка сторожа: наивный греп по исходнику (без вычитки комментариев) обязан был бы
    // сработать — иначе проверка "комментарии исключены нарочно" ничего не доказывает.
    expect(source).toContain("configSvc.get()")
  })

  test("configSvc.get() не встречается в исполняемом коде — ни разу, ни в одной ветке", async () => {
    const source = await Bun.file(HANDLER).text()
    const stripped = stripComments(source)
    const occurrences = stripped.match(/configSvc\.get\(\)/g) ?? []
    expect(occurrences.length).toBe(0)
  })

  test("configSvc.getGlobal() встречается ровно один раз — единственный источник объявлен один раз, в liveConfig()", async () => {
    const source = await Bun.file(HANDLER).text()
    const stripped = stripComments(source)
    const occurrences = stripped.match(/configSvc\.getGlobal\(\)/g) ?? []
    expect(occurrences.length).toBe(1)
    const at = stripped.indexOf("configSvc.getGlobal()")
    const liveConfigDecl = "const liveConfig = Effect.fnUntraced(function* ()"
    const liveConfigAt = stripped.indexOf(liveConfigDecl)
    expect(liveConfigAt).toBeGreaterThan(-1)
    // Единственное вхождение — внутри тела liveConfig(), а не где-то ещё в файле: следующее
    // объявление `Effect.fnUntraced`/`Effect.fn` идёт ПОСЛЕ него.
    const nextFnAt = stripped.indexOf("Effect.fn", liveConfigAt + liveConfigDecl.length)
    expect(at).toBeGreaterThan(liveConfigAt)
    if (nextFnAt > -1) expect(at).toBeLessThan(nextFnAt)
  })
})
