import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
// corp: явный апгрейд в корпоративной сборке ходит только на внутренний адрес либо не ходит
// никуда вовсе (S-B14). Ванильная сборка этой ветки не видит: plan() отдаёт "upstream" (S-C6).
import * as CorpUpgrade from "../../corp/upgrade"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade opencode to the latest or a specific version",
  builder: (yargs: Argv) => {
    return yargs
      .positional("target", {
        describe: "version to upgrade to, for ex '0.1.48' or 'v0.1.48'",
        type: "string",
      })
      .option("method", {
        alias: "m",
        describe: "installation method to use",
        type: "string",
        choices: ["curl", "npm", "pnpm", "bun", "brew", "choco", "scoop"],
      })
  },
  handler: async (args: { target?: string; method?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")

    // corp (S-B14): в корпоративной сборке источник обновлений — только внутренний адрес.
    // Ни определение версии, ни установка не идут в публичные реестры и на api.github.com,
    // а без адреса не выполняется ни одного сетевого запроса и не запускается ни один
    // менеджер пакетов. Ванильная сборка сюда не заходит.
    const corp = CorpUpgrade.plan()
    if (corp.mode === "disabled") {
      prompts.log.error(CorpUpgrade.DISABLED_MESSAGE)
      prompts.outro("Done")
      process.exitCode = 1
      return
    }
    if (corp.mode === "internal") {
      let target = args.target?.replace(/^v/, "")
      if (target === undefined) {
        const latest = await CorpUpgrade.latest(corp.url)
        if (!latest.ok) {
          // Запасного публичного источника нет: молчаливый откат на api.github.com — тот самый
          // путь, которым ванильный артефакт попадал в корпоративную сборку (D-34).
          prompts.log.error(CorpUpgrade.sourceErrorMessage(corp.url, latest.error))
          prompts.outro("Done")
          process.exitCode = 1
          return
        }
        target = latest.data
      }
      if (InstallationVersion === target) {
        prompts.log.warn(`opencode upgrade skipped: ${target} is already installed`)
        prompts.outro("Done")
        return
      }
      prompts.log.info(`From ${InstallationVersion} → ${target}`)
      const spinner = prompts.spinner()
      spinner.start("Upgrading...")
      const installed = await CorpUpgrade.install(corp.url, target)
      if (!installed.ok) {
        spinner.stop("Upgrade failed", 1)
        prompts.log.error(CorpUpgrade.sourceErrorMessage(corp.url, installed.error))
        prompts.outro("Done")
        process.exitCode = 1
        return
      }
      spinner.stop("Upgrade complete")
      prompts.outro("Done")
      return
    }

    const detectedMethod = await Installation.method()
    const method = (args.method as Installation.Method) ?? detectedMethod
    if (method === "unknown") {
      prompts.log.error(`opencode is installed to ${process.execPath} and may be managed by a package manager`)
      const install = await prompts.select({
        message: "Install anyways?",
        options: [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        initialValue: false,
      })
      if (!install) {
        prompts.outro("Done")
        return
      }
    }
    prompts.log.info("Using method: " + method)
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(`opencode upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        // necessary because choco only allows install/upgrade in elevated terminals
        if (method === "choco" && err.stderr.includes("not running from an elevated command shell")) {
          prompts.log.error("Please run the terminal as Administrator and try again")
        } else {
          prompts.log.error(err.stderr)
        }
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
