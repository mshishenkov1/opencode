import { BrowserWindow, Menu, shell } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import {
  DESKTOP_MENU,
  desktopMenuLabel,
  desktopMenuVisible,
  type DesktopMenuEntry,
  type DesktopMenuRole,
  type DesktopMenuTranslate,
} from "@opencode-ai/app/desktop-menu"

import { runDesktopMenuAction } from "./desktop-menu-actions"
import { menuTranslate, onMenuLocaleChange } from "./menu-i18n"

type Deps = {
  trigger: (id: string) => void
  checkForUpdates: () => void
  relaunch: () => void
}

/**
 * Нативное меню macOS (F30).
 *
 * Подписи берутся из общего словаря витрины: сам модуль состава меню перевода не содержит, он его
 * **получает** — `menuTranslate()` читает язык из хранилища настроек, того же, откуда его берёт
 * `readStoredLocale` витрины. Оболочка к этому моменту может быть ещё не смонтирована, и это не
 * мешает: язык лежит в `electron-store`, а не в `localStorage` рендерера.
 */
export function createMenu(deps: Deps) {
  if (process.platform !== "darwin") return

  build(deps)
  // Смена языка в настройках перестраивает меню сразу: витрина пишет язык через `store-set`, то есть
  // в тот же экземпляр `electron-store`, что читает главный процесс, и подписка срабатывает
  // в этом же процессе. Перезапуска приложения ради русского меню не требуется.
  onMenuLocaleChange(() => build(deps))
}

function build(deps: Deps) {
  const t = menuTranslate()

  const template = DESKTOP_MENU.filter((menu) => desktopMenuVisible(menu, "macos")).map((menu) => {
    // У раздела с ролью подпись всё равно наша: без неё macOS подставляет СВОЁ имя раздела на языке
    // СИСТЕМЫ, и в русской сборке на английской системе раздел «Окно» остался бы «Window».
    if (menu.role) return { role: nativeRole(menu.role), label: desktopMenuLabel(menu, t) }
    return {
      label: desktopMenuLabel(menu, t),
      submenu: menu.items
        ?.filter((entry) => desktopMenuVisible(entry, "macos"))
        .map((entry) => nativeItem(entry, deps, t)),
    }
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function nativeItem(entry: DesktopMenuEntry, deps: Deps, t: DesktopMenuTranslate): MenuItemConstructorOptions {
  if (entry.type === "separator") return { type: "separator" }
  // Роль задаёт ПОВЕДЕНИЕ пункта (отмена, копирование, масштаб), а подпись у него наша: роль без
  // подписи macOS печатает на языке системы, и «Правка» получалась русской шапкой с английскими
  // «Undo / Redo / Cut / Copy / Paste». Пункт, которому подпись в словаре не заведена (About, Hide,
  // Quit — они несут имя приложения и локализуются самой системой), остаётся на роли как был.
  if (entry.role) {
    const label = desktopMenuLabel(entry, t)
    return label ? { role: nativeRole(entry.role), label } : { role: nativeRole(entry.role) }
  }

  const item: MenuItemConstructorOptions = {
    label: desktopMenuLabel(entry, t),
    accelerator: entry.accelerator?.macos,
    // corp: пункт проверки обновлений остаётся доступным и при выключенном апдейтере — вместо
    // серого пункта пользователь получает диалог «Automatic updates are disabled in this build.»
    // (S-B11, AC-147). Проверка при этом не выполняется: контроллер выключен.
    enabled: entry.enabled === "updater" ? true : undefined,
  }

  if (entry.command) {
    const command = entry.command
    item.click = () => deps.trigger(command)
  }
  if (entry.action) {
    const action = entry.action
    item.click = () =>
      runDesktopMenuAction(BrowserWindow.getFocusedWindow(), action, {
        checkForUpdates: deps.checkForUpdates,
        relaunch: deps.relaunch,
      })
  }
  if (entry.href) {
    const href = entry.href
    item.click = () => shell.openExternal(href)
  }

  return item
}

function nativeRole(role: DesktopMenuRole) {
  return role as NonNullable<MenuItemConstructorOptions["role"]>
}
