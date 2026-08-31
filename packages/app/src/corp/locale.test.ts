import { describe, expect, test } from "bun:test"
import path from "path"
import { corpBuildEnabled, corpBuildHubUrl } from "./enabled"

/**
 * Русский язык по умолчанию в корпоративной сборке (S-I2; AC-94, AC-95).
 *
 * Признак корпоративной сборки веб-UI приходит из `VITE_OPENCODE_CORP_HUB_URL` и вычисляется на
 * этапе загрузки модуля, поэтому оба режима проверяются отдельными процессами.
 */

const APP = path.resolve(import.meta.dirname, "../..")

async function localeIn(env: Record<string, string | undefined>) {
  const script = [
    `const m = await import(${JSON.stringify(path.join(APP, "src/context/language.tsx"))});`,
    `console.log(JSON.stringify({`,
    `  unknown: m.normalizeLocale("sw-KE"),`,
    `  stored: m.normalizeLocale("en"),`,
    `  storedRu: m.normalizeLocale("ru"),`,
    `}));`,
  ].join("\n")
  const childEnv = { ...process.env }
  delete childEnv["VITE_OPENCODE_CORP_HUB_URL"]
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  const proc = Bun.spawn({
    cmd: ["bun", "--preload", "./happydom.ts", "-e", script],
    cwd: APP,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`подпроцесс упал: ${err}`)
  return JSON.parse(out.trim().split("\n").pop()!) as { unknown: string; stored: string; storedRu: string }
}

describe("app/corp — признак корпоративной сборки (AC-94)", () => {
  test("AC-94: в обычной сборке веб-UI корп-режим выключен", () => {
    // Тесты пакета собираются без VITE_OPENCODE_CORP_HUB_URL — это ванильный режим (S-C6).
    expect(corpBuildHubUrl).toBeUndefined()
    expect(corpBuildEnabled).toBe(false)
  })
})

/**
 * Локаль, выбранная при загрузке модуля (`warm`), наблюдается по словарю, который модуль подгружает:
 * `if (warm !== "en") void loadDict(warm)`. Загрузку словаря перехватывает плагин Bun, поэтому
 * измеряется решение `detectLocale`, а не его копия в тесте.
 */
async function detectedLocale(input: { corp: boolean; languages: string[] }) {
  const script = [
    `globalThis.__loaded = []`,
    `Bun.plugin({`,
    `  name: "i18n-probe",`,
    `  setup(build) {`,
    `    build.onLoad({ filter: /i18n\\/[a-z]{2,3}\\.ts$/ }, async (args) => {`,
    `      globalThis.__loaded.push(args.path)`,
    `      return { contents: await Bun.file(args.path).text(), loader: "ts" }`,
    `    })`,
    `  },`,
    `})`,
    `Object.defineProperty(navigator, "languages", { value: ${JSON.stringify(input.languages)}, configurable: true })`,
    `await import(${JSON.stringify(path.join(APP, "src/context/language.tsx"))})`,
    `await Bun.sleep(300)`,
    `const loaded = [...new Set(globalThis.__loaded.map((file) => file.split("/").pop().replace(".ts", "")))]`,
    `console.log(JSON.stringify(loaded.filter((locale) => locale !== "en")))`,
  ].join("\n")

  const childEnv = { ...process.env }
  delete childEnv["VITE_OPENCODE_CORP_HUB_URL"]
  if (input.corp) childEnv["VITE_OPENCODE_CORP_HUB_URL"] = "https://hub.test"
  const proc = Bun.spawn({
    cmd: ["bun", "--preload", "./happydom.ts", "-e", script],
    cwd: APP,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  if ((await proc.exited) !== 0) throw new Error(`подпроцесс упал: ${err}`)
  const loaded = JSON.parse(out.trim().split("\n").pop()!) as string[]
  // Английский словарь встроен в модуль: если ничего сверх него не подгружено, выбран en.
  return loaded.length === 0 ? "en" : loaded[0]!
}

describe("app/corp — язык по умолчанию (AC-94, AC-95, AC-123)", () => {
  test("AC-94: локаль вне списка поддерживаемых даёт ru при включённых корп-функциях", async () => {
    expect(await detectedLocale({ corp: true, languages: ["sw-KE"] })).toBe("ru")
  }, 60_000)

  test("AC-94: та же локаль в ванильной сборке даёт en", async () => {
    expect(await detectedLocale({ corp: false, languages: ["sw-KE"] })).toBe("en")
  }, 60_000)

  // Решение заказчика от 31.08: в корпоративной сборке язык по умолчанию — русский независимо от
  // языка системы. Прежняя редакция S-I2 ставила совпадение с navigator.languages выше
  // корп-умолчания, и английская система давала английский интерфейс поверх русских данных.
  test("AC-123: язык системы не отменяет корп-умолчание ru", async () => {
    expect(await detectedLocale({ corp: true, languages: ["en-US"] })).toBe("ru")
    expect(await detectedLocale({ corp: true, languages: ["fr-FR"] })).toBe("ru")
    expect(await detectedLocale({ corp: true, languages: ["ru-RU"] })).toBe("ru")
  }, 60_000)

  test("AC-123: в ванильной сборке определение по navigator.languages сохранено", async () => {
    expect(await detectedLocale({ corp: false, languages: ["fr-FR"] })).toBe("fr")
  }, 60_000)

  test("AC-94: неизвестное сохранённое значение локали сводится к ru (корп) и к en (ваниль)", async () => {
    const corp = await localeIn({ VITE_OPENCODE_CORP_HUB_URL: "https://hub.test" })
    expect(corp.unknown).toBe("ru")
    const vanilla = await localeIn({})
    expect(vanilla.unknown).toBe("en")
  }, 60_000)

  test("AC-95: явно выбранная локаль сохраняется и в корпоративном режиме", async () => {
    const corp = await localeIn({ VITE_OPENCODE_CORP_HUB_URL: "https://hub.test" })
    expect(corp.stored).toBe("en")
    expect(corp.storedRu).toBe("ru")
  }, 60_000)
})
