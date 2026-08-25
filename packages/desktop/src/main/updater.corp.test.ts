import { beforeEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"

/**
 * Рантайм корпоративной сборки Desktop: выключенный апдейтер, унаследованное состояние и пункт меню
 * (S-B10, S-B11, S-Q10; AC-140, AC-141, AC-146, AC-147, AC-148).
 *
 * Сети нет: `electron`, `electron-store`, `electron-updater` и логгер подменены. Проверяется
 * наблюдаемое поведение — что уходит в лог, что происходит с записью `ready` в electron-store,
 * какой диалог видит пользователь и трогается ли `autoUpdater` вообще.
 *
 * Запуск: `bun --cwd packages/opencode test ../../packages/desktop/src/main/updater.corp.test.ts`
 * (или вместе со всеми корп-тестами: `bun --cwd packages/opencode test src/corp`).
 */

const UPDATE_URL = "https://updates.example.corp/opencode"

/** Содержимое подменённого electron-store: имя файла → пары ключ/значение. */
let files = new Map<string, Map<string, unknown>>()
/** Строки лога главного процесса. */
let logs: Array<{ message: string; data?: object }> = []
/** Диалоги, показанные пользователю. */
let dialogs: Array<{ message?: string; title?: string; buttons?: string[] }> = []
/** Обращения к `autoUpdater` — при выключенном апдейтере список обязан остаться пустым. */
let updaterOps: string[] = []
/** Вызовы остановки приложения (установка обновления). */
let stops = 0
/** Шаблон меню, переданный в `Menu.setApplicationMenu`. */
let menuTemplate: unknown

let seq = 0

class FakeStore {
  readonly name: string
  constructor(options: { name: string }) {
    this.name = options.name
  }
  private data() {
    let file = files.get(this.name)
    if (!file) files.set(this.name, (file = new Map()))
    return file
  }
  get(key: string) {
    return this.data().get(key)
  }
  set(key: string, value: unknown) {
    this.data().set(key, value)
  }
  delete(key: string) {
    this.data().delete(key)
  }
}

function autoUpdaterStub() {
  const target: Record<string, unknown> = {
    checkForUpdates: () => {
      updaterOps.push("call checkForUpdates")
      return Promise.resolve({ isUpdateAvailable: false })
    },
    downloadUpdate: () => {
      updaterOps.push("call downloadUpdate")
      return Promise.resolve()
    },
    quitAndInstall: () => updaterOps.push("call quitAndInstall"),
    on: () => updaterOps.push("call on"),
    once: () => updaterOps.push("call once"),
  }
  return new Proxy(target, {
    get(store, property) {
      const key = String(property)
      if (!(key in store)) updaterOps.push(`get ${key}`)
      return store[key]
    },
    set(store, property, value) {
      updaterOps.push(`set ${String(property)}`)
      store[String(property)] = value
      return true
    },
  })
}

function mockElectron(options: { isPackaged: boolean }) {
  const app = {
    isPackaged: options.isPackaged,
    getVersion: () => "1.17.9-magnit.1",
    getPath: () => "/tmp/opencode-corp-test",
    setName: () => {},
    setAppUserModelId: () => {},
  }
  const dialog = {
    showMessageBox: async (options: { message?: string; title?: string; buttons?: string[] }) => {
      dialogs.push(options)
      return { response: options.buttons ? 1 : 0 }
    },
  }
  // Набор экспортов задаётся первой подменой модуля в процессе, поэтому он одинаков во всех тестах.
  const Menu = {
    buildFromTemplate: (value: unknown) => value,
    setApplicationMenu: (value: unknown) => {
      menuTemplate = value
    },
  }
  const BrowserWindow = { getFocusedWindow: () => null }
  const shell = { openExternal: () => {} }
  mock.module("electron", () => ({
    app,
    dialog,
    Menu,
    BrowserWindow,
    shell,
    default: { app, dialog, Menu, BrowserWindow, shell },
  }))
  return { app, dialog }
}

/** Подменяет модули, к которым апдейтер обращается за окружением: сеть и диск не задействованы. */
function mockRuntime(options: { isPackaged?: boolean } = {}) {
  mockElectron({ isPackaged: options.isPackaged ?? true })
  mock.module("electron-store", () => ({ default: FakeStore }))
  mock.module("electron-updater", () => {
    const autoUpdater = autoUpdaterStub()
    return { default: { autoUpdater }, autoUpdater }
  })
  mock.module("./logging", () => ({
    getLogger: () => ({ log: (message: string, data?: object) => logs.push({ message, data }) }),
  }))
}

/** Константы главного процесса, вычисленные из окружения сборки (`src/main/constants.ts`). */
async function constants(env: { channel?: string; url?: string; isPackaged?: boolean }) {
  mockRuntime({ isPackaged: env.isPackaged })
  const saved = [process.env.OPENCODE_CHANNEL, process.env.OPENCODE_CORP_UPDATE_URL]
  if (env.channel === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = env.channel
  process.env.OPENCODE_CORP_UPDATE_URL = env.url ?? ""
  try {
    return (await import(`./constants.ts?corp=${++seq}`)) as {
      CHANNEL: string
      UPDATE_URL: string
      UPDATER_ENABLED: boolean
    }
  } finally {
    if (saved[0] === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = saved[0]
    if (saved[1] === undefined) delete process.env.OPENCODE_CORP_UPDATE_URL
    else process.env.OPENCODE_CORP_UPDATE_URL = saved[1]
  }
}

/**
 * Апдейтер, собранный с заданными константами канала и адреса обновлений.
 *
 * Сами константы вычисляются из окружения сборки и проверяются отдельно (AC-140, AC-141, AC-146):
 * здесь подставляется их результат, потому что `updater.ts` берёт их один раз при импорте.
 */
async function updater(env: { channel: string; url: string; enabled: boolean; isPackaged?: boolean }) {
  mockRuntime({ isPackaged: env.isPackaged })
  mock.module("./constants", () => ({ CHANNEL: env.channel, UPDATE_URL: env.url, UPDATER_ENABLED: env.enabled }))
  const module = await import(`./updater.ts?corp=${++seq}`)
  return module as {
    setupAutoUpdater: (stop: () => Promise<void>) => {
      getState: () => { status: string; version?: string }
      start: () => Promise<unknown>
      check: () => Promise<{ status: string }>
      install: () => Promise<void>
    }
    showUpdaterDialog: (controller: unknown, alertOnFail: boolean) => Promise<void>
  }
}

const stop = async () => {
  stops += 1
}

beforeEach(() => {
  files = new Map()
  logs = []
  dialogs = []
  updaterOps = []
  stops = 0
})

describe("константы главного процесса (AC-140, AC-141, AC-146)", () => {
  test("AC-146: канал magnit без адреса обновлений выключает апдейтер целиком", async () => {
    const module = await constants({ channel: "magnit" })
    expect(module.CHANNEL).toBe("magnit")
    expect(module.UPDATE_URL).toBe("")
    expect(module.UPDATER_ENABLED).toBe(false)
  })

  test("AC-146: с адресом обновлений апдейтер включается и берёт ровно этот адрес", async () => {
    const module = await constants({ channel: "magnit", url: UPDATE_URL })
    expect(module.UPDATE_URL).toBe(UPDATE_URL)
    expect(module.UPDATER_ENABLED).toBe(true)
  })

  test("AC-146: в неупакованной сборке апдейтер выключен даже с адресом", async () => {
    const module = await constants({ channel: "magnit", url: UPDATE_URL, isPackaged: false })
    expect(module.UPDATER_ENABLED).toBe(false)
  })

  test("AC-146: канал dev не обновляется даже с адресом", async () => {
    const module = await constants({ channel: "dev", url: UPDATE_URL })
    expect(module.UPDATER_ENABLED).toBe(false)
  })

  test("AC-141: незаданный канал означает dev, а не ошибку", async () => {
    const module = await constants({})
    expect(module.CHANNEL).toBe("dev")
  })

  test("AC-140: неизвестный канал — ошибка с полученным значением и списком допустимых", async () => {
    let error: unknown
    await constants({ channel: "corp" }).catch((caught) => (error = caught))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain("неизвестный канал сборки: corp")
    for (const channel of ["dev", "beta", "prod", "magnit"]) {
      expect((error as Error).message).toContain(channel)
    }
  })
})

describe("выключенный апдейтер (AC-146, AC-148)", () => {
  test("AC-146: в лог уходит ровно одна строка с причиной, обработчики не регистрируются", async () => {
    const { setupAutoUpdater } = await updater({ channel: "magnit", url: "", enabled: false })
    const controller = setupAutoUpdater(stop)

    expect(logs).toEqual([{ message: "auto updater disabled", data: { reason: "update url not configured" } }])
    expect(updaterOps).toEqual([])
    expect(controller.getState()).toEqual({ status: "disabled" })
  })

  test("AC-146: ни старт, ни проверка не обращаются к autoUpdater и не добавляют строк в лог", async () => {
    const { setupAutoUpdater } = await updater({ channel: "magnit", url: "", enabled: false })
    const controller = setupAutoUpdater(stop)

    await controller.start()
    expect((await controller.check()).status).toBe("disabled")

    expect(updaterOps).toEqual([])
    expect(logs).toHaveLength(1)
    const text = JSON.stringify(logs)
    for (const marker of ["Found version", "Update has already been downloaded", "Proxy server for native Squirrel.Mac"]) {
      expect(text).not.toContain(marker)
    }
    expect(text).not.toContain("github")
    expect(text).not.toContain("anomalyco")
    expect(stops).toBe(0)
  })

  test("AC-148: унаследованная запись ready очищается при старте и не приводит к установке", async () => {
    files.set("opencode.updater", new Map<string, unknown>([["ready", { version: "1.18.19" }]]))

    const { setupAutoUpdater } = await updater({ channel: "magnit", url: "", enabled: false })
    const controller = setupAutoUpdater(stop)

    expect(files.get("opencode.updater")?.has("ready")).toBe(false)

    await controller.start()
    expect(files.get("opencode.updater")?.has("ready")).toBe(false)
    expect(controller.getState()).toEqual({ status: "disabled" })
    expect(updaterOps).toEqual([])
    expect(dialogs).toEqual([])
    expect(stops).toBe(0)
  })

  test("AC-148: установка унаследованного обновления невозможна", async () => {
    files.set("opencode.updater", new Map<string, unknown>([["ready", { version: "1.18.19" }]]))

    const { setupAutoUpdater } = await updater({ channel: "magnit", url: "", enabled: false })
    const controller = setupAutoUpdater(stop)

    await expect(controller.install()).rejects.toThrow("Update is not ready to install")
    expect(updaterOps).toEqual([])
    expect(stops).toBe(0)
  })
})

describe("пункт проверки обновлений при выключенном апдейтере (AC-147)", () => {
  test("AC-147: пользователь получает диалог об отключённом автообновлении, ничего не скачивается", async () => {
    const { setupAutoUpdater, showUpdaterDialog } = await updater({ channel: "magnit", url: "", enabled: false })
    const controller = setupAutoUpdater(stop)

    await showUpdaterDialog(controller, true)

    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]?.message).toBe("Automatic updates are disabled in this build.")
    expect(dialogs[0]?.buttons).toBeUndefined()
    expect(updaterOps).toEqual([])
    expect(files.get("opencode.updater")?.has("ready") ?? false).toBe(false)
    expect(stops).toBe(0)
  })

  test("AC-147: молчаливый вызов (проверка при старте) диалога не показывает", async () => {
    const { setupAutoUpdater, showUpdaterDialog } = await updater({ channel: "magnit", url: "", enabled: false })
    const controller = setupAutoUpdater(stop)

    await showUpdaterDialog(controller, false)

    expect(dialogs).toEqual([])
    expect(updaterOps).toEqual([])
  })

  test.skipIf(process.platform !== "darwin")("AC-147: пункт меню остаётся нажимаемым и вызывает проверку обновлений", async () => {
    mockRuntime()
    mock.module("./windows", () => ({ createMainWindow: () => {}, updateTitlebar: () => {} }))

    const menu = (await import(`./menu.ts?corp=${++seq}`)) as {
      createMenu: (deps: { trigger: () => void; checkForUpdates: () => void; relaunch: () => void }) => void
    }
    let checks = 0
    menu.createMenu({ trigger: () => {}, checkForUpdates: () => (checks += 1), relaunch: () => {} })

    const items = (menuTemplate as Array<{ submenu?: Array<{ label?: string; enabled?: boolean; click?: () => void }> }>)
      .flatMap((entry) => entry.submenu ?? [])
      .filter((item) => item.label?.startsWith("Check for Updates"))
    expect(items).toHaveLength(1)
    expect(items[0]!.enabled).toBe(true)

    items[0]!.click?.()
    expect(checks).toBe(1)
  })
})

describe("включённый апдейтер берёт внутренний фид (S-B11, AC-152)", () => {
  test("S-B11: канал фида magnit и адрес из переменной сборки уходят в лог", async () => {
    const { setupAutoUpdater } = await updater({ channel: "magnit", url: UPDATE_URL, enabled: true })
    setupAutoUpdater(stop)

    const configured = logs.find((line) => line.message === "auto updater configured")
    expect(configured).toBeDefined()
    expect(configured!.data).toMatchObject({ channel: "magnit", feedUrl: UPDATE_URL })
    expect(logs.some((line) => line.message === "auto updater disabled")).toBe(false)
    const text = JSON.stringify(logs)
    expect(text).not.toContain("github")
    expect(text).not.toContain("anomalyco")
    expect(updaterOps).toContain("set channel")
  })

  test("S-B11: ванильные каналы остаются на фиде latest", async () => {
    const { setupAutoUpdater } = await updater({ channel: "prod", url: UPDATE_URL, enabled: true })
    setupAutoUpdater(stop)

    const configured = logs.find((line) => line.message === "auto updater configured")
    expect(configured!.data).toMatchObject({ channel: "latest" })
  })
})

/**
 * Заголовок окна — из имени сборки канала (S-B15, S-Q11; AC-197, AC-198, AC-199).
 *
 * Прежде в `createMainWindow` стоял литерал `title: "OpenCode"`, одинаковый у всех каналов, а
 * таблица имён сборок жила в другом файле и с заголовком связана не была: корпоративная сборка
 * донашивала заголовок ванильной. Источник имени теперь один — `APP_NAMES[CHANNEL]` рядом с
 * разбором канала, и его же читает `app.setName` (D-33).
 */
describe("заголовок окна — имя сборки канала (AC-197, AC-198, AC-199)", () => {
  /** Константы главного процесса вместе с таблицей имён и функцией имени сборки. */
  async function names(env: { channel?: string; isPackaged?: boolean }) {
    const module = (await constants(env)) as unknown as {
      CHANNEL: string
      APP_NAMES: Record<string, string>
      appName: (packaged?: boolean) => string
    }
    return module
  }

  test("AC-197: упакованный канал magnit даёт заголовок «OpenCode Magnit»", async () => {
    const module = await names({ channel: "magnit", isPackaged: true })
    expect(module.appName()).toBe("OpenCode Magnit")
    // То же значение, что APP_NAMES[CHANNEL] и productName канала (S-B10).
    expect(module.appName()).toBe(module.APP_NAMES[module.CHANNEL]!)
    expect(module.appName()).not.toBe("OpenCode")
  })

  test("AC-198: все четыре канала берут имя из одной таблицы", async () => {
    const expected = { dev: "OpenCode Dev", beta: "OpenCode Beta", prod: "OpenCode", magnit: "OpenCode Magnit" }
    for (const [channel, title] of Object.entries(expected)) {
      const module = await names({ channel, isPackaged: true })
      expect(module.appName(), channel).toBe(title)
      expect(module.APP_NAMES[channel], channel).toBe(title)
    }
  })

  test("AC-198: неупакованный запуск сохраняет прежнее поведение разработки", async () => {
    for (const channel of ["dev", "beta", "prod", "magnit"]) {
      const module = await names({ channel, isPackaged: false })
      expect(module.appName(), channel).toBe("OpenCode Dev")
    }
    // Незаданный канал — тоже dev (AC-141), заголовок с ним согласован.
    const unset = await names({ isPackaged: true })
    expect(unset.appName()).toBe("OpenCode Dev")
  })

  test("AC-199: в windows.ts нет литерала «OpenCode» в качестве значения title", async () => {
    const file = path.join(import.meta.dirname, "windows.ts")
    const source = await Bun.file(file).text()
    expect(source).toContain("title: appName()")
    // Ни одного строкового литерала в поле title — ни «OpenCode», ни любого другого имени сборки.
    expect(source).not.toMatch(/\btitle:\s*["'`]/)
    // И самого имени сборки в файле нет — оно приходит только из таблицы имён (S-B15).
    expect(source).not.toContain("OpenCode Magnit")
    expect(source).not.toContain("OpenCode Dev")
  })

  test("AC-198, AC-199: второй копии разбора канала и второй таблицы имён в главном процессе нет", async () => {
    const dir = import.meta.dirname
    const table = /APP_NAMES\s*[:=]/
    const files = ["index.ts", "windows.ts"]
    for (const name of files) {
      const source = await Bun.file(path.join(dir, name)).text()
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n")
      // Таблица объявлена только в constants.ts; остальные файлы её импортируют.
      expect(code.match(table) === null || code.includes('from "./constants"'), name).toBe(true)
      expect(code, name).not.toContain("process.env.OPENCODE_CHANNEL")
    }
    const declared = await Bun.file(path.join(dir, "constants.ts")).text()
    expect(declared).toMatch(/export const APP_NAMES/)
  })
})
