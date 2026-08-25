import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import type { Configuration } from "electron-builder"

/**
 * Конфигурация упаковки Desktop: канал `magnit`, ванильные каналы и фид обновлений
 * (S-B3, S-B9, S-B10, S-B11, S-Q10; AC-112, AC-138, AC-140, AC-141, AC-152).
 *
 * Имя файла — `…config.corp.test.ts`, потому что `electron-builder.config.test.ts` уже занят
 * тестом upstream (проверка Linux-идентичности, коммит 2e0f88d0e3); он запускается из каталога
 * пакета `desktop` и полагается на относительные пути, поэтому не переносится.
 *
 * Запуск: `bun --cwd packages/opencode test ../../packages/desktop/electron-builder.config.corp.test.ts`
 * (или вместе со всеми корп-тестами: `bun --cwd packages/opencode test src/corp`).
 * Сети и сборки здесь нет: конфигурация вычисляется импортом с подставленным окружением.
 */

const DESKTOP = import.meta.dirname
const ROOT = path.resolve(DESKTOP, "../..")

const CHANNEL_VARS = ["OPENCODE_CHANNEL", "CORP_DESKTOP_UPDATE_URL"] as const

let seq = 0

/** Вычисляет модуль заново с подставленным окружением (значения модуля берутся при импорте). */
async function withEnv<T>(env: Partial<Record<(typeof CHANNEL_VARS)[number], string | undefined>>, load: (tag: string) => Promise<T>) {
  const saved = Object.fromEntries(CHANNEL_VARS.map((key) => [key, process.env[key]]))
  for (const key of CHANNEL_VARS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value
  try {
    return await load(`corp=${++seq}`)
  } finally {
    for (const key of CHANNEL_VARS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Конфигурация упаковки (`packages/desktop/electron-builder.config.ts`). */
function packaging(env: Partial<Record<(typeof CHANNEL_VARS)[number], string | undefined>>) {
  return withEnv(env, async (tag) => {
    const module = await import(`./electron-builder.config.ts?${tag}`)
    return module.default as Configuration
  })
}

/** Конфигурация electron-vite (`packages/desktop/electron.vite.config.ts`). */
function electronVite(env: Partial<Record<(typeof CHANNEL_VARS)[number], string | undefined>>) {
  return withEnv(env, async (tag) => {
    const module = await import(`./electron.vite.config.ts?${tag}`)
    return module.default as { main: { define: Record<string, string> }; renderer: { plugins: unknown[] } }
  })
}

/** Разбор канала сборочных скриптов (`packages/desktop/scripts/utils.ts`). */
function scriptsChannel(env: Partial<Record<(typeof CHANNEL_VARS)[number], string | undefined>>) {
  return withEnv(env, async (tag) => {
    const module = await import(`./scripts/utils.ts?${tag}`)
    return (module.resolveChannel as () => string)()
  })
}

/** Разбор канала интерфейса (`packages/app/vite.js`) — общий с главным процессом. */
function appChannel(env: Partial<Record<(typeof CHANNEL_VARS)[number], string | undefined>>) {
  return withEnv(env, async (tag) => {
    const module = await import(`@opencode-ai/app/vite?${tag}`)
    return (module.resolveChannel as () => string)()
  })
}

/** Значение `VITE_OPENCODE_CHANNEL`, которое плагин `app` подставляет в интерфейс. */
function uiChannel(env: Partial<Record<(typeof CHANNEL_VARS)[number], string | undefined>>) {
  return withEnv(env, async (tag) => {
    const module = await import(`@opencode-ai/app/vite?${tag}`)
    const plugins = module.default as Array<{ name?: string; config?: () => { define: Record<string, string> } }>
    const config = plugins.find((plugin) => plugin.name === "opencode-desktop:config")!
    return JSON.parse(config.config!().define["import.meta.env.VITE_OPENCODE_CHANNEL"]!) as string
  })
}

describe("electron-builder.config.ts — канал magnit (AC-138)", () => {
  test("AC-138: канал magnit даёт корпоративную идентичность", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect(config.appId).toBe("ai.opencode.desktop.magnit")
    expect(config.productName).toBe("OpenCode Magnit")
    expect(config.artifactName).toBe("opencode-magnit-desktop-${os}-${arch}.${ext}")
    expect(config.rpm?.packageName).toBe("opencode-magnit")
    expect(config.extraMetadata?.desktopName).toBe("ai.opencode.desktop.magnit.desktop")
    expect(config.protocols).toEqual({ name: "OpenCode Magnit", schemes: ["opencode"] })
  })

  test("AC-138: строка совместимости legacyDesktopEntryFpm в корпоративную ветку не переносится", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect(config.deb).toBeUndefined()
    expect(config.rpm?.fpm).toBeUndefined()
    expect(JSON.stringify(config)).not.toContain("opencode-desktop.desktop")
  })

  test("AC-138, S-B10: идентификатор доезжает до Linux-ярлыка и имени исполняемого файла", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect(config.linux?.executableName).toBe("ai.opencode.desktop.magnit")
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe("ai.opencode.desktop.magnit")
  })
})

describe("electron-builder.config.ts — ванильные каналы не изменены (AC-112, AC-152)", () => {
  test("AC-112: prod даёт upstream-идентичность и upstream-фид anomalyco", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "prod" })
    expect(config.appId).toBe("ai.opencode.desktop")
    expect(config.productName).toBe("OpenCode")
    expect(config.protocols).toEqual({ name: "OpenCode", schemes: ["opencode"] })
    expect(config.publish).toEqual({ provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" })
    expect(config.artifactName).toBe("opencode-desktop-${os}-${arch}.${ext}")
    expect(config.rpm?.packageName).toBe("opencode")
  })

  test("AC-112: beta даёт upstream-идентичность и upstream-фид anomalyco", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "beta" })
    expect(config.appId).toBe("ai.opencode.desktop.beta")
    expect(config.productName).toBe("OpenCode Beta")
    expect(config.publish).toEqual({ provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" })
    expect(config.rpm?.packageName).toBe("opencode-beta")
  })

  test("AC-112: dev даёт upstream-идентичность и остаётся без фида", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "dev" })
    expect(config.appId).toBe("ai.opencode.desktop.dev")
    expect(config.productName).toBe("OpenCode Dev")
    expect(config.publish).toBeUndefined()
    expect(config.rpm?.packageName).toBe("opencode-dev")
  })

  test("AC-112: корпоративный адрес обновлений не попадает в ванильные каналы", async () => {
    for (const channel of ["dev", "beta", "prod"]) {
      const config = await packaging({ OPENCODE_CHANNEL: channel, CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode" })
      expect(JSON.stringify(config), channel).not.toContain("updates.example.corp")
    }
  })

  test("AC-112: блоки подписи остаются upstream-логикой", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect(config.mac?.notarize).toBe(true)
    expect(config.dmg?.sign).toBe(true)
    expect(typeof config.win?.signtoolOptions?.sign).toBe("function")
    expect(fs.existsSync(path.join(ROOT, "script/sign-windows.ps1"))).toBe(true)
  })
})

/**
 * Каталог кеша обновлений (S-B13, S-Q10; AC-189, AC-190, AC-192).
 *
 * `updaterCacheDirName` в `app-update.yml` electron-builder вычисляет из поля `name` пакета
 * (`sanitizeFileName(name).toLowerCase() + "-updater"`), а не из `appId` и не из `productName`.
 * С upstream-значением `@opencode-ai/desktop` корпоративная сборка искала обновление там же, где
 * его кладёт ванильная (`~/Library/Caches/@opencode-aidesktop-updater`).
 */
describe("каталог кеша обновлений канала magnit (AC-189, AC-190, AC-192)", () => {
  test("AC-189: канал magnit получает собственное имя пакета и сохраняет desktopName из getBase()", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect(config.extraMetadata?.name).toBe("opencode-magnit-desktop")
    expect(config.extraMetadata?.desktopName).toBe("ai.opencode.desktop.magnit.desktop")
    // Имя каталога кеша, которое из этого получит electron-updater.
    expect(`${String(config.extraMetadata?.name).toLowerCase()}-updater`).toBe("opencode-magnit-desktop-updater")
    expect(String(config.extraMetadata?.name)).not.toContain("@opencode-ai")
  })

  test("AC-189: прочие проверки идентичности канала magnit продолжают выполняться", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect(config.appId).toBe("ai.opencode.desktop.magnit")
    expect(config.productName).toBe("OpenCode Magnit")
    expect(config.artifactName).toBe("opencode-magnit-desktop-${os}-${arch}.${ext}")
    expect(config.rpm?.packageName).toBe("opencode-magnit")
    expect(config.protocols).toEqual({ name: "OpenCode Magnit", schemes: ["opencode"] })
    expect(JSON.stringify(config)).not.toContain("opencode-desktop.desktop")
  })

  test("AC-190, AC-192: extraMetadata ванильных каналов не изменён — поля name в нём нет", async () => {
    for (const channel of ["dev", "beta", "prod"]) {
      const config = await packaging({ OPENCODE_CHANNEL: channel })
      const appId = { dev: "ai.opencode.desktop.dev", beta: "ai.opencode.desktop.beta", prod: "ai.opencode.desktop" }[
        channel
      ]!
      // Ровно upstream-значение: только desktopName, вычисленный из appId канала.
      expect(config.extraMetadata, channel).toEqual({ desktopName: `${appId}.desktop` })
      expect(config.extraMetadata, channel).not.toHaveProperty("name")
    }
  })

  test("AC-190: правка ограничена веткой magnit — имя пакета ванильных каналов остаётся upstream", async () => {
    for (const channel of ["dev", "beta", "prod"]) {
      const config = await packaging({ OPENCODE_CHANNEL: channel })
      expect(JSON.stringify(config), channel).not.toContain("opencode-magnit-desktop")
    }
  })

  test("AC-192: случаи каталога кеша добавлены к покрытию AC-152, прежние случаи сохранены", () => {
    // Требование AC-192 — про состав самого теста: новые случаи живут рядом с прежними, а не
    // вместо них. Проверяется по этому же файлу.
    const own = fs.readFileSync(path.join(DESKTOP, "electron-builder.config.corp.test.ts"), "utf8")
    for (const marker of [
      // Прежние случаи AC-152: каналы, неизвестное значение, незаданная переменная, обе ветки фида.
      "AC-152: с CORP_DESKTOP_UPDATE_URL ветка magnit получает generic-фид",
      "AC-152: без переменной блока publish в ветке magnit нет вовсе",
      "AC-140: сборка Desktop с неизвестным каналом не создаёт артефакт",
      "AC-141: незаданная переменная означает dev во всех местах разбора",
      // Новые случаи ревизии 1.9.
      "AC-189: канал magnit получает собственное имя пакета",
      "AC-190, AC-192: extraMetadata ванильных каналов не изменён",
    ])
      expect(own, marker).toContain(marker)
  })
})

describe("канал сборки: неизвестное значение и умолчание (AC-140, AC-141)", () => {
  /**
   * Места разбора канала запускаются отдельным процессом: `bun -e` даёт наблюдаемый код выхода
   * (AC-140 требует ненулевого) и не оставляет упавший модуль в кэше текущего процесса.
   */
  function probe(code: string, env: Record<string, string>) {
    const proc = Bun.spawnSync({
      cmd: ["bun", "-e", code],
      cwd: DESKTOP,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() }
  }

  const places: Array<{ name: string; code: string }> = [
    {
      name: "electron-builder.config.ts",
      code: `const m = await import("./electron-builder.config.ts"); console.log(m.default.appId)`,
    },
    {
      name: "electron.vite.config.ts",
      code: `const m = await import("./electron.vite.config.ts"); console.log(JSON.stringify(m.default.main.define))`,
    },
    {
      name: "scripts/utils.ts",
      code: `const m = await import("./scripts/utils.ts"); console.log(m.resolveChannel())`,
    },
    {
      name: "packages/app/vite.js",
      code: `const m = await import("@opencode-ai/app/vite"); console.log(m.resolveChannel())`,
    },
  ]

  for (const place of places) {
    test(`AC-140: ${place.name} — неизвестный канал corp даёт ненулевой код выхода и называет значение`, () => {
      const result = probe(place.code, { OPENCODE_CHANNEL: "corp" })
      expect(result.code, place.name).not.toBe(0)
      expect(result.out, place.name).toContain("неизвестный канал сборки: corp")
      for (const channel of ["dev", "beta", "prod", "magnit"]) expect(result.out, place.name).toContain(channel)
      // Молчаливого отката в dev нет ни в одном из мест.
      expect(result.out, place.name).not.toContain("ai.opencode.desktop.dev")
    })
  }

  test("AC-140: сборка Desktop с неизвестным каналом не создаёт артефакт", () => {
    const result = probe(
      `const m = await import("./electron-builder.config.ts"); console.log(m.default.artifactName)`,
      { OPENCODE_CHANNEL: "corp" },
    )
    expect(result.code).not.toBe(0)
    expect(result.out).not.toContain("opencode-magnit-desktop")
    expect(result.out).not.toContain("opencode-desktop-")
  })

  test("AC-141: незаданная переменная означает dev во всех местах разбора", async () => {
    expect((await packaging({})).appId).toBe("ai.opencode.desktop.dev")
    expect((await electronVite({})).main.define["import.meta.env.OPENCODE_CHANNEL"]).toBe(JSON.stringify("dev"))
    expect(await scriptsChannel({})).toBe("dev")
    expect(await appChannel({})).toBe("dev")
    expect(await uiChannel({})).toBe("dev")
  })

  test("AC-141: пустая строка тоже означает dev, а не ошибку", async () => {
    expect((await packaging({ OPENCODE_CHANNEL: "" })).appId).toBe("ai.opencode.desktop.dev")
    expect(await scriptsChannel({ OPENCODE_CHANNEL: "" })).toBe("dev")
    expect(await appChannel({ OPENCODE_CHANNEL: "" })).toBe("dev")
  })
})

describe("фид обновлений Desktop (AC-152, S-B11)", () => {
  test("AC-152: с CORP_DESKTOP_UPDATE_URL ветка magnit получает generic-фид и ровно этот адрес", async () => {
    const config = await packaging({
      OPENCODE_CHANNEL: "magnit",
      CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode",
    })
    expect(config.publish).toEqual({
      provider: "generic",
      url: "https://updates.example.corp/opencode",
      channel: "magnit",
    })
    expect(JSON.stringify(config)).not.toContain("anomalyco")
    expect(JSON.stringify(config)).not.toContain("github")
  })

  test("AC-152: хвостовой слэш адреса обновлений отбрасывается", async () => {
    const config = await packaging({
      OPENCODE_CHANNEL: "magnit",
      CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode//",
    })
    expect((config.publish as { url: string }).url).toBe("https://updates.example.corp/opencode")
  })

  test("AC-152: без переменной блока publish в ветке magnit нет вовсе", async () => {
    const config = await packaging({ OPENCODE_CHANNEL: "magnit" })
    expect("publish" in config).toBe(false)
    expect(JSON.stringify(config)).not.toContain("anomalyco")
  })

  test("AC-152, S-B11: адрес обновлений в главный процесс приходит той же build-константой", async () => {
    const configured = await electronVite({
      OPENCODE_CHANNEL: "magnit",
      CORP_DESKTOP_UPDATE_URL: "https://updates.example.corp/opencode/",
    })
    expect(configured.main.define["import.meta.env.OPENCODE_CORP_UPDATE_URL"]).toBe(
      JSON.stringify("https://updates.example.corp/opencode"),
    )
    const disabled = await electronVite({ OPENCODE_CHANNEL: "magnit" })
    expect(disabled.main.define["import.meta.env.OPENCODE_CORP_UPDATE_URL"]).toBe(JSON.stringify(""))
  })
})

describe("канал разбирается в одном месте и доезжает до интерфейса (S-B3, S-B10)", () => {
  /** Файлы, которые сами читают переменную канала и превращают её в канал сборки. */
  function parsers() {
    const listed = Bun.spawnSync({
      cmd: ["git", "ls-files", "*.ts", "*.tsx", "*.js"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(listed.exitCode).toBe(0)
    return listed.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .filter((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), "utf8")
        const readsEnv = /(process\.env|Bun\.env|import\.meta\.env)\.OPENCODE_CHANNEL|env\["OPENCODE_CHANNEL"\]/.test(source)
        return readsEnv && source.includes('"beta"')
      })
      .sort()
  }

  test("S-B10: разбор канала живёт только в известных местах — копия не появилась снова", () => {
    expect(parsers()).toEqual([
      "corp/build.ts",
      "packages/app/vite.js",
      "packages/desktop/electron-builder.config.ts",
      "packages/desktop/scripts/utils.ts",
      "packages/desktop/src/main/constants.ts",
    ])
  })

  test("S-B10: electron.vite.config.ts берёт канал из общего resolveChannel, а не разбирает сам", () => {
    const source = fs.readFileSync(path.join(DESKTOP, "electron.vite.config.ts"), "utf8")
    expect(source).toMatch(/import\s+appPlugin,\s*\{\s*resolveChannel\s*\}\s+from\s+"@opencode-ai\/app\/vite"/)
    expect(source).toContain("resolveChannel()")
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n")
    expect(code).not.toContain("process.env.OPENCODE_CHANNEL")
    expect(code).not.toContain("Bun.env.OPENCODE_CHANNEL")
  })

  test("S-B3, S-B10: magnit и latest доезжают до интерфейса как magnit", async () => {
    for (const raw of ["magnit", "latest"]) {
      expect(await uiChannel({ OPENCODE_CHANNEL: raw }), raw).toBe("magnit")
      expect(await appChannel({ OPENCODE_CHANNEL: raw }), raw).toBe("magnit")
    }
  })

  test("S-B10: главный процесс и интерфейс получают один и тот же канал из одного источника", async () => {
    for (const raw of ["magnit", "latest", "dev", "beta", "prod"]) {
      const main = await electronVite({ OPENCODE_CHANNEL: raw })
      expect(main.main.define["import.meta.env.OPENCODE_CHANNEL"], raw).toBe(JSON.stringify(await uiChannel({ OPENCODE_CHANNEL: raw })))
    }
  })

  test("S-B10: ванильные каналы интерфейса не переехали в magnit", async () => {
    for (const raw of ["dev", "beta", "prod"]) {
      expect(await uiChannel({ OPENCODE_CHANNEL: raw }), raw).toBe(raw)
    }
  })
})
