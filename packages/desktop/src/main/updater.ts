import { app, dialog } from "electron"
import pkg from "electron-updater"
import { CHANNEL, UPDATE_URL, UPDATER_ENABLED } from "./constants"
import { createUpdaterController, type UpdaterBackend, type UpdaterReadyRecord } from "./updater-controller"
import { getLogger } from "./logging"
import { getStore } from "./store"

const { autoUpdater } = pkg
const key = "ready"

// corp: апдейтер выключен — обработчики не регистрируются и `autoUpdater` не трогается вовсе,
// чтобы ни одна проверка не ушла ни к каким релизам (S-B11, AC-146). Бэкенд-заглушка нужна только
// для типа контроллера: при `enabled: false` контроллер до него не доходит.
const disabledBackend: UpdaterBackend = {
  async checkForUpdates() {
    throw new Error("auto updater is disabled")
  },
  async downloadUpdate() {
    throw new Error("auto updater is disabled")
  },
  quitAndInstall() {
    throw new Error("auto updater is disabled")
  },
}

/** Причина выключения апдейтера для лога (S-B11). */
function disabledReason() {
  if (!app.isPackaged) return "development build"
  if (CHANNEL === "dev") return "dev channel"
  return "update url not configured"
}

export function setupAutoUpdater(stop: () => Promise<void>) {
  const logger = getLogger()
  const store = getStore("opencode.updater")
  const persistence = {
    get() {
      const value = store.get(key)
      if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") return
      return { version: value.version } satisfies UpdaterReadyRecord
    },
    set: (value: UpdaterReadyRecord) => store.set(key, value),
    clear: () => store.delete(key),
  }

  if (!UPDATER_ENABLED) {
    // corp: унаследованная запись `ready` (в наблюдавшемся случае — скачанный ванильной сборкой
    // OpenCode 1.18.19) при выключенном апдейтере не должна приводить к установке: она очищается
    // при старте (S-B11, AC-148). В лог уходит ровно одна строка.
    persistence.clear()
    logger.log("auto updater disabled", { reason: disabledReason() })
    return createUpdaterController({
      enabled: false,
      currentVersion: app.getVersion(),
      backend: disabledBackend,
      persistence,
      stop,
      log: (message, data) => logger.log(message, data),
    })
  }

  autoUpdater.logger = logger
  // corp: канал фида совпадает с каналом раздачи — у корпоративной сборки это `magnit`
  // (`publish.channel` в electron-builder.config.ts), у остальных каналов — прежний `latest` (S-B11).
  autoUpdater.channel = CHANNEL === "magnit" ? "magnit" : "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    // corp: адрес фида — из build-константы CORP_DESKTOP_UPDATE_URL; сам electron-updater берёт его
    // из `app-update.yml` в ресурсах бандла, поэтому в логе он виден только отсюда (S-B11, AC-145).
    feedUrl: UPDATE_URL,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })

  return createUpdaterController({
    enabled: UPDATER_ENABLED,
    currentVersion: app.getVersion(),
    backend: autoUpdater,
    persistence,
    stop,
    log: (message, data) => logger.log(message, data),
  })
}

export async function showUpdaterDialog(controller: ReturnType<typeof setupAutoUpdater>, alertOnFail: boolean) {
  const state = await controller.check()
  // corp: сборка без адреса обновлений говорит об этом прямо, а не молчит (S-B11, AC-147).
  if (state.status === "disabled") {
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "Automatic updates are disabled in this build.",
      title: "Updates Disabled",
    })
    return
  }
  if (state.status === "error") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "error", message: "Update check failed.", title: "Update Error" })
    return
  }
  if (state.status === "up-to-date") {
    if (!alertOnFail) return
    await dialog.showMessageBox({ type: "info", message: "You're up to date.", title: "No Updates" })
    return
  }
  if (state.status !== "ready") return

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${state.version} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  if (response.response === 0) await controller.install()
}
