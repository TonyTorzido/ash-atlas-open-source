import { RESOURCE_TYPES } from "@ash-atlas/shared";
import type {
  EquipmentSnapshotV2,
  InventoryProtectionSnapshot,
  PlayerInventorySnapshot,
  ResourceType
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { resourceDisplayName } from "../collectibles/harvest.js";
import { requestMobileMenuReturnToGame } from "../mobileGameMenu.js";
import { DestinationShell } from "./DestinationShell.js";
import { GameAppButton, GameAppSectionHeader, GameAppState, GameAppText, GameAppTabs } from "./GameAppShell.js";
import { ProtectionLockIcon } from "./ProtectionLockIcon.js";
import { ItemArtwork } from "./ItemArtwork.js";

type Props = {
  open: boolean;
  protection: InventoryProtectionSnapshot | null;
  inventory: PlayerInventorySnapshot;
  equipment: EquipmentSnapshotV2 | null;
  online: boolean;
  busy: boolean;
  layout: "desktop" | "phone";
  onSetMaterialKeep(
    itemId: ResourceType,
    variant: string | null,
    quantity: number,
    expectedRevision: number
  ): boolean;
  onSetUnique(
    equipmentInstanceId: string,
    protectedValue: boolean,
    expectedRevision: number
  ): boolean;
  onClose(): void;
};

export function InventoryProtectionPanel({
  open,
  protection,
  inventory,
  equipment,
  online,
  busy,
  layout,
  onSetMaterialKeep,
  onSetUnique,
  onClose
}: Props): React.JSX.Element | null {
  const [section, setSection] = useState("materials");
  const materials = useMemo(() => {
    const identities = new Map<string, {
      itemId: ResourceType;
      variant: string | null;
      currentTotal: number;
      keepQuantity: number;
    }>();
    for (const item of inventory.items) {
      if (item.resourceType === "fishing_rod" ||
          !(RESOURCE_TYPES as readonly string[]).includes(item.resourceType)) continue;
      const key = `${item.resourceType}\0${item.variant ?? ""}`;
      const current = identities.get(key);
      identities.set(key, {
        itemId: item.resourceType as ResourceType,
        variant: item.variant ?? null,
        currentTotal: (current?.currentTotal ?? 0) + item.quantity,
        keepQuantity: current?.keepQuantity ?? 0
      });
    }
    for (const policy of protection?.materialPolicies ?? []) {
      const key = `${policy.itemId}\0${policy.variant ?? ""}`;
      const current = identities.get(key);
      identities.set(key, {
        itemId: policy.itemId as ResourceType,
        variant: policy.variant,
        currentTotal: current?.currentTotal ?? 0,
        keepQuantity: policy.keepQuantity
      });
    }
    return [...identities.values()].sort((left, right) =>
      resourceDisplayName(left.itemId).localeCompare(resourceDisplayName(right.itemId)) ||
      (left.variant ?? "").localeCompare(right.variant ?? "")
    );
  }, [inventory, protection]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const initializedOpenRef = useRef(false);
  const authoritativeDraftsRef = useRef<Record<string, string>>({});
  const authoritativeRevisionRef = useRef<number | null>(null);
  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      authoritativeDraftsRef.current = {};
      authoritativeRevisionRef.current = null;
      setDrafts({});
      setValidationErrors({});
      return;
    }
    if (!protection) return;
    const authoritativeDrafts = Object.fromEntries(materials.map((material) => [
      `${material.itemId}\0${material.variant ?? ""}`,
      String(material.keepQuantity)
    ]));
    const opening = !initializedOpenRef.current;
    const previousAuthoritativeDrafts = authoritativeDraftsRef.current;
    const revisionAdvanced =
      authoritativeRevisionRef.current !== null &&
      protection.revision > authoritativeRevisionRef.current;
    setDrafts((current) => {
      if (opening) return authoritativeDrafts;
      const next = { ...current };
      for (const [key, value] of Object.entries(authoritativeDrafts)) {
        if (
          !(key in next) ||
          (
            revisionAdvanced &&
            previousAuthoritativeDrafts[key] !== value
          )
        ) {
          next[key] = value;
        }
      }
      return next;
    });
    if (opening) {
      setValidationErrors({});
    } else if (revisionAdvanced) {
      setValidationErrors((current) => Object.fromEntries(
        Object.entries(current).filter(
          ([key]) =>
            previousAuthoritativeDrafts[key] === authoritativeDrafts[key]
        )
      ));
    }
    initializedOpenRef.current = true;
    authoritativeDraftsRef.current = authoritativeDrafts;
    authoritativeRevisionRef.current = protection.revision;
  }, [materials, open, protection]);
  const uniqueById = new Map(
    (protection?.uniqueItems ?? []).map((item) => [item.equipmentInstanceId, item])
  );
  const uniqueItems = equipment?.instances
    .filter((item) => item.location !== "destroyed")
    .sort((left, right) => left.displayName.localeCompare(right.displayName)) ?? [];
  const updateDraft = (key: string, nextValue: string): void => {
    setDrafts((current) => ({ ...current, [key]: nextValue }));
    setValidationErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };
  const adjustDraft = (key: string, value: string, delta: number): void => {
    const quantity = parseKeepQuantity(value);
    if (quantity === null || !Number.isSafeInteger(quantity + delta) || quantity + delta < 0) {
      setValidationErrors((current) => ({
        ...current,
        [key]: "Enter a nonnegative whole number within the safe integer range."
      }));
      return;
    }
    updateDraft(key, String(quantity + delta));
  };

  return (
    <DestinationShell
      open={open}
      title="Item Protection"
      closeLabel="Close Item Protection"
      layout={layout}
      initialFocus="container"
      className="inventory-protection-destination"
      phoneBackLabel="Back to Inventory"
      phoneOnReturnToGame={() => { onClose(); requestMobileMenuReturnToGame(); }}
      onClose={onClose}
    >
      {!protection ? (
        <GameAppState variant="loading" className="inventory-status">Loading protection settings…</GameAppState>
      ) : (
        <div className="inventory-protection-layout">
          <GameAppTabs variant="housed" ariaLabel="Protection sections" tabs={[{ id: "materials", label: "Keep quantities" }, { id: "equipment", label: "Equipment locks" }]} activeTab={section} onChange={setSection} />
          <section className="game-app-scroll-region inventory-protection-scroll" tabIndex={0} hidden={section !== "materials"} aria-labelledby="material-protection-title">
            <GameAppSectionHeader
              title="Keep in Inventory"
              titleId="material-protection-title"
              description="Choose how many of each material to keep. The rest can be dropped or stored."
              className="inventory-protection-section-heading"
            />
            <div className="inventory-protection-list">
              {materials.map((material) => {
                const key = `${material.itemId}\0${material.variant ?? ""}`;
                const errorId = `material-protection-error-${encodeURIComponent(key)}`;
                const value = drafts[key] ?? String(material.keepQuantity);
                return (
                  <form
                    key={key}
                    className="inventory-protection-material"
                    noValidate
                    onSubmit={(event) => {
                      event.preventDefault();
                      const input = event.currentTarget.querySelector("input");
                      const quantity = parseKeepQuantity(value);
                      if (quantity === null) {
                        setValidationErrors((current) => ({
                          ...current,
                          [key]: "Enter a nonnegative whole number within the safe integer range."
                        }));
                        return;
                      }
                      if (
                        onSetMaterialKeep(
                          material.itemId,
                          material.variant,
                          quantity,
                          protection.revision
                        )
                      ) {
                        setValidationErrors((current) => {
                          if (!(key in current)) return current;
                          const next = { ...current };
                          delete next[key];
                          return next;
                        });
                        input?.blur();
                      }
                    }}
                  >
                    <div className="inventory-protection-item-copy">
                      <ItemArtwork itemId={material.itemId} label={resourceDisplayName(material.itemId)} />
                      <strong>{resourceDisplayName(material.itemId)}</strong>
                      <small>
                        {material.variant ? `${material.variant} · ` : ""}
                        {material.currentTotal.toLocaleString()} carried
                      </small>
                    </div>
                    <div className="inventory-protection-quantity">
                      <GameAppButton
                        type="button"
                        className="inventory-protection-step"
                        disabled={!online || busy}
                        aria-label={`Decrease protected ${resourceDisplayName(material.itemId)}`}
                        onClick={() => adjustDraft(key, value, -1)}
                      >
                        <span aria-hidden="true">-</span>
                      </GameAppButton>
                      <label>
                        <span className="sr-only">
                          Keep {resourceDisplayName(material.itemId)} in Inventory
                        </span>
                      <input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        value={value}
                        disabled={!online || busy}
                        aria-invalid={Boolean(validationErrors[key])}
                        aria-describedby={
                          validationErrors[key] ? errorId : undefined
                        }
                        onChange={(event) => updateDraft(key, event.currentTarget.value)}
                        aria-label={`Keep ${resourceDisplayName(material.itemId)} in Inventory`}
                      />
                      </label>
                      <GameAppButton
                        type="button"
                        className="inventory-protection-step"
                        disabled={!online || busy}
                        aria-label={`Increase protected ${resourceDisplayName(material.itemId)}`}
                        onClick={() => adjustDraft(key, value, 1)}
                      >
                        <span aria-hidden="true">+</span>
                      </GameAppButton>
                    </div>
                    <GameAppButton className="inventory-protection-save" variant="primary" type="submit" disabled={!online || busy}>
                      {busy ? "Saving..." : "Save"}
                    </GameAppButton>
                    {validationErrors[key] ? (
                      <GameAppText as="small" tone="error" className="inventory-protection-error" id={errorId} role="alert">
                        {validationErrors[key]}
                      </GameAppText>
                    ) : null}
                  </form>
                );
              })}
            </div>
          </section>
          <section className="game-app-scroll-region inventory-protection-scroll" tabIndex={0} hidden={section !== "equipment"} aria-labelledby="unique-protection-title">
            <GameAppSectionHeader
              title="Protected Items"
              titleId="unique-protection-title"
              description="Equipped items and saved kit pieces stay protected automatically."
              className="inventory-protection-section-heading"
            />
            <div className="inventory-protection-list">
              {uniqueItems.map((item) => {
                const policy = uniqueById.get(item.instanceId);
                return (
                  <div
                    key={item.instanceId}
                    className={`inventory-protection-toggle${
                      policy?.systemReason ? " system-protected" : ""
                    }`}
                  >
                    <span>
                      <ItemArtwork itemId={item.definitionId} category={item.category} label={item.displayName} />
                      <strong>{item.displayName}</strong>
                      <small>
                        {policy?.systemReason
                          ? policy.systemReason
                          : `Level ${item.itemLevel}`}
                      </small>
                    </span>
                    <GameAppButton
                      type="button"
                      className="inventory-protection-lock-toggle"
                      aria-pressed={Boolean(policy?.systemReason || policy?.protected)}
                      disabled={!online || busy || Boolean(policy?.systemReason)}
                      onClick={() => onSetUnique(
                        item.instanceId,
                        !(policy?.protected ?? false),
                        protection.revision
                      )}
                    >
                      <span className="inventory-protection-lock-glyph" aria-hidden="true">
                        <ProtectionLockIcon />
                      </span>
                      {policy?.systemReason
                        ? "Auto-protected"
                        : policy?.protected
                          ? "Protected"
                          : "Protect"}
                    </GameAppButton>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </DestinationShell>
  );
}

function parseKeepQuantity(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const quantity = Number(value);
  return Number.isSafeInteger(quantity) ? quantity : null;
}
