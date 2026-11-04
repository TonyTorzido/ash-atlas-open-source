import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameTargetPicker } from "./GameTargetPicker.js";

export function GreenhouseWaterBucketPrompt({
  open,
  targeting,
  worldAvailable,
  waterBucketCount,
  ironCount,
  gallons,
  fill,
  busy,
  error,
  onBeginTarget,
  onCraft,
  onCancelFill,
  onClose
}: Readonly<{
  open: boolean;
  targeting: boolean;
  worldAvailable: boolean;
  waterBucketCount: number;
  ironCount: number;
  gallons: number;
  fill: { gallons: number; completesAt: number; rangeM: number } | null;
  busy: boolean;
  error: string | null;
  onBeginTarget(gallons: number): void;
  onCraft(): void;
  onCancelFill(): void;
  onClose(): void;
}>): React.JSX.Element | null {
  if (!open) return null;
  if (targeting) {
    return <GameActionPrompt
      title="Choose a river target"
      category="GREENHOUSE"
      detail={`Fresh river within 200m · ${gallons} gallon${gallons === 1 ? "" : "s"}`}
      message={{ text: error ?? "Tap or click a fresh river square on the map.", tone: error ? "error" : "muted" }}
      content={<p>Filling takes 3 seconds per gallon. Movement, a portal, or disconnect cancels the fill and preserves credited water.</p>}
      actions={[]}
      cancelLabel="Cancel targeting"
      onCancel={onClose}
    />;
  }
  if (waterBucketCount > 0 && worldAvailable && !fill) {
    return <GameTargetPicker
      title="Use Water Bucket"
      ariaLabel="Choose how much fresh river water to collect"
      choices={[1, 2, 3, 4, 5].map((quantity) => ({
        key: String(quantity),
        name: `${quantity} gallon${quantity === 1 ? "" : "s"}`,
        category: "Fresh river water",
        meta: `${quantity * 3} seconds`,
        detail: "Choose this amount, then target a fresh river square on the map."
      }))}
      onSelect={(key) => onBeginTarget(Number(key))}
      onQuickAction={(key) => onBeginTarget(Number(key))}
      onCancel={onClose}
    />;
  }
  const canCraft = waterBucketCount === 0 && ironCount >= 10 && !busy;
  const canUse = waterBucketCount > 0 && worldAvailable && !fill && !busy;
  const detail = fill
    ? `Filling ${fill.gallons} gallons · target was ${Math.round(fill.rangeM)}m away`
    : waterBucketCount > 0
      ? "Use on a fresh river within 200m."
      : "Craft with 10 Iron Ore.";
  return <GameActionPrompt
    title="Water Bucket"
    category="GREENHOUSE"
    detail={detail}
    message={error ? { text: error, tone: "error" } : null}
    content={<p>{fill ? "The bucket fills at 3 seconds per gallon." : "Water is credited in exact 0.1 gallon increments."}</p>}
    actions={[
      ...(waterBucketCount === 0 ? [{
        key: "craft",
        label: "Craft Water Bucket",
        enabled: canCraft,
        disabledReason: ironCount < 10 ? "Requires 10 Iron Ore." : busy ? "Action pending." : null,
        onSelect: onCraft
      }] : []),
      ...(waterBucketCount > 0 ? [{
        key: "fill",
        label: `Fill ${gallons} Gallon${gallons === 1 ? "" : "s"}`,
        enabled: canUse,
        disabledReason: !worldAvailable ? "Return to the world first." : fill ? "The bucket is already filling." : busy ? "Action pending." : null,
        onSelect: () => onBeginTarget(gallons)
      }] : []),
      ...(fill ? [{
        key: "cancel-fill",
        label: "Cancel Fill",
        enabled: !busy,
        onSelect: onCancelFill
      }] : [])
    ]}
    onCancel={onClose}
  />;
}
