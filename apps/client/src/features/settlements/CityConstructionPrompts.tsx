import { ConfirmDialog } from "../../ui/ConfirmDialog.js";
import type { CityConstructionController } from "./useCityConstructionController.js";

export function CityConstructionPrompts({
  controller
}: {
  controller: CityConstructionController;
}): React.JSX.Element {
  const { view, actions } = controller;
  return <>
    {view.buildPrompt ? <ConfirmDialog
      title={view.buildPrompt.title}
      message={view.buildPrompt.message}
      confirmLabel={view.buildPrompt.title}
      busy={view.busy}
      tone="primary"
      onCancel={actions.cancelBuild}
      onConfirm={actions.confirmBuild}
    /> : null}
    {view.housePrompt ? <ConfirmDialog
      title={view.housePrompt.title}
      message={view.housePrompt.message}
      confirmLabel="Build City House"
      busy={view.busy}
      tone="primary"
      onCancel={actions.cancelHouseBuild}
      onConfirm={actions.confirmHouseBuild}
    /> : null}
    {view.destructionPrompt ? <ConfirmDialog
      title={view.destructionPrompt.title}
      message={view.destructionPrompt.message}
      confirmLabel={view.destructionPrompt.confirmLabel}
      busy={view.busy}
      onCancel={actions.cancelDestruction}
      onConfirm={actions.confirmDestruction}
    /> : null}
  </>;
}
