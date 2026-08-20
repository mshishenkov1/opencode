import { JSXElement, ParentProps, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Dialog as DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { useSettings } from "@/context/settings"
import "./dialog-shell.css"

/**
 * Контейнер корп-окон в формате текущего экрана настроек (S-D6).
 *
 * Настройки открываются двумя разными компонентами в зависимости от флага «New layout and designs»
 * (`packages/app/src/pages/layout.tsx`, `openSettings`): включён — `settings-v2` на `DialogV2`
 * (`x-large` = 800x560), выключен — прежний `dialog-settings.tsx` на `Dialog` (`x-large` = 960x600).
 * Корп-окна должны совпадать с тем, что видит пользователь, поэтому выбор контейнера собран здесь:
 * содержимое пишется один раз и не знает про флаг.
 */
export interface CorpDialogProps extends ParentProps {
  title?: JSXElement
  description?: JSXElement
  action?: JSXElement
}

export function CorpDialog(props: CorpDialogProps) {
  const settings = useSettings()

  return (
    <Show
      when={settings.general.newLayoutDesigns()}
      fallback={
        <Dialog size="x-large" transition title={props.title} description={props.description} action={props.action}>
          {props.children}
        </Dialog>
      }
    >
      <DialogV2
        size="x-large"
        class="corp-dialog-v2"
        title={props.title}
        description={props.description}
        action={props.action}
      >
        {props.children}
      </DialogV2>
    </Show>
  )
}
