import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  combatPositionToDungeonLocal,
  type DungeonCatalog, type DungeonObjectSnapshot, type DungeonResourceSnapshot
} from "@ash-atlas/shared";
import { DungeonZoneLayer } from "../../client/src/ui/DungeonZoneLayer.js";
import { GameActionPrompt, type GamePromptAction } from "../../client/src/ui/GameActionPrompt.js";
import { IndoorPresentationClock } from "../../client/src/ui/IndoorPresentationClock.js";
import { PlaytestPresentationClock } from "./playtestPresentationClock.js";
import { HealthBarTrack } from "../../client/src/ui/HealthBarTrack.js";
import { CombatPresentationController } from "../../client/src/combat/combatPresentation.js";
import type { CreatePlaytestInput, PlaytestCommand } from "./dungeonPlaytestContracts.js";
import type { SequencedPlaytestFrame } from "./dungeonPlaytestRoutes.js";
import { StudioApiError, type StudioApi } from "./studioApi.js";
import "../../client/src/ui/GameThemeTokens.css";
import "../../client/src/menuAppearance.css";
import "../../client/src/ui/IndoorScene.css";
import "../../client/src/ui/HealthBarTrack.css";
import "../../client/src/ui/DungeonScene.css";
import "./DungeonPlayTest.css";

type Props = {
  api: StudioApi;
  catalog: DungeonCatalog;
  dungeonId: string;
  mode: "full" | "room";
  roomId: string;
  onExit(): void;
};
type Selection = { kind: "enemy" | "object" | "resource" | "drop"; id: string } | null;
type PendingUtilityAction = "heal" | "damage" | null;
type Overlays = { collision: boolean; player: boolean; mobs: boolean; attacks: boolean; aggro: boolean; bounds: boolean; anchors: boolean; triggers: boolean; spawns: boolean; navigation: boolean };
const CLEAN_OVERLAYS: Overlays = { collision: false, player: false, mobs: false, attacks: false, aggro: false, bounds: false, anchors: false, triggers: false, spawns: false, navigation: false };
const OVERLAY_NAMES: Record<keyof Overlays, string> = { collision: "Collision geometry", player: "Player hitbox", mobs: "Mob targeting hitboxes", attacks: "Attack ranges", aggro: "Aggro ranges", bounds: "Room bounds", anchors: "Anchors", triggers: "Trigger zones", spawns: "Spawn positions", navigation: "Navigation target" };
const newSeed = (): string => `studio-${crypto.randomUUID()}`;

/** Owns transport and presentation only. Every gameplay action runs in the actual server engines. */
export function DungeonPlayTest(props: Props): React.JSX.Element {
  const [definition] = useState(() => structuredClone(props.catalog));
  const [request, setRequest] = useState<CreatePlaytestInput>(() => ({ catalog: definition, dungeonId: props.dungeonId, mode: props.mode, ...(props.mode === "room" ? { roomId: props.roomId } : {}), seed: newSeed() }));
  const [frame, setFrame] = useState<SequencedPlaytestFrame | null>(null);
  const [status, setStatus] = useState<"PLAY_INITIALIZING" | "ACTIVE" | "PLAY_EXITING">("PLAY_INITIALIZING");
  const [failure, setFailure] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [overlays, setOverlays] = useState<Overlays>(CLEAN_OVERLAYS);
  const [viewport, setViewport] = useState("workspace");
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [sceneGeneration, setSceneGeneration] = useState(0);
  const [seedDraft, setSeedDraft] = useState(request.seed);
  const [pendingUtilityAction, setPendingUtilityAction] = useState<PendingUtilityAction>(null);
  const clock = useRef(new PlaytestPresentationClock());
  const presentationNow = useCallback(() => clock.current.now(performance.now()), []);
  const presentation = useRef(new CombatPresentationController());
  const frameRef = useRef<SequencedPlaytestFrame | null>(null);
  const activeRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const resetZoomRef = useRef<(() => void) | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const onExitRef = useRef(props.onExit);
  onExitRef.current = props.onExit;
  const api = props.api;

  const accept = useCallback((next: SequencedPlaytestFrame): void => {
    const current = frameRef.current;
    if (!activeRef.current || (current && current.runId === next.runId && current.sequence >= next.sequence)) return;
    if (current?.snapshot.spaceId !== next.snapshot.spaceId) {
      presentation.current.clearScene(); setSelection(null); setTargetId(null);
    }
    clock.current.sync(next.snapshot.serverTime, next.debug.speed, next.lifecycle === "DEBUG_PAUSED" || next.lifecycle === "PLAYER_DEAD" || next.sandbox.exited, performance.now());
    presentation.current.enqueueCombatEvents(next.events, {
      nowMs: next.snapshot.serverTime,
      localPlayerId: next.snapshot.player.playerId,
      appearanceForEntity: (id) => id === next.snapshot.player.playerId ? next.appearance : undefined,
      pointForEntity: (id) => {
        const entity = next.combatEntities.find((value) => value.entityId === id);
        return entity ? combatPositionToDungeonLocal(entity) : null;
      }
    });
    frameRef.current = next; setFrame(next); setStatus("ACTIVE");
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ownedRun: string | null = null;
    activeRef.current = true; frameRef.current = null; setFrame(null);
    setStatus("PLAY_INITIALIZING"); setFailure(null); setSelection(null); setTargetId(null);
    setPendingUtilityAction(null);
    presentation.current.clear(); setSeedDraft(request.seed);
    queueRef.current = Promise.resolve();
    const poll = (): void => {
      if (cancelled || !ownedRun) return;
      const runId = ownedRun;
      const next = queueRef.current.then(() => api.advanceDungeonPlaytest(runId));
      queueRef.current = next.catch(() => undefined);
      void next.then((value) => {
        if (!cancelled) { accept(value); timer = setTimeout(poll, 50); }
      }).catch((error: unknown) => {
        if (!cancelled) { setFailure(errorText(error)); timer = setTimeout(poll, 1000); }
      });
    };
    void api.startDungeonPlaytest(request).then((value) => {
      ownedRun = value.runId;
      if (cancelled) { void api.stopDungeonPlaytest(value.runId).catch(() => undefined); return; }
      accept(value); rootRef.current?.focus(); poll();
    }).catch((error: unknown) => { if (!cancelled) setFailure(errorText(error)); });
    return () => {
      cancelled = true; activeRef.current = false; clearTimeout(timer);
      presentation.current.clear();
      if (ownedRun) void api.stopDungeonPlaytest(ownedRun).catch(() => undefined);
    };
  }, [accept, api, request]);

  const command = useCallback((value: PlaytestCommand): void => {
    const current = frameRef.current;
    if (!current || !activeRef.current) return;
    const runId = current.runId;
    setFailure(null);
    const utilityAction: PendingUtilityAction = value.type === "heal" || value.type === "damage" ? value.type : null;
    if (utilityAction) setPendingUtilityAction(utilityAction);
    const next = queueRef.current.then(() => api.commandDungeonPlaytest(runId, value));
    queueRef.current = next.catch(() => undefined);
    void next.then((result) => {
      if (frameRef.current?.runId !== runId) return;
      if (value.type === "restart_room") {
        presentation.current.clearScene(); setSelection(null); setTargetId(null);
        setSceneGeneration((generation) => generation + 1);
      }
      accept(result);
    })
      .catch((error: unknown) => { if (frameRef.current?.runId === runId) setFailure(errorText(error)); })
      .finally(() => { if (utilityAction && frameRef.current?.runId === runId) setPendingUtilityAction(null); });
  }, [accept, api]);

  const exit = useCallback((): void => {
    activeRef.current = false; setStatus("PLAY_EXITING");
    const runId = frameRef.current?.runId;
    if (!runId) { onExitRef.current(); return; }
    void api.stopDungeonPlaytest(runId).catch(() => undefined).finally(() => onExitRef.current());
  }, [api]);
  const restart = (seed = request.seed, mode: "full" | "room" = "full", roomId?: string): void => {
    setRequest({ catalog: definition, dungeonId: props.dungeonId, mode, seed, ...(roomId ? { roomId } : {}) });
  };
  const attack = useCallback((id?: string): void => {
    const current = frameRef.current;
    const target = id ?? targetId ?? current?.snapshot.player.targetEntityId;
    if (!target) return;
    setTargetId(target); setSelection(null); command({ type: "attack", targetEntityId: target });
  }, [command, targetId]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof Element && (event.target.closest("button,a,input,textarea,select,summary,[role=button],[contenteditable=true]") || !rootRef.current?.contains(event.target))) return;
      if (event.code === "Space" && !event.repeat) { event.preventDefault(); attack(); }
      if (event.key.toLowerCase() === "p" && !event.repeat) { event.preventDefault(); command({ type: "debug", paused: frameRef.current?.lifecycle !== "DEBUG_PAUSED" }); }
      if (event.key === "Escape") { if (selection) setSelection(null); else if (debugOpen) setDebugOpen(false); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [attack, command, debugOpen, selection]);

  useEffect(() => {
    const paused = frame?.lifecycle === "DEBUG_PAUSED" || frame?.sandbox.exited;
    for (const animation of rootRef.current?.getAnimations?.({ subtree: true }) ?? []) {
      animation.playbackRate = frame?.debug.speed ?? 1;
      if (paused) animation.pause(); else if (animation.playState === "paused") animation.play();
    }
  }, [frame]);

  const dungeon = definition.dungeons.find((value) => value.id === props.dungeonId)!;
  const snapshot = frame?.snapshot;
  const paused = frame?.lifecycle === "DEBUG_PAUSED";
  const dead = frame?.lifecycle === "PLAYER_DEAD";
  const exited = frame?.sandbox.exited ?? false;
  const player = snapshot?.player;
  const selectedEnemy = selection?.kind === "enemy" ? frame?.combatEntities.find((value) => value.entityId === selection.id && value.lifeState === "alive") : undefined;
  const selectedObject = selection?.kind === "object" ? snapshot?.objects.find((value) => value.id === selection.id) : undefined;
  const selectedResource = selection?.kind === "resource" ? snapshot?.resources?.find((value) => value.id === selection.id) : undefined;
  const selectedDrop = selection?.kind === "drop" ? frame?.drops.find((value) => value.dropId === selection.id) : undefined;
  const diagnostics = snapshot?.cues.filter(isRuntimeDiagnosticCue) ?? [];
  const invoke = (value: PlaytestCommand): void => { setSelection(null); command(value); };
  let prompt: { title: string; category: string; detail?: string; actions: GamePromptAction[] } | null = null;
  if (selectedEnemy) prompt = { title: selectedEnemy.name, category: "ENEMY", detail: `${selectedEnemy.currentHealth} / ${selectedEnemy.maxHealth} HP`, actions: [{ key: "attack", label: "Attack", enabled: !dead && !paused && !exited, onSelect: () => attack(selectedEnemy.entityId) }] };
  if (selectedObject) prompt = objectPrompt(selectedObject, !dead && !paused && !exited, invoke);
  if (selectedResource) prompt = resourcePrompt(selectedResource, !dead && !paused && !exited, invoke);
  if (selectedDrop) prompt = { title: selectedDrop.itemId.replaceAll("_", " "), category: "DROPPED ITEM", detail: `Quantity: ${selectedDrop.quantity}`, actions: [{ key: "pickup", label: "Pick up", enabled: !dead && !paused && !exited, onSelect: () => invoke({ type: "pickup", dropId: selectedDrop.dropId }) }] };
  const activeTarget = frame?.combatEntities.find((value) => value.entityId === (targetId ?? player?.targetEntityId) && value.lifeState === "alive");
  const healDisabled = status !== "ACTIVE" || !frame || exited || pendingUtilityAction !== null;
  const damageDisabled = status !== "ACTIVE" || !frame || exited || dead || !activeTarget || pendingUtilityAction !== null;

  return <IndoorPresentationClock.Provider value={presentationNow}><section ref={rootRef} tabIndex={-1} className="studio-playtest" aria-label="Dungeon Play Test" data-playtest-state={status === "ACTIVE" ? frame?.lifecycle : status}>
    <header className="studio-playtest-toolbar">
      <div className="studio-playtest-title"><span>{request.mode === "room" ? "QUICK ROOM TEST" : "FULL DUNGEON PLAY TEST"}</span><h2>{dungeon.name}</h2><small>{snapshot?.room.name ?? "Preparing dungeon…"}</small></div>
      <div className="studio-playtest-actions">
        <button type="button" onClick={() => restart()} title="Fresh state, same seed, dungeon Start">Restart Dungeon</button>
        <button type="button" disabled={!frame || exited} onClick={() => command({ type: "restart_room" })}>Restart Room</button>
        <button type="button" disabled={!frame || dead || exited} onClick={() => command({ type: "debug", paused: !paused })}>{paused ? "Resume" : "Pause"}</button>
        <button type="button" aria-expanded={debugOpen} aria-controls="studio-playtest-debug" onClick={() => setDebugOpen((value) => !value)}>Debug</button>
        <button type="button" className="primary" onClick={exit} disabled={status === "PLAY_EXITING"}>Exit Play Test</button>
      </div>
    </header>
    {request.mode === "room" ? <div className="studio-playtest-room-notice">Room-only test · Full Dungeon Play Test lets you test the path from Start.<button type="button" onClick={() => restart()}>Test full dungeon</button></div> : null}
    {diagnostics.length ? <section className="studio-playtest-diagnostics" role="alert" aria-label="Dungeon runtime diagnostics">
      <strong>Runtime diagnostics require attention</strong>
      <span>Resolve these authored runtime warnings before treating the Play Test as complete.</span>
      <ul>{diagnostics.map((cue) => { const detail = describeRuntimeDiagnostic(cue); return <li key={cue} data-severity={cue.startsWith("error:") ? "error" : "warning"}><strong>{detail.summary}</strong><span>{detail.guidance}</span><code>{cue}</code></li>; })}</ul>
    </section> : null}
    <div className={`studio-playtest-workspace ${debugOpen ? "with-debug" : ""}`}>
      <div className={`studio-playtest-viewport ${viewport}`}>
        {snapshot && frame ? <DungeonZoneLayer key={`${frame.runId}:${sceneGeneration}`} snapshot={snapshot} drops={frame.drops} movementDisabled={dead || paused || exited || status !== "ACTIVE"}
          onMove={(x, y) => { setSelection(null); command({ type: "move", x, y }); }}
          onSelectObject={(object) => setSelection({ kind: "object", id: object.id })}
          onSelectResource={(resource) => setSelection({ kind: "resource", id: resource.id })}
          onSelectEnemy={(enemy) => { setTargetId(enemy.entityId); setSelection({ kind: "enemy", id: enemy.entityId }); }}
          combatEntities={frame.combatEntities} combatPresentation={presentation.current}
          onSelectDroppedItem={(drop) => setSelection({ kind: "drop", id: drop.dropId })} onStageElementChange={setStage}
          onResetZoomReady={(reset) => { resetZoomRef.current = reset; }} /> : null}
        {stage && frame ? createPortal(<PlaytestOverlays frame={frame} options={overlays} stage={stage} />, stage) : null}
        {status === "PLAY_INITIALIZING" ? <div className="studio-playtest-state" role="status"><strong>Preparing isolated dungeon</strong><span>{failure ?? "Creating player, encounters and room state…"}</span>{failure ? <button type="button" onClick={() => restart(request.seed, request.mode, request.roomId)}>Retry</button> : null}</div> : null}
        {paused ? <div className="studio-playtest-paused" role="status">Paused<button type="button" onClick={() => command({ type: "debug", paused: false })}>Resume</button></div> : null}
        {dead ? <GameActionPrompt forced title="You have fallen" category="PLAY TEST" ariaLabel="Play Test player defeated" actions={[{ key: "restart", label: "Restart Dungeon", onSelect: () => restart() }, { key: "room", label: "Restart Current Room", tone: "secondary", onSelect: () => command({ type: "restart_room" }) }, { key: "exit", label: "Return to editing", tone: "secondary", onSelect: exit }]} onCancel={() => undefined} /> : prompt ? <GameActionPrompt {...prompt} onCancel={() => setSelection(null)} /> : null}
        {frame?.sandbox.exited ? <div className="studio-playtest-complete" role="status">Run exited through the dungeon portal.<button type="button" onClick={() => restart()}>Restart Dungeon</button><button type="button" onClick={exit}>Return to editing</button></div> : frame?.lifecycle === "DUNGEON_COMPLETED" ? <div className="studio-playtest-complete" role="status">Dungeon completed · Continue exploring, restart, or return to editing.</div> : null}
      </div>
      {debugOpen && frame ? <aside id="studio-playtest-debug" className="studio-playtest-debug" aria-label="Play Test debugging">
        <h3>Run controls</h3><fieldset disabled={exited} className="studio-playtest-debug-controls">
        <label>Simulation speed<select aria-label="Simulation speed" value={frame.debug.speed} onChange={(event) => command({ type: "debug", speed: Number(event.target.value) })}>{[.25, .5, 1, 2, 4].map((value) => <option key={value} value={value}>{value}×</option>)}</select></label>
        {([['invulnerable', 'Player invulnerability'], ['aiEnabled', 'AI enabled'], ['aggroEnabled', 'Mob aggro enabled']] as const).map(([key, label]) => <label className="toggle" key={key}><input type="checkbox" checked={frame.debug[key]} onChange={(event) => command({ type: "debug", [key]: event.target.checked })} />{label}</label>)}
        <div className="studio-playtest-debug-actions"><button type="button" onClick={() => command({ type: "heal" })}>Heal player</button><button type="button" onClick={() => command({ type: "kill_room" })}>Kill room mobs</button><button type="button" onClick={() => command({ type: "restart_room" })}>Reset encounter</button></div>
        <label>Teleport to room<select aria-label="Teleport to room" value="" onChange={(event) => { if (event.target.value) command({ type: "teleport", roomId: event.target.value }); }}><option value="">Choose room…</option>{dungeon.rooms.filter((room) => !room.retired && room.active).map((room) => <option key={room.id} value={room.id}>{room.name}{room.id === dungeon.entrance.roomId ? " · Start" : ""}</option>)}</select></label>
        </fieldset><h3>Overlays</h3>
        {(Object.keys(OVERLAY_NAMES) as (keyof Overlays)[]).map((key) => <label className="toggle" key={key}><input type="checkbox" checked={overlays[key]} onChange={(event) => setOverlays((current) => ({ ...current, [key]: event.target.checked }))} />{OVERLAY_NAMES[key]}</label>)}
        <h3>Reproduce a run</h3>
        <label>Run seed<input aria-label="Run seed" maxLength={160} value={seedDraft} onChange={(event) => setSeedDraft(event.target.value)} /></label>
        <div className="studio-playtest-debug-actions"><button type="button" disabled={!seedDraft.trim()} onClick={() => restart(seedDraft.trim())}>Replay seed from Start</button><button type="button" onClick={() => restart(newSeed())}>New Simulated Run</button></div>
        <h3>Sandbox loot</h3><p>{frame.sandbox.gold} gold · {frame.sandbox.cityCoins} city coins</p>
        {Object.keys(frame.sandbox.inventory).length ? <ul>{Object.entries(frame.sandbox.inventory).map(([item, count]) => <li key={item}>{item.replaceAll("_", " ")} × {count}</li>)}</ul> : <p className="studio-playtest-loot-empty">No rewards collected in this run.</p>}
        <details><summary>Runtime and event log</summary><dl><dt>Dungeon</dt><dd>{dungeon.id}</dd><dt>Run</dt><dd>{frame.runId}</dd><dt>Instance</dt><dd>{snapshot?.instanceId}</dd><dt>Room</dt><dd>{snapshot?.spaceId}</dd><dt>Position</dt><dd>{player?.x.toFixed(1)}, {player?.y.toFixed(1)}</dd><dt>State</dt><dd>{frame.lifecycle}</dd><dt>Target</dt><dd>{activeTarget?.name ?? "None"}</dd></dl><h4>Encounters</h4>{snapshot?.encounters.map((encounter) => <p key={encounter.id}>{encounter.id}: {encounter.state}</p>)}<h4>Triggers</h4>{snapshot?.triggers.map((trigger) => <p key={trigger.id}>{trigger.id}: {trigger.enabled ? "enabled" : "disabled"} · {trigger.firedCount} fired</p>)}<h4>Enemies</h4>{frame.combatEntities.filter((entity) => entity.kind === "mob").map((entity) => <p key={entity.entityId}>{entity.name} · {entity.currentHealth}/{entity.maxHealth} HP · {entity.activityState}</p>)}<ol>{frame.log.slice(-30).map((entry, index) => <li key={`${index}:${entry}`}>{entry}</li>)}</ol></details>
      </aside> : null}
    </div>
    <footer className="studio-playtest-hud">
      <div className="studio-playtest-player"><strong>{frame ? `${frame.classId[0]?.toUpperCase()}${frame.classId.slice(1)} · ${frame.weaponName} · ${frame.armorName}` : "Warrior"}</strong><HealthBarTrack current={player?.currentHealth ?? 0} maximum={player?.maxHealth ?? 1} label="Test player health" className="studio-playtest-health" /><span>{player?.currentHealth ?? "—"} / {player?.maxHealth ?? "—"} HP</span></div>
      <div className="studio-playtest-combat-controls"><button type="button" className="primary" disabled={healDisabled} aria-busy={pendingUtilityAction === "heal"} title="Restore the test player to full health" onClick={() => command({ type: "heal" })}>Fully Heal</button><button type="button" className="danger" disabled={damageDisabled} aria-busy={pendingUtilityAction === "damage"} title={activeTarget ? `Deal 1,000 damage to ${activeTarget.name}` : "Select a living enemy to deal 1,000 damage"} onClick={() => { if (activeTarget) command({ type: "damage", targetEntityId: activeTarget.entityId, amount: 1000 }); }}>1,000 Damage</button><button type="button" disabled={!activeTarget || dead || paused || exited} onClick={() => attack()}>Attack{activeTarget ? ` ${activeTarget.name}` : " selected enemy"}<kbd>Space</kbd></button><button type="button" disabled={!frame || dead || exited} onClick={() => { setTargetId(null); command({ type: "cancel_combat" }); }}>Stop combat</button></div>
      <div className="studio-playtest-view-controls"><label>Viewport<select aria-label="Play Test viewport" value={viewport} onChange={(event) => setViewport(event.target.value)}><option value="workspace">Workspace</option><option value="desktop">Desktop 16:9</option><option value="tablet">Tablet 4:3</option><option value="phone">Phone portrait</option></select></label><button type="button" onClick={() => resetZoomRef.current?.()}>Default camera</button></div>
    </footer>
    <div className="studio-playtest-hint"><span>Double-click / double-tap to move · Select enemy → Attack · Wheel / pinch to zoom · P pauses</span><span>Isolated run · No live player, inventory or world writes</span></div>
    {failure && status !== "PLAY_INITIALIZING" ? <div className="studio-playtest-error" role="alert">{failure}<button type="button" aria-label="Dismiss Play Test error" onClick={() => setFailure(null)}>Dismiss</button></div> : null}
  </section></IndoorPresentationClock.Provider>;
}

function objectPrompt(object: DungeonObjectSnapshot, enabled: boolean, invoke: (command: PlaytestCommand) => void): { title: string; category: string; actions: GamePromptAction[] } {
  return { title: object.name, category: object.kind.replaceAll("_", " ").toUpperCase(), actions: [{ key: "interact", label: object.interactionLabel || (object.kind === "chest" ? "Open" : "Use"), enabled: enabled && object.available, disabledReason: object.available ? null : "Unavailable until its requirements are met", onSelect: () => invoke(object.portalId ? { type: "portal", portalId: object.portalId } : { type: "interact", objectId: object.id }) }] };
}
function resourcePrompt(resource: DungeonResourceSnapshot, enabled: boolean, invoke: (command: PlaytestCommand) => void) {
  return { title: resource.resourceType.replaceAll("_", " "), category: "RESOURCE", actions: [{ key: "gather", label: "Gather", enabled: enabled && resource.state === "available", onSelect: () => invoke({ type: "harvest", resourceId: resource.id }) }] };
}
function errorText(error: unknown): string {
  if (error instanceof StudioApiError && error.issues.length > 0) {
    return `${error.message} ${error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
  }
  return error instanceof Error ? error.message : "Play Test could not continue.";
}

function isRuntimeDiagnosticCue(cue: string): boolean {
  return cue.startsWith("warning:") || cue.startsWith("error:");
}

function describeRuntimeDiagnostic(cue: string): { summary: string; guidance: string } {
  const [, code] = cue.split(":", 3);
  switch (code) {
    case "resource_zone_underfilled":
      return { summary: "Resource zone is underfilled", guidance: "Add or reposition resource nodes so the authored zone can meet its target." };
    case "reward_grant_failed":
      return { summary: "Reward delivery failed", guidance: "Verify the reward authority and reward table before treating this run as complete." };
    case "unsupported_reward_authority":
      return { summary: "Reward authority is unavailable", guidance: "This run cannot prove reward delivery until the configured authority is available." };
    case "event_drain_budget_exceeded":
      return { summary: "Trigger processing exceeded its safety budget", guidance: "Inspect trigger loops before publishing this dungeon." };
    case "dungeon_state_hydration_unavailable":
      return { summary: "Saved dungeon state could not be loaded", guidance: "Restart or inspect persistence before treating this run as representative." };
    default:
      return { summary: "Dungeon runtime reported an issue", guidance: "Resolve this runtime diagnostic before treating the Play Test as complete." };
  }
}

function PlaytestOverlays({ frame, options, stage }: { frame: SequencedPlaytestFrame; options: Overlays; stage: HTMLElement }): React.JSX.Element | null {
  if (!Object.values(options).some(Boolean)) return null;
  const room = frame.snapshot.room;
  const player = frame.snapshot.player;
  const stageBounds = stage.getBoundingClientRect();
  const mobTargets = options.mobs && stageBounds.width > 0 ? Array.from(stage.querySelectorAll<HTMLElement>(".dungeon-enemy-target")).map((target) => {
    const bounds = target.getBoundingClientRect();
    const hit = getComputedStyle(target, "::after");
    const width = Math.max(bounds.width, Number.parseFloat(hit.width) || bounds.width);
    const height = Math.max(bounds.height, Number.parseFloat(hit.height) || bounds.height);
    return { id: target.dataset.combatEntityId, x: (bounds.left + bounds.width / 2 - width / 2 - stageBounds.left) / stageBounds.width * room.width, y: (bounds.top + bounds.height / 2 - height / 2 - stageBounds.top) / stageBounds.height * room.height, width: width / stageBounds.width * room.width, height: height / stageBounds.height * room.height };
  }) : [];
  return <svg className="studio-playtest-overlays" aria-label="Play Test geometry overlays" viewBox={`0 0 ${room.width} ${room.height}`} preserveAspectRatio="none">
    {options.bounds ? <rect className="bounds" x={0} y={0} width={room.width} height={room.height} /> : null}
    {options.collision ? room.colliders.filter((value) => !value.retired).map((value) => value.kind === "polygon" ? <polygon className="collision" key={value.id} points={value.points.map((point) => `${point.x},${point.y}`).join(" ")} /> : <rect className="collision" key={value.id} x={value.x} y={value.y} width={value.width} height={value.height} />) : null}
    {options.triggers ? room.zones.filter((value) => !value.retired).map((zone) => zone.kind === "polygon" ? <polygon className="trigger" key={zone.id} points={zone.points.map((point) => `${point.x},${point.y}`).join(" ")} /> : <rect className="trigger" key={zone.id} x={zone.x} y={zone.y} width={zone.width} height={zone.height} />) : null}
    {options.player ? <circle className="hitbox" cx={player.x} cy={player.y} r={frame.geometry.playerCollisionRadius} /> : null}
    {options.attacks ? <circle className="attack" cx={player.x} cy={player.y} r={frame.geometry.playerAttackRange} /> : null}
    {mobTargets.map((target) => <rect className="hitbox" key={target.id} x={target.x} y={target.y} width={target.width} height={target.height} />)}
    {frame.geometry.mobs.map((geometry) => { const entity = frame.combatEntities.find((value) => value.entityId === geometry.entityId); if (!entity) return null; const point = combatPositionToDungeonLocal(entity); return <g key={entity.entityId}>{options.attacks ? <circle className="attack" cx={point.x} cy={point.y} r={geometry.attackRange} /> : null}{options.aggro ? <circle className="aggro" cx={point.x} cy={point.y} r={geometry.aggroRange} /> : null}</g>; })}
    {options.anchors ? room.anchors.filter((anchor) => !anchor.retired).map((anchor) => <g className="anchor" key={anchor.id}><circle cx={anchor.x} cy={anchor.y} r={5} /><text x={anchor.x + 8} y={anchor.y - 8}>{anchor.id}</text></g>) : null}
    {options.spawns ? frame.geometry.spawns.map((point) => <g className="spawn" key={point.id}><path d={`M${point.x - 9},${point.y}h18M${point.x},${point.y - 9}v18`} /><text x={point.x + 10} y={point.y - 10}>{point.kind}</text></g>) : null}
    {options.navigation && player.targetX !== null && player.targetY !== null ? <path className="route" d={`M${player.x},${player.y}L${player.targetX},${player.targetY}`} /> : null}
  </svg>;
}
