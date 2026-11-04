import { GameTargetPicker, type GameTargetChoice } from "./GameTargetPicker.js";

export type MobileWorldTargetChoice = GameTargetChoice;

export function MobileWorldTargetPicker({
  choices,
  onSelect,
  onQuickAction,
  onHighlight,
  onClose
}: {
  choices: readonly MobileWorldTargetChoice[];
  onSelect(key: string): void;
  onQuickAction(key: string): void;
  onHighlight?(key: string | null): void;
  onClose(): void;
}): React.JSX.Element {
  return <GameTargetPicker
    ariaLabel="Choose a world target"
    choices={choices}
    onSelect={onSelect}
    onQuickAction={onQuickAction}
    {...(onHighlight ? { onChoiceHighlight: onHighlight } : {})}
    onCancel={onClose}
  />;
}
