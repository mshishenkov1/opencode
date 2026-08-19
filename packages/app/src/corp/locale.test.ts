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

describe("app/corp — язык по умолчанию (AC-94, AC-95)", () => {
  test("AC-94: при включённых корп-функциях неизвестная локаль сводится к ru", async () => {
    const corp = await localeIn({ VITE_OPENCODE_CORP_HUB_URL: "https://hub.test" })
    expect(corp.unknown).toBe("ru")
  }, 60_000)

  test("AC-94: при выключенных корп-функциях в том же сценарии — en", async () => {
    const vanilla = await localeIn({})
    expect(vanilla.unknown).toBe("en")
  }, 60_000)

  test("AC-95: явно выбранная локаль сохраняется и в корпоративном режиме", async () => {
    const corp = await localeIn({ VITE_OPENCODE_CORP_HUB_URL: "https://hub.test" })
    expect(corp.stored).toBe("en")
    expect(corp.storedRu).toBe("ru")
  }, 60_000)
})
