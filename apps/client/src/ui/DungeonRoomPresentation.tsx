import { useIndoorPresentationClock } from "./IndoorPresentationClock.js";
import type {
  CombatEntitySnapshot,
  DungeonEnemySnapshot,
  DungeonObjectSnapshot,
  DungeonResourceSnapshot,
  DungeonPrefabDefinition,
  DungeonRoomDefinition,
  DungeonSnapshot,
  MobArchetypeKey
} from "@ash-atlas/shared";
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  bossAppearanceForArchetype,
  bossOverallScale,
  combatPositionToDungeonLocal,
  harmfulStatusDisplayName,
  MOB_BUFF_DISPLAY_NAMES,
  type MobAppearanceVariant
} from "@ash-atlas/shared";

import {
  MOB_ARTWORK_URLS,
  bossPhaseArtworkKey,
  awakeArtworkKey,
  mobArtworkKey,
  mobArtworkSource
} from "../map/mobArtwork.js";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { dungeonEnemyVisualScale, eliteDisplayName, eliteModifierBadge } from "../features/interiorMap/dungeonElitePresentation.js";
import {
  damageFloaterPresentation,
  floatingFeedbackFamily,
  floatingFeedbackLabel
} from "../combat/damageFloaters.js";
import {
  projectileImpactPresentation,
  projectileImpactSpriteTransform
} from "../combat/projectileImpacts.js";
import { attackDirectionFromPoints } from "../combat/playerAppearancePose.js";
import { MOB_SPRITE_PRESENTATION } from "../map/mobSpritePresentation.js";
import {
  dungeonMobVisualHeight,
  dungeonProjectileBaseScale
} from "../map/spritePresentation.js";
import type { CombatPresentationController } from "../combat/combatPresentation.js";
import { HealthBarTrack } from "./HealthBarTrack.js";

export const DUNGEON_LAYER_ORDER = [
  "background", "below_player", "actors", "above_player", "ceiling"
] as const satisfies readonly (keyof DungeonRoomDefinition["layers"])[];

type DungeonLayerId = (typeof DUNGEON_LAYER_ORDER)[number];

export function dungeonAssetPublicUrl(assetKey: string): string | null {
  const prefix = "apps/client/public/";
  return assetKey.startsWith(prefix)
    ? `${import.meta.env.BASE_URL}${assetKey.slice(prefix.length)}`
    : null;
}

export function dungeonObjectAssetUrl(
  object: DungeonObjectSnapshot,
  prefab: DungeonPrefabDefinition
): string | null {
  if (object.assetKey) return dungeonAssetPublicUrl(object.assetKey);
  const stateAsset = prefab.stateAssets.find((asset) => asset.stateId === object.state);
  return dungeonAssetPublicUrl(stateAsset?.assetKey ?? prefab.assetKey);
}

/** Per-dungeon rockfall/grate/root prop drawn over a portal while its lock is held. */
const DUNGEON_BARRICADE_ASSET_KEYS: Readonly<Record<string, string>> = {
  cistern_warrens: "apps/client/public/assets/dungeons/cistern_warrens/grate-barricade.png",
  fangrock_cavern: "apps/client/public/assets/dungeons/fangrock_cavern/rockfall-barricade.png",
  the_eyrie: "apps/client/public/assets/dungeons/the_eyrie/bramble-barricade.png",
  blightwood_grove: "apps/client/public/assets/dungeons/blightwood_grove/root-barricade.png",
  golem_forge: "apps/client/public/assets/dungeons/golem_forge/slag-barricade.png"
};
/** Covers a 140-unit doorway with room to spare. */
export const DUNGEON_BARRICADE_SIZE = 220;

export type DungeonPortalBarricade = Readonly<{ portalId: string; x: number; y: number; assetKey: string }>;

/** The portals of this room whose server lock is currently held, with the art to draw over each. */
export function dungeonPortalBarricades(
  snapshot: Pick<DungeonSnapshot, "dungeonId" | "objects" | "portalLocks">
): DungeonPortalBarricade[] {
  const assetKey = DUNGEON_BARRICADE_ASSET_KEYS[snapshot.dungeonId];
  if (!assetKey) return [];
  return snapshot.objects.flatMap((object) =>
    object.kind === "portal" && object.portalId && snapshot.portalLocks[object.portalId] === true
      ? [{ portalId: object.portalId, x: object.x, y: object.y, assetKey }]
      : []);
}

export function dungeonEnemySpriteUrl(archetype: MobArchetypeKey): string | null {
  const artworkKey = mobArtworkKey(
    archetype,
    archetype === "goblin" ? "goblin" : null
  );
  return artworkKey ? MOB_ARTWORK_URLS[artworkKey] : null;
}

export function DungeonRoomPresentation({
  snapshot,
  actors,
  onSelectObject,
  onSelectResource
}: {
  snapshot: DungeonSnapshot;
  actors: ReactNode;
  onSelectObject(object: DungeonObjectSnapshot): void;
  onSelectResource?(resource: DungeonResourceSnapshot): void;
}): React.JSX.Element {
  const prefabs = new Map(snapshot.prefabs.map((prefab) => [prefab.id, prefab]));
  return <>
    {DUNGEON_LAYER_ORDER.map((layerId, layerIndex) => <div
      key={layerId}
      className={`dungeon-authored-layer dungeon-authored-layer-${layerId}`}
      data-dungeon-layer={layerId}
      style={{ zIndex: layerIndex + 1 }}
    >
      {snapshot.room.layers[layerId]
        .filter((placement) => !placement.retired)
        .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
        .map((placement) => {
          const prefab = prefabs.get(placement.prefabId);
          return prefab ? <DungeonLayerPlacement
            key={placement.id}
            placement={placement}
            prefab={prefab}
            roomWidth={snapshot.roomWidth}
            roomHeight={snapshot.roomHeight}
          /> : null;
        })}
      {snapshot.objects
        // Hidden chests and decorations (a lit hub segment) appear only once revealed.
        .filter((object) => object.layerId === layerId &&
          ((object.kind !== "chest" && object.kind !== "decoration") || object.available))
        .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
        .map((object) => <DungeonObjectArt
          key={object.id}
          object={object}
          prefab={prefabs.get(object.prefabId)}
          roomWidth={snapshot.roomWidth}
          roomHeight={snapshot.roomHeight}
          onSelect={onSelectObject}
        />)}
      {layerId === "actors" ? dungeonPortalBarricades(snapshot).map((barricade) => {
        const src = dungeonAssetPublicUrl(barricade.assetKey);
        return src ? <img
          key={`barricade:${barricade.portalId}`}
          className="dungeon-portal-barricade"
          data-portal-id={barricade.portalId}
          src={src}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            left: percent(barricade.x, snapshot.roomWidth),
            top: percent(barricade.y, snapshot.roomHeight),
            width: percent(DUNGEON_BARRICADE_SIZE, snapshot.roomWidth),
            height: percent(DUNGEON_BARRICADE_SIZE, snapshot.roomHeight),
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 20
          }}
        /> : null;
      }) : null}
      {layerId === "actors" ? (snapshot.resources ?? [])
        .filter((resource) => resource.state === "available")
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((resource) => {
          const prefab = resource.prefabId ? prefabs.get(resource.prefabId) : undefined;
          return <DungeonResourceArt
            key={resource.id}
            resource={resource}
            {...(prefab ? { prefab } : {})}
            roomWidth={snapshot.roomWidth}
            roomHeight={snapshot.roomHeight}
            onSelect={(resource) => onSelectResource?.(resource)}
          />;
        }) : null}
      {layerId === "actors" ? actors : null}
    </div>)}
  </>;
}

function DungeonResourceArt({
  resource,
  prefab,
  roomWidth,
  roomHeight,
  onSelect
}: {
  resource: DungeonResourceSnapshot;
  prefab?: DungeonPrefabDefinition;
  roomWidth: number;
  roomHeight: number;
  onSelect(resource: DungeonResourceSnapshot): void;
}): React.JSX.Element {
  const src = prefab ? dungeonAssetPublicUrl(prefab.assetKey) : null;
  return <button
    type="button"
    className={`dungeon-object dungeon-resource dungeon-resource-${resource.resourceType}`}
    data-resource-id={resource.id}
    data-resource-type={resource.resourceType}
    style={{
      left: percent(resource.x, roomWidth),
      top: percent(resource.y, roomHeight),
      width: percent(48, roomWidth),
      height: percent(48, roomHeight),
      zIndex: 30,
      transform: "translate(-50%, -50%)"
    }}
    aria-label={`${resource.resourceType.replaceAll("_", " ")} resource`}
    onClick={() => onSelect(resource)}
  >
    {src ? <img src={src} alt="" draggable={false} /> : <span aria-hidden="true">{resource.resourceType === "wood" ? "♣" : "◆"}</span>}
  </button>;
}

function DungeonLayerPlacement({
  placement,
  prefab,
  roomWidth,
  roomHeight
}: {
  placement: DungeonRoomDefinition["layers"][DungeonLayerId][number];
  prefab: DungeonPrefabDefinition;
  roomWidth: number;
  roomHeight: number;
}): React.JSX.Element | null {
  const src = dungeonAssetPublicUrl(prefab.assetKey);
  if (!src) return null;
  const style: CSSProperties = {
    left: percent(placement.x, roomWidth),
    top: percent(placement.y, roomHeight),
    width: percent(placement.width, roomWidth),
    height: percent(placement.height, roomHeight),
    zIndex: placement.zIndex,
    opacity: placement.opacity,
    transformOrigin: `${prefab.pivotX * 100}% ${prefab.pivotY * 100}%`,
    transform: authoredTransform(placement.rotationDeg, placement.flipX, placement.flipY)
  };
  if (prefab.renderMode === "tile") {
    return <div
      className="dungeon-authored-placement dungeon-authored-placement-tile"
      data-prefab-id={prefab.id}
      style={{
        ...style,
        backgroundImage: `url("${src}")`,
        backgroundSize: `${prefab.defaultWidth / placement.width * 100}% ${prefab.defaultHeight / placement.height * 100}%`
      }}
    />;
  }
  return <img
    className={`dungeon-authored-placement dungeon-authored-placement-${prefab.renderMode}`}
    data-prefab-id={prefab.id}
    src={src}
    alt=""
    draggable={false}
    style={style}
  />;
}

function DungeonObjectArt({
  object,
  prefab,
  roomWidth,
  roomHeight,
  onSelect
}: {
  object: DungeonObjectSnapshot;
  prefab: DungeonPrefabDefinition | undefined;
  roomWidth: number;
  roomHeight: number;
  onSelect(object: DungeonObjectSnapshot): void;
}): React.JSX.Element {
  const src = prefab ? dungeonObjectAssetUrl(object, prefab) : null;
  const width = prefab?.defaultWidth ?? 64;
  const height = prefab?.defaultHeight ?? 64;
  const pivotX = prefab?.pivotX ?? 0.5;
  const pivotY = prefab?.pivotY ?? 0.5;
  return <button
    type="button"
    className={`dungeon-object ${object.kind}`}
    data-object-state={object.state}
    data-object-available={object.available}
    style={{
      left: percent(object.x, roomWidth),
      top: percent(object.y, roomHeight),
      width: percent(width, roomWidth),
      height: percent(height, roomHeight),
      zIndex: object.zIndex,
      opacity: object.opacity,
      transformOrigin: `${pivotX * 100}% ${pivotY * 100}%`,
      transform: `translate(${-pivotX * 100}%, ${-pivotY * 100}%) ${authoredTransform(
        object.rotationDeg, object.flipX, object.flipY
      )}`
    }}
    aria-disabled={!object.available}
    aria-label={object.name}
    onClick={() => onSelect(object)}
  >
    {src ? <img src={src} alt="" draggable={false} /> : <span aria-hidden="true">◆</span>}
  </button>;
}

export function DungeonEnemyLayer({
  enemies,
  roomWidth,
  roomHeight,
  playerVisualHeight,
  combatEntities = [],
  combatPresentation,
  onSelectEnemy
}: {
  enemies: readonly DungeonEnemySnapshot[];
  roomWidth: number;
  roomHeight: number;
  playerVisualHeight: number;
  combatEntities?: readonly CombatEntitySnapshot[];
  combatPresentation?: CombatPresentationController;
  onSelectEnemy?(enemy: DungeonEnemySnapshot): void;
}): React.JSX.Element {
  const presentationNow = useIndoorPresentationClock();
  const combatEntitiesById = new Map(combatEntities.map((entity) => [entity.entityId, entity]));
  return <div className="dungeon-enemy-layer" aria-label="Dungeon enemies">
    {enemies.map((enemy) => {
      const combatEntity = combatEntitiesById.get(enemy.entityId);
      if (!combatEntity || combatEntity.kind !== "mob") return null;
      const localPosition = combatPositionToDungeonLocal(combatEntity);
      const targetEntity = combatEntity.targetEntityId
        ? combatEntitiesById.get(combatEntity.targetEntityId) ?? null
        : null;
      const targetPosition = targetEntity
        ? combatPositionToDungeonLocal(targetEntity)
        : null;
      const attackDirection = targetPosition
        ? attackDirectionFromPoints(localPosition, targetPosition)
        : null;
      const presentationKey = combatEntity.npcFaction?.presentationKey ??
        (enemy.archetype === "goblin" ? "goblin" : null);
      const artworkKey = bossPhaseArtworkKey(combatEntity.archetypeKey ?? enemy.archetype, combatEntity.bossEncounter?.phaseId)
        ?? awakeArtworkKey(
          mobArtworkKey(combatEntity.archetypeKey ?? enemy.archetype, presentationKey),
          combatEntity.mobBuffs, Date.now()
        );
      const artwork = artworkKey
        ? MOB_ARTWORK_URLS[artworkKey]
        : null;
      const presentation = artworkKey && artworkKey in MOB_SPRITE_PRESENTATION
        ? MOB_SPRITE_PRESENTATION[artworkKey as keyof typeof MOB_SPRITE_PRESENTATION]
        : MOB_SPRITE_PRESENTATION.generic;
      const appearanceVariant: MobAppearanceVariant = combatEntity.appearanceVariant ?? "normal";
      const source = artwork ?? null;
      const bossAppearance = appearanceVariant === "normal"
        ? bossAppearanceForArchetype(
            DEFAULT_BOSS_APPEARANCE_CATALOG,
            combatEntity.archetypeKey ?? enemy.archetype
          )
        : null;
      const visualHeight = dungeonMobVisualHeight(
        playerVisualHeight,
        presentation,
        dungeonEnemyVisualScale(enemy) * (bossAppearance
          ? bossOverallScale(DEFAULT_BOSS_APPEARANCE_CATALOG, bossAppearance.bossId)
          : 1)
      );
      const hitWidth = visualHeight * (presentation.hitGeometry.shape === "rectangle"
        ? presentation.hitGeometry.width / presentation.hitGeometry.height
        : 1);
      const style = {
        left: percent(localPosition.x, roomWidth),
        top: percent(localPosition.y, roomHeight),
        width: percent(hitWidth, roomWidth),
        height: percent(visualHeight, roomHeight),
        transform: `translate(${-presentation.anchorX * 100}%, ${-presentation.anchorY * 100}%)`,
        transformOrigin: `${presentation.anchorX * 100}% ${presentation.anchorY * 100}%`,
        "--dungeon-attack-direction-x": String(attackDirection?.x ?? 0),
        "--dungeon-attack-direction-y": String(attackDirection?.y ?? -1)
      } as CSSProperties & {
        "--dungeon-attack-direction-x": string;
        "--dungeon-attack-direction-y": string;
      };
      // The Corrupted Core: faint and untargetable inside a husk, glowing and exposed once thrown out.
      const corePhase = combatEntity.archetypeKey === "corrupted_core"
        ? /^(?:enraged_)?(possessing|exposed)_\d+$/u.exec(combatEntity.bossEncounter?.phaseId ?? "")?.[1] ?? null
        : null;
      const selectable = Boolean(
        combatEntity.lifeState === "alive" && combatEntity.currentHealth > 0 && onSelectEnemy &&
        corePhase !== "possessing"
      );
      const pose = combatPresentation?.poseFor(
        combatEntity.entityId,
        combatEntity,
        presentationNow()
      ) ?? "idle";
      const art = source ? <img
        key={enemy.entityId}
        className={`dungeon-enemy dungeon-enemy-${combatEntity.lifeState} dungeon-enemy-pose-${pose}`}
        data-enemy-archetype={enemy.archetype}
        data-mob-artwork-key={artworkKey ?? "generic"}
        src={source}
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{ width: "100%", height: "100%", left: "0", top: "0", transform: "none" }}
      /> : <span
        key={enemy.entityId}
        className={`dungeon-enemy dungeon-enemy-${combatEntity.lifeState} dungeon-enemy-generic dungeon-enemy-pose-${pose}`}
        data-enemy-archetype={enemy.archetype}
        data-mob-artwork-key="generic"
        role="img"
        aria-hidden="true"
        style={{
          width: "100%", height: "100%", left: "0", top: "0", transform: "none",
          color: "var(--aa-ui-active-bronze)"
        }}
      />;
      const health = <HealthBarTrack
        current={combatEntity.currentHealth}
        maximum={combatEntity.maxHealth}
        {...(combatEntity.ward === undefined ? {} : { ward: combatEntity.ward })}
        label={`${enemy.name} health`}
        className="dungeon-enemy-health"
      />;
      const status = (combatEntity.harmfulStatusIds ?? []).map((statusId) =>
        <span
          key={statusId}
          className="dungeon-enemy-status"
          data-status-id={statusId}
          aria-label={harmfulStatusDisplayName(statusId)}
        />
      );
      const buffs = (combatEntity.mobBuffs ?? []).filter((buff) => buff.endsAt > Date.now()).map((buff) =>
        <span
          key={buff.kind}
          className="dungeon-enemy-buff"
          data-buff-kind={buff.kind}
        >{MOB_BUFF_DISPLAY_NAMES[buff.kind]}</span>
      );
      const eliteLabel = enemy.elite ? <span className="dungeon-enemy-elite" data-elite-modifiers={enemy.elite.modifiers.join(" ")}>
        <span className="dungeon-enemy-elite-name">{eliteDisplayName(enemy.name)}</span>
        {enemy.elite.modifiers.map((modifier) =>
          <span key={modifier} className="dungeon-enemy-elite-badge" data-elite-modifier={modifier}>
            {eliteModifierBadge(modifier)}
          </span>)}
      </span> : null;
      const shielded = enemy.elite?.shieldActive === true;
      const visual = <div
        className={`dungeon-enemy-presentation${shielded ? " dungeon-enemy-shielded" : ""}${corePhase ? ` dungeon-enemy-core-${corePhase}` : ""}`}
        data-combat-pose={pose}
        data-combat-entity-id={combatEntity.entityId}
        style={style}
      >{art}{health}{eliteLabel}{status}{buffs}</div>;
      const hitTarget = selectable ? <button
        type="button"
        className="dungeon-enemy-target"
        data-combat-pose={pose}
        data-combat-entity-id={combatEntity.entityId}
        aria-label={enemy.name}
        style={style}
        onClick={(event) => { event.stopPropagation(); onSelectEnemy?.(enemy); }}
        onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      /> : null;
      return <Fragment key={enemy.entityId}>
        {visual}{hitTarget}
      </Fragment>;
    })}
  </div>;
}

export function DungeonCombatFeedback({
  snapshot,
  combatEntities,
  combatPresentation
}: {
  snapshot: DungeonSnapshot;
  combatEntities: readonly CombatEntitySnapshot[];
  combatPresentation: CombatPresentationController;
}): React.JSX.Element | null {
  const presentationNow = useIndoorPresentationClock();
  const [nowMs, setNowMs] = useState(() => presentationNow());
  const combatById = new Map(combatEntities.map((entity) => [entity.entityId, entity]));
  const pointForEntity = (entityId: string): { x: number; y: number } | null => {
    const combat = combatById.get(entityId);
    if (combat) return combatPositionToDungeonLocal(combat);
    if (snapshot.player.playerId === entityId) {
      return { x: snapshot.player.x, y: snapshot.player.y };
    }
    const occupant = snapshot.occupants.find((candidate) => candidate.playerId === entityId);
    return occupant ? { x: occupant.x, y: occupant.y } : null;
  };
  const floaters = combatPresentation.floatingFeedback.floaters().filter((floater) =>
    floatingFeedbackFamily(floater.kind) !== "reward"
  );
  const impacts = combatPresentation.projectileImpacts.impacts();
  useEffect(() => {
    if (floaters.length === 0 && impacts.length === 0) return;
    if (typeof requestAnimationFrame !== "function") return;
    let frameId: number | null = null;
    const tick = (): void => {
      const nextNow = presentationNow();
      combatPresentation.floatingFeedback.prune(nextNow);
      combatPresentation.projectileImpacts.prune(nextNow);
      setNowMs(nextNow);
      if (
        combatPresentation.floatingFeedback.floaters().length > 0 ||
        combatPresentation.projectileImpacts.impacts().length > 0
      ) frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [combatEntities, combatPresentation, snapshot.serverTime, floaters.length, impacts.length, presentationNow]);
  if (floaters.length === 0 && impacts.length === 0) return null;
  const percentX = (value: number): string => `${value / snapshot.roomWidth * 100}%`;
  const percentY = (value: number): string => `${value / snapshot.roomHeight * 100}%`;
  return <div className="dungeon-combat-feedback" aria-live="polite" data-feedback-now={nowMs}>
    {floaters.map((floater) => {
      const point = pointForEntity(floater.targetEntityId);
      if (!point) return null;
      const motion = damageFloaterPresentation(floater, nowMs, false);
      return <span
        key={floater.eventId}
        className={`dungeon-combat-floater dungeon-combat-floater-${floater.kind}`}
        data-combat-feedback-event-id={floater.eventId}
        style={{
          left: percentX(point.x),
          top: percentY(point.y),
          opacity: motion.alpha,
          transform: `translate(calc(-50% + ${motion.xOffsetPx}px), ${motion.yOffsetPx}px) scale(${motion.scale})`
        }}
      >{floater.label ?? floatingFeedbackLabel(floater)}</span>;
    })}
    {impacts.map((impact) => {
      const point = pointForEntity(impact.targetEntityId);
      if (!point) return null;
      const motion = projectileImpactPresentation(impact, nowMs, false);
      const projectileTransform = projectileImpactSpriteTransform(
        impact,
        pointForEntity(impact.sourceEntityId),
        point,
        dungeonProjectileBaseScale(snapshot.playerVisualHeight)
      );
      const source = playerAppearanceAssetUrl(impact.assetKey);
      return <span
        key={impact.eventId}
        className="dungeon-combat-projectile"
        data-combat-projectile-event-id={impact.eventId}
        style={{
          left: percentX(projectileTransform.positionX),
          top: percentY(projectileTransform.positionY),
          opacity: motion.alpha,
          transform: `translate(${-projectileTransform.anchorX * 100}%, ${-projectileTransform.anchorY * 100}%)`
        }}
        aria-hidden="true"
      >{source ? <img
        src={source}
        alt=""
        draggable={false}
        style={{
          transformOrigin: `${projectileTransform.anchorX * 100}% ${projectileTransform.anchorY * 100}%`,
          transform: `rotate(${projectileTransform.rotationRadians}rad) scale(${projectileTransform.scaleX}, ${projectileTransform.scaleY})`
        }}
      /> : null}</span>;
    })}
  </div>;
}

function percent(value: number, dimension: number): string {
  return `${value / dimension * 100}%`;
}

function authoredTransform(rotationDeg: number, flipX: boolean, flipY: boolean): string {
  return `rotate(${rotationDeg}deg) scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})`;
}
