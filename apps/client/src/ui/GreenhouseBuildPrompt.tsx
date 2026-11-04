import {
  GREENHOUSE_BUILD_COST,
  type GreenhouseBuildPreview,
  type GreenhouseBuildSnapshot
} from "@ash-atlas/shared";

import { GameActionPrompt } from "./GameActionPrompt.js";
import { MaterialChips } from "./MaterialRequirements.js";

export function GreenhouseBuildPrompt({
  open,
  busy,
  disabled,
  error,
  preview,
  previewBusy,
  previewError,
  build,
  cancelBusy,
  onBuild,
  onRetryPreview,
  onCancelBuild,
  onClose,
  materialCounts
}: Readonly<{
  materialCounts?: Readonly<Record<string, number>> | undefined;
  open: boolean;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  preview: GreenhouseBuildPreview | null;
  previewBusy: boolean;
  previewError: string | null;
  build: GreenhouseBuildSnapshot | null;
  cancelBusy: boolean;
  onBuild(): void;
  onRetryPreview(): void;
  onCancelBuild(): void;
  onClose(): void;
}>): React.JSX.Element | null {
  if (!open) return null;
  if (build) {
    const riverbankCopy = build.eligibility.isRiverbank
      ? "✓ Riverbank bonus — 8h each stage"
      : "✓ Inland placement — 12h each stage";
    return <GameActionPrompt
      title="Greenhouse construction started"
      detail={`${riverbankCopy} · Move to cancel and refund.`}
      actions={[{
        key: "cancel-construction",
        label: cancelBusy ? "Cancelling…" : "Cancel Construction",
        enabled: !cancelBusy,
        busy: cancelBusy,
        tone: "danger",
        onSelect: onCancelBuild
      }]}
      cancelLabel="Close"
      onCancel={onClose}
    />;
  }
  const placementCopy = preview
    ? preview.eligibility.isRiverbank
      ? "✓ River-coast (riverbank) placement — 8h per stage"
      : "✓ Inland placement — 12h per stage"
    : previewBusy || !previewError
      ? "Checking authoritative placement…"
      : previewError ?? "Placement status is unavailable. Check again before building.";
  const canBuild = !busy && !disabled && !previewBusy && preview !== null && previewError === null;
  const buildDisabledReason = disabled
    ? "Reconnect to build a Greenhouse."
    : busy
      ? "A Greenhouse build request is still pending."
    : previewBusy
      ? "Checking authoritative placement…"
      : previewError
        ? "Check placement again before building."
        : preview
          ? null
          : "Waiting for authoritative placement.";
  return <GameActionPrompt
    title="Build Greenhouse Here?"
    detail={placementCopy}
    content={<>
      {error ? <p role="alert">{error}</p> : null}
      <MaterialChips label="Greenhouse construction materials" materials={GREENHOUSE_BUILD_COST.map((cost) => ({
        itemId: cost.itemId,
        quantity: cost.quantity,
        name: cost.itemId === "iron_bar" ? "Iron Bars" : cost.itemId.charAt(0).toUpperCase() + cost.itemId.slice(1),
        have: materialCounts ? materialCounts[cost.itemId] ?? 0 : undefined
      }))} />
      {preview ? <p>Three watering stages take {preview.stageDurationMs / (60 * 60 * 1_000)} hours each. Final placement is checked again when you build.</p> : null}
    </>}
    actions={[{
      key: "build-greenhouse",
      label: busy ? "Building…" : "Build Greenhouse",
      enabled: canBuild || busy,
      busy,
      onSelect: onBuild
    }, {
      key: "retry-placement",
      label: previewError ? "Check Placement Again" : "Refresh Placement",
      enabled: !busy && !disabled && !previewBusy,
      disabledReason: disabled ? "Reconnect to check placement." : previewBusy ? "Checking authoritative placement…" : null,
      onSelect: onRetryPreview
    }]}
    cancelLabel="Cancel"
    cancelWhileBusy
    onCancel={onClose}
  />;
}
