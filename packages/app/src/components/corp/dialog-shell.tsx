import { JSXElement, ParentProps, Show } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Dialog as DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { useSettings } from "@/context/settings"
import "./dialog-shell.css"

/**
 * Контейнер корп-окон в формате текущего экрана настроек (S-D6, S-D10).
 *
 * Настройки открываются двумя разными компонентами в зависимости от флага «New layout and designs»
 * (`packages/app/src/pages/layout.tsx`, `openSettings`): включён — `settings-v2` на `DialogV2`
 * (`x-large` = 800x560), выключен — прежний `dialog-settings.tsx` на `Dialog` (`x-large` = 960x600).
 * Корп-окна должны совпадать с тем, что видит пользователь, поэтому выбор контейнера собран здесь:
 * содержимое пишется один раз и не знает про флаг.
 *
 * **Ревизия 1.9 (S-D10, D-33).** Совпадать должен не объявленный размер контейнера, а **видимая**
 * высота панели: контейнер высоту задавал и раньше, а окно всё равно было ниже настроек, потому
 * что панель `dialog-content` растягивать себя не умеет (F45). Классы `corp-dialog` и
 * `corp-dialog-v2` растягивают её на всю высоту контейнера — см. `dialog-shell.css`. Высота
 * перестаёт зависеть от содержимого: ноль карточек, одна карточка, полный каталог, баннер «Hub
 * недоступен», предупреждение об отброшенных карточках и любое из четырёх пустых состояний дают
 * одно и то же окно. `fit` не передаётся ни в одной ветке флага — он снимает высоту контейнера.
 *
 * Размер — свойство контейнера, а не экрана: правило действует на все корп-окна (витрину, экран
 * входа, экран прав), и новый корп-экран получает его, ничего про размеры не зная.
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
        <Dialog
          size="x-large"
          transition
          class="corp-dialog"
          title={props.title}
          description={props.description}
          action={props.action}
        >
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
