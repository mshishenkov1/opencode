import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * Канал сборки в интерфейсе (S-B3, S-B10; AC-140, AC-141).
 *
 * `packages/app/vite.js` — единственный источник канала: отсюда его берёт и `define` интерфейса
 * (`VITE_OPENCODE_CHANNEL`), и конфигурация electron-vite для главного процесса. Пока копий разбора
 * было две, корпоративная сборка «OpenCode Magnit» считала себя `dev`: рисовала в заголовке окна
 * ярлык DEV и включала непоказанные макеты интерфейса.
 *
 * Запуск: `bun --cwd packages/app test:unit src/corp/channel.test.ts`.
 */

const APP = path.resolve(import.meta.dirname, "../..")

let seq = 0

/**
 * Разбор канала из `packages/app/vite.js`.
 *
 * Спецификатор собирается переменной: файл лежит вне `include` пакета, и статический импорт ломает
 * `tsgo -b`, а трогать конфигурацию сборки ради теста нельзя.
 */
const resolveChannel = await (async () => {
  const specifier = "../../vite.js"
  const module = (await import(specifier)) as { resolveChannel: () => string }
  return module.resolveChannel
})()

function withChannel<T>(value: string | undefined, run: () => T): T {
  const saved = process.env["OPENCODE_CHANNEL"]
  if (value === undefined) delete process.env["OPENCODE_CHANNEL"]
  else process.env["OPENCODE_CHANNEL"] = value
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env["OPENCODE_CHANNEL"]
    else process.env["OPENCODE_CHANNEL"] = saved
  }
}

/** Умолчание непоказанных макетов интерфейса при заданном канале раздачи. */
async function newLayoutDesignsDefault(channel: string | undefined) {
  const saved = process.env["VITE_OPENCODE_CHANNEL"]
  if (channel === undefined) delete process.env["VITE_OPENCODE_CHANNEL"]
  else process.env["VITE_OPENCODE_CHANNEL"] = channel
  try {
    // Значение вычисляется при загрузке модуля, поэтому модуль импортируется заново.
    const specifier = `../context/settings.tsx?corp=${++seq}`
    const module = (await import(specifier)) as { newLayoutDesignsDefault: boolean }
    return module.newLayoutDesignsDefault
  } finally {
    if (saved === undefined) delete process.env["VITE_OPENCODE_CHANNEL"]
    else process.env["VITE_OPENCODE_CHANNEL"] = saved
  }
}

describe("разбор канала интерфейса (S-B3, S-B10)", () => {
  test("S-B3: latest и magnit дают канал корпоративной раздачи magnit", () => {
    expect(withChannel("magnit", resolveChannel)).toBe("magnit")
    expect(withChannel("latest", resolveChannel)).toBe("magnit")
  })

  test("S-B10: ванильные каналы остаются собой", () => {
    for (const channel of ["dev", "beta", "prod"]) {
      expect(withChannel(channel, resolveChannel), channel).toBe(channel)
    }
  })

  test("AC-141: незаданная и пустая переменная означают dev", () => {
    expect(withChannel(undefined, resolveChannel)).toBe("dev")
    expect(withChannel("", resolveChannel)).toBe("dev")
  })

  test("AC-140: неизвестное значение — ошибка с полученным значением и списком допустимых", () => {
    let error: unknown
    try {
      withChannel("corp", resolveChannel)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("неизвестный канал сборки: corp")
    for (const channel of ["dev", "beta", "prod", "magnit", "latest"]) {
      expect((error as Error).message).toContain(channel)
    }
  })
})

describe("канал доезжает до интерфейса (S-B3, S-B10)", () => {
  test("S-B3: magnit — канал раздачи: непоказанные макеты по умолчанию выключены", async () => {
    expect(await newLayoutDesignsDefault("magnit")).toBe(false)
    expect(await newLayoutDesignsDefault("prod")).toBe(false)
  })

  test("S-B3: preview-каналы оставляют непоказанные макеты включёнными", async () => {
    expect(await newLayoutDesignsDefault("dev")).toBe(true)
    expect(await newLayoutDesignsDefault("beta")).toBe(true)
    expect(await newLayoutDesignsDefault(undefined)).toBe(true)
  })

  test("S-B3: ярлык канала в заголовке окна рисуется только для dev и beta", () => {
    const source = fs.readFileSync(path.join(APP, "src/components/titlebar.tsx"), "utf8")
    const marker = /\[([^\]]*)\]\.includes\(import\.meta\.env\.VITE_OPENCODE_CHANNEL\)/.exec(source)
    expect(marker?.[1]).toBeDefined()
    const channels = marker![1]!.split(",").map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    expect(channels.sort()).toEqual(["beta", "dev"])
  })

  test("S-B10: интерфейс знает канал magnit в типах окружения", () => {
    const source = fs.readFileSync(path.join(APP, "src/env.d.ts"), "utf8")
    expect(source).toMatch(/VITE_OPENCODE_CHANNEL\?:[^\n]*"magnit"/)
  })
})
