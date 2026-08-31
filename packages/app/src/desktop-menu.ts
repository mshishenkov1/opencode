/**
 * Состав нативного меню Desktop — общий для обеих оболочек: главный процесс Electron строит из него
 * меню macOS (`packages/desktop/src/main/menu.ts`), а витрина Windows — свою полосу меню
 * (`components/windows-app-menu.tsx`).
 *
 * Подписи здесь — **ключи словаря**, а не готовый текст (F30). До ревизии 1.14 в этом файле лежали
 * английские литералы («File», «Edit», «Go»), и в русской сборке нативное меню оставалось
 * английским: `t(` в файле не встречался ни разу. Перевод в модуль не встраивается — модуль его
 * **получает**: обе оболочки зовут `desktopMenuLabel(entry, t)` со своим переводчиком, потому что
 * словарь у них общий, а способ добраться до языка разный (у витрины — контекст `useLanguage`, у
 * главного процесса — хранилище настроек, из которого язык читает и `readStoredLocale`).
 */
export type DesktopMenuPlatform = "macos" | "windows"

/**
 * Ключ подписи пункта меню. Тип берётся из САМОГО словаря, а не переписывается объединением строк:
 * опечатка в ключе и ключ, удалённый из `en.ts`, ломают сборку типов здесь же. Импорт типовой —
 * во время выполнения словарь в этот модуль не попадает (его тянуть в главный процесс Electron
 * незачем: там свой переводчик).
 */
export type DesktopMenuLabelKey = Extract<keyof typeof import("./i18n/en")["dict"], `menu.${string}`>

/** Переводчик, который оболочка передаёт модулю меню: ключ на входе, готовая подпись на выходе. */
export type DesktopMenuTranslate = (key: DesktopMenuLabelKey) => string

/**
 * Подпись пункта или раздела меню.
 *
 * Имя приложения (`label: "OpenCode"` у раздела `app`) переводу не подлежит и потому лежит текстом:
 * macOS первым разделом всё равно показывает имя приложения, а не то, что мы напишем.
 */
export function desktopMenuLabel(
  entry: { label?: string; labelKey?: DesktopMenuLabelKey },
  t: DesktopMenuTranslate,
): string | undefined {
  if (entry.labelKey) return t(entry.labelKey)
  return entry.label
}

export type DesktopMenuAction =
  | "app.checkForUpdates"
  | "app.relaunch"
  | "edit.undo"
  | "edit.redo"
  | "edit.cut"
  | "edit.copy"
  | "edit.paste"
  | "edit.delete"
  | "edit.selectAll"
  | "view.reload"
  | "view.toggleDevTools"
  | "view.resetZoom"
  | "view.zoomIn"
  | "view.zoomOut"
  | "view.toggleFullscreen"
  | "window.new"
  | "window.close"
  | "window.minimize"
  | "window.toggleMaximize"

export type DesktopMenuRole =
  | "about"
  | "close"
  | "copy"
  | "cut"
  | "hide"
  | "hideOthers"
  | "paste"
  | "quit"
  | "redo"
  | "reload"
  | "resetZoom"
  | "selectAll"
  | "toggleDevTools"
  | "togglefullscreen"
  | "undo"
  | "unhide"
  | "windowMenu"
  | "zoomIn"
  | "zoomOut"

export type DesktopMenuItem = {
  type: "item"
  labelKey?: DesktopMenuLabelKey
  command?: string
  action?: DesktopMenuAction
  role?: DesktopMenuRole
  href?: string
  accelerator?: Partial<Record<DesktopMenuPlatform, string>>
  enabled?: "updater"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuSeparator = {
  type: "separator"
  platforms?: DesktopMenuPlatform[]
}

export type DesktopMenuEntry = DesktopMenuItem | DesktopMenuSeparator

export type DesktopMenu = {
  id: string
  /** Имя приложения — единственная подпись, которая не переводится (раздел `app` на macOS). */
  label?: string
  labelKey?: DesktopMenuLabelKey
  role?: DesktopMenuRole
  items?: DesktopMenuEntry[]
  platforms?: DesktopMenuPlatform[]
}

export const DESKTOP_MENU: DesktopMenu[] = [
  {
    id: "app",
    label: "OpenCode",
    platforms: ["macos"],
    items: [
      { type: "item", role: "about", labelKey: "menu.app.about" },
      { type: "item", labelKey: "menu.app.checkForUpdates", action: "app.checkForUpdates", enabled: "updater" },
      { type: "item", labelKey: "menu.app.settings", command: "settings.open", accelerator: { macos: "Cmd+," } },
      { type: "item", labelKey: "menu.app.reloadWebview", action: "view.reload" },
      { type: "item", labelKey: "menu.app.restart", action: "app.relaunch" },
      { type: "item", labelKey: "menu.app.exportLogs", command: "logs.export" },
      { type: "separator" },
      { type: "item", role: "hide", labelKey: "menu.app.hide" },
      { type: "item", role: "hideOthers", labelKey: "menu.app.hideOthers" },
      { type: "item", role: "unhide", labelKey: "menu.app.unhide" },
      { type: "separator" },
      { type: "item", role: "quit", labelKey: "menu.app.quit" },
    ],
  },
  {
    id: "file",
    labelKey: "menu.file",
    items: [
      {
        type: "item",
        labelKey: "menu.file.newSession",
        command: "session.new",
        accelerator: { macos: "Shift+Cmd+S" },
      },
      { type: "item", labelKey: "menu.file.openProject", command: "project.open", accelerator: { macos: "Cmd+O" } },
      {
        type: "item",
        labelKey: "menu.file.settings",
        command: "settings.open",
        accelerator: { windows: "Ctrl+," },
        platforms: ["windows"],
      },
      {
        type: "item",
        labelKey: "menu.file.newWindow",
        action: "window.new",
        accelerator: { macos: "Cmd+Shift+N", windows: "Ctrl+Shift+N" },
      },
      { type: "separator" },
      { type: "item", labelKey: "menu.file.closeWindow", action: "window.close", role: "close" },
    ],
  },
  {
    id: "edit",
    labelKey: "menu.edit",
    items: [
      { type: "item", labelKey: "menu.edit.undo", action: "edit.undo", role: "undo", accelerator: { windows: "Ctrl+Z" } },
      { type: "item", labelKey: "menu.edit.redo", action: "edit.redo", role: "redo", accelerator: { windows: "Ctrl+Y" } },
      { type: "separator" },
      { type: "item", labelKey: "menu.edit.cut", action: "edit.cut", role: "cut", accelerator: { windows: "Ctrl+X" } },
      { type: "item", labelKey: "menu.edit.copy", action: "edit.copy", role: "copy", accelerator: { windows: "Ctrl+C" } },
      { type: "item", labelKey: "menu.edit.paste", action: "edit.paste", role: "paste", accelerator: { windows: "Ctrl+V" } },
      { type: "item", labelKey: "menu.edit.delete", action: "edit.delete" },
      {
        type: "item",
        labelKey: "menu.edit.selectAll",
        action: "edit.selectAll",
        role: "selectAll",
        accelerator: { windows: "Ctrl+A" },
      },
    ],
  },
  {
    id: "view",
    labelKey: "menu.view",
    items: [
      { type: "item", labelKey: "menu.view.toggleSidebar", command: "sidebar.toggle" },
      { type: "item", labelKey: "menu.view.toggleTerminal", command: "terminal.toggle", accelerator: { macos: "Ctrl+`" } },
      { type: "item", labelKey: "menu.view.toggleFileTree", command: "fileTree.toggle" },
      { type: "separator" },
      { type: "item", labelKey: "menu.view.reload", action: "view.reload", role: "reload" },
      { type: "item", labelKey: "menu.view.toggleDevTools", action: "view.toggleDevTools", role: "toggleDevTools" },
      { type: "separator" },
      {
        type: "item",
        labelKey: "menu.view.actualSize",
        action: "view.resetZoom",
        role: "resetZoom",
        accelerator: { windows: "Ctrl+0" },
      },
      { type: "item", labelKey: "menu.view.zoomIn", action: "view.zoomIn", role: "zoomIn", accelerator: { windows: "Ctrl++" } },
      { type: "item", labelKey: "menu.view.zoomOut", action: "view.zoomOut", role: "zoomOut", accelerator: { windows: "Ctrl+-" } },
      { type: "separator" },
      { type: "item", labelKey: "menu.view.toggleFullScreen", action: "view.toggleFullscreen", role: "togglefullscreen" },
    ],
  },
  {
    id: "go",
    labelKey: "menu.go",
    items: [
      { type: "item", labelKey: "menu.go.back", command: "common.goBack", accelerator: { macos: "Cmd+[" } },
      { type: "item", labelKey: "menu.go.forward", command: "common.goForward", accelerator: { macos: "Cmd+]" } },
      { type: "separator" },
      { type: "item", labelKey: "menu.go.previousSession", command: "session.previous", accelerator: { macos: "Option+Up" } },
      { type: "item", labelKey: "menu.go.nextSession", command: "session.next", accelerator: { macos: "Option+Down" } },
      { type: "separator" },
      {
        type: "item",
        labelKey: "menu.go.previousProject",
        command: "project.previous",
        accelerator: { macos: "Cmd+Option+Up" },
      },
      {
        type: "item",
        labelKey: "menu.go.nextProject",
        command: "project.next",
        accelerator: { macos: "Cmd+Option+Down" },
      },
    ],
  },
  {
    id: "window",
    labelKey: "menu.window",
    role: "windowMenu",
    items: [
      { type: "item", labelKey: "menu.window.minimize", action: "window.minimize" },
      { type: "item", labelKey: "menu.window.maximize", action: "window.toggleMaximize" },
      { type: "separator" },
      { type: "item", labelKey: "menu.window.closeWindow", action: "window.close" },
    ],
  },
  {
    id: "help",
    labelKey: "menu.help",
    items: [
      { type: "item", labelKey: "menu.help.documentation", href: "https://opencode.ai/docs" },
      { type: "item", labelKey: "menu.help.supportForum", href: "https://discord.com/invite/opencode" },
      { type: "item", labelKey: "menu.help.exportLogs", command: "logs.export" },
      { type: "separator" },
      {
        type: "item",
        labelKey: "menu.help.shareFeedback",
        href: "https://github.com/anomalyco/opencode/issues/new?template=feature_request.yml",
      },
      {
        type: "item",
        labelKey: "menu.help.reportBug",
        href: "https://github.com/anomalyco/opencode/issues/new?template=bug_report.yml",
      },
    ],
  },
]

export function desktopMenuVisible(item: { platforms?: DesktopMenuPlatform[] }, platform: DesktopMenuPlatform) {
  return !item.platforms || item.platforms.includes(platform)
}
