import { describe, expect, it } from "vitest";

import { projectPlayerAppearance } from "./appearance.js";
import { DEFAULT_PLAYER_APPEARANCE_CATALOG } from "./appearanceCatalog.js";
import type { EquipmentSnapshotV2 } from "./equipment.js";
import { parseClientMessage, parseServerMessage } from "./protocol.js";

const restoredPlayer = {
  playerId: "player-1",
  username: "Player",
  displayColor: "#8760d0",
  regionCode: "region-1",
  zoneId: "zone-1",
  lat: 40,
  lon: -105,
  anchorLat: 40,
  anchorLon: -105,
  moveLeashRadiusM: 500,
  movementRevision: 3,
  relocationRevision: 2,
  targetLat: null,
  targetLon: null,
  moving: false,
  online: true,
  updatedAt: "2026-08-05T20:00:00.000Z"
};

describe("Salon world restoration protocol", () => {
  it("requires and parses the authoritative player snapshot on exit", () => {
    const message = { type: "SALON_EXITED", requestId: "exit-1", player: restoredPlayer };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
    expect(() => parseServerMessage(JSON.stringify({
      type: "SALON_EXITED",
      requestId: "exit-1"
    }))).toThrow();
  });

  it("accepts masks and standalone overlays in Salon save and editor messages", () => {
    const editorSessionId = "00000000-0000-4000-8000-000000000001";
    const save = {
      type: "SAVE_SALON_APPEARANCE",
      requestId: "save-mask",
      editorSessionId,
      expectedAppearanceRevision: 7,
      catalogRevision: 46,
      changes: {
        mask: "mask-1",
        beard: "black-beard",
        skinToneId: "dark",
        chest: "traveler_chest",
        shield: null
      }
    };
    expect(parseClientMessage(JSON.stringify(save))).toEqual(save);

    const opened = {
      type: "SALON_EDITOR_OPENED",
      requestId: "open-mask",
      editorSessionId,
      releaseSha: null,
      catalogRevision: 46,
      schemaVersion: 1,
      appearanceRevision: 7,
      styles: {
        mask: "mask-1",
        beard: "black-beard",
        skinToneId: "dark",
        chest: "traveler_chest",
        shield: null
      }
    };
    expect(parseServerMessage(JSON.stringify(opened))).toEqual(opened);
  });

  it("carries Nose, Mouth, and feature points through save and reconnect snapshots", () => {
    const editorSessionId = "00000000-0000-4000-8000-000000000001";
    const point = { x: 0.5, y: 8.4 };
    const save = {
      type: "SAVE_SALON_APPEARANCE",
      requestId: "save-face",
      editorSessionId,
      expectedAppearanceRevision: 7,
      catalogRevision: 46,
      changes: { nose: null, mouth: null, featurePoints: { eyes: point } }
    };
    expect(parseClientMessage(JSON.stringify(save))).toEqual(save);
    for (const featurePoints of [{ eyes: { x: Number.NaN, y: 1 } }, { cheeks: point }]) {
      expect(() => parseClientMessage(JSON.stringify({
        ...save,
        changes: { featurePoints }
      }))).toThrow();
    }

    // Reconnect: the server re-projects stored styles; out-of-area points fall back.
    const equipment = {
      playerId: "player-1",
      activeRevision: 7,
      readiedWeaponSlot: "melee",
      active: {
        head: null, chest: null, gloves: null, boots: null, ring: null, melee: null, secondary: null
      }
    } as unknown as EquipmentSnapshotV2;
    const appearance = projectPlayerAppearance(
      equipment,
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      {},
      undefined,
      "default",
      { eyes: "brown-eyes", featurePoints: { eyes: point, nose: { x: 400, y: 400 } } }
    );
    expect(appearance.styles?.featurePoints).toEqual({ eyes: point });
    const entered = {
      type: "SALON_ENTERED",
      structureId: "salon-1",
      salonSessionId: editorSessionId,
      displayColor: null,
      appearance,
      position: { x: 1, y: 2, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0,
      serverTime: 1
    };
    expect(parseServerMessage(JSON.stringify(entered))).toEqual(entered);

    // Players who never move a feature keep the previous snapshot shape.
    const plain = projectPlayerAppearance(equipment, DEFAULT_PLAYER_APPEARANCE_CATALOG);
    expect(Object.keys(plain.styles ?? {}).sort()).toEqual(["eyes", "skinToneId"]);
  });
});
