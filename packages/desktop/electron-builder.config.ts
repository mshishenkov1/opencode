import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

// corp: канал `magnit` — корпоративная раздача (S-B9, S-B10). Неизвестное значение — ошибка сборки,
// а не молчаливый откат в `dev`: именно он дал раздачу под именем «OpenCode Dev» (D-25).
// Незаданная переменная по-прежнему означает `dev` — это режим локальной разработки.
const CHANNELS = ["dev", "beta", "prod", "magnit"] as const

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === undefined || raw === "") return "dev"
  if (raw === "dev" || raw === "beta" || raw === "prod" || raw === "magnit") return raw
  throw new Error(`неизвестный канал сборки: ${raw}; допустимые: ${CHANNELS.join(", ")}`)
})()

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
  magnit: "ai.opencode.desktop.magnit",
} as const

// corp: адрес внутреннего сервера обновлений (S-B11, D-24). Умолчания нет и в репозитории адрес не
// хранится: он приходит из окружения сборки, как CORP_HUB_URL. Без переменной блока `publish` в
// корпоративной ветке нет вовсе, `app-update.yml` в бандл не попадает и апдейтер выключен.
const corpUpdateUrl = process.env.CORP_DESKTOP_UPDATE_URL?.trim().replace(/\/+$/, "") || undefined

const getBase = (appId: string): Configuration => ({
  artifactName: "opencode-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: "OpenCode",
    schemes: ["opencode"],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "OpenCode Dev",
        rpm: { packageName: "opencode-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "OpenCode Beta",
        protocols: { name: "OpenCode Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        rpm: { packageName: "opencode-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "OpenCode",
        protocols: { name: "OpenCode", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode", channel: "latest" },
        deb: { fpm: [legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [legacyDesktopEntryFpm] },
      }
    }
    // corp: корпоративная раздача (S-B10, S-B11). Собственные appId и имя дают отдельный каталог
    // пользовательских данных и позволяют держать сборку рядом с ванильным OpenCode (S-B12).
    // Строка совместимости legacyDesktopEntryFpm — наследие ванильного `prod` — не переносится.
    case "magnit": {
      return {
        ...base,
        appId,
        // corp: свой каталог кеша обновлений (S-B13, S-B9 п. «д», D-34). `updaterCacheDirName` в
        // `app-update.yml` electron-builder вычисляет как
        // `sanitizeFileName(metadata.name).toLowerCase() + "-updater"` (F42) — то есть из поля
        // `name` пакета, а не из appId и не из productName. С upstream-значением
        // `@opencode-ai/desktop` корпоративная сборка искала обновление там же, где его кладёт
        // ванильная (`~/Library/Caches/@opencode-aidesktop-updater`). Прочие поля `extraMetadata`
        // (desktopName из getBase) сохраняются, ветки dev/beta/prod не затрагиваются.
        extraMetadata: { ...base.extraMetadata, name: "opencode-magnit-desktop" },
        artifactName: "opencode-magnit-desktop-${os}-${arch}.${ext}",
        productName: "OpenCode Magnit",
        protocols: { name: "OpenCode Magnit", schemes: ["opencode"] },
        ...(corpUpdateUrl ? { publish: { provider: "generic", url: corpUpdateUrl, channel: "magnit" } } : {}),
        rpm: { packageName: "opencode-magnit" },
      }
    }
  }
}

export default getConfig()
