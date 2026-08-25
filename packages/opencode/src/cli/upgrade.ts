import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"
import { Effect } from "effect"
import * as CorpUpgrade from "@/corp/upgrade"

let corpBackgroundWarned = false

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return

  // corp (S-B14): фоновая проверка подчиняется тем же правилам, что явная команда. Корп-умолчание
  // autoupdate:false её и так выключает, но личный конфиг сильнее корп-слоя (S-C3/S-C9) — и
  // включённая пользователем проверка не должна уходить на api.github.com. Без адреса внутреннего
  // источника проверка не выполняется вовсе и один раз пишет причину в лог.
  const corp = CorpUpgrade.plan()
  if (corp.mode === "disabled") {
    if (!corpBackgroundWarned) {
      corpBackgroundWarned = true
      await AppRuntime.runPromise(
        Effect.logWarning("corp upgrade: фоновая проверка обновлений пропущена", {
          reason: "адрес внутреннего источника обновлений CLI не задан",
        }),
      )
    }
    return
  }

  const method = await Installation.method()
  const latest =
    corp.mode === "internal"
      ? await CorpUpgrade.latest(corp.url).then((result) => (result.ok ? result.data : undefined))
      : await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (corp.mode === "internal") {
    // Установка тоже только с внутреннего хоста: менеджеры пакетов ведут в публичные реестры.
    const installed = await CorpUpgrade.install(corp.url, latest)
    if (!installed.ok) return
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.Updated.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
