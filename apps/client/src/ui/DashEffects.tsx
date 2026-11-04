import { useEffect, useRef, useSyncExternalStore } from "react";
import type { LatLon, PlayerSnapshot } from "@ash-atlas/shared";

import { dashClientState } from "../movement/dash.js";
import "./DashEffects.css";

/** Procedural dash FX (no sprite art): a dust puff where the dash starts and a fading motion streak. */

type ProjectingMap = { project(lngLat: [number, number]): { x: number; y: number } };

type Props = Readonly<{
  getMap(): ProjectingMap | null;
  players: readonly PlayerSnapshot[];
  localPlayerId: string | null;
}>;

const FX_LIFETIME_MS = 650;
const PUFF_COUNT = 9;
const GHOST_COUNT = 4;

type Effect = { id: number; from: LatLon; to: LatLon; bornAt: number; root: HTMLDivElement };

export function DashEffects({ getMap, players, localPlayerId }: Props): React.JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const effects = useRef<Effect[]>([]);
  const nextId = useRef(1);
  const raf = useRef(0);
  const seenRemote = useRef(new Map<string, number>());
  const getMapRef = useRef(getMap);
  getMapRef.current = getMap;

  const animate = (): void => {
    const map = getMapRef.current();
    const now = performance.now();
    effects.current = effects.current.filter((effect) => {
      const age = now - effect.bornAt;
      if (age >= FX_LIFETIME_MS || !map) {
        effect.root.remove();
        return false;
      }
      const a = map.project([effect.from.lon, effect.from.lat]);
      const b = map.project([effect.to.lon, effect.to.lat]);
      const t = age / FX_LIFETIME_MS;
      const puff = effect.root.children[0] as HTMLDivElement;
      puff.style.transform = `translate(${a.x}px, ${a.y}px)`;
      const landing = effect.root.children[3] as HTMLDivElement;
      landing.style.transform = `translate(${b.x}px, ${b.y}px)`;
      const streak = effect.root.children[1] as HTMLDivElement;
      // The streak's head follows the dash for its first half, then the tail catches up.
      // Head reaches the end in about the dash duration (200 ms of 650 ms).
      const head = Math.min(1, t * 3.25);
      const tail = Math.max(0, t * 1.5 - 0.2);
      const hx = a.x + (b.x - a.x) * head;
      const hy = a.y + (b.y - a.y) * head;
      const tx = a.x + (b.x - a.x) * tail;
      const ty = a.y + (b.y - a.y) * tail;
      const length = Math.hypot(hx - tx, hy - ty);
      const angle = Math.atan2(hy - ty, hx - tx);
      streak.style.width = `${length}px`;
      streak.style.transform = `translate(${tx}px, ${ty}px) rotate(${angle}rad)`;
      streak.style.opacity = String(Math.max(0, 1 - t * 1.1));
      const ghosts = effect.root.children[2] as HTMLDivElement;
      for (let i = 0; i < ghosts.children.length; i += 1) {
        const ghost = ghosts.children[i] as HTMLDivElement;
        // Afterimages are left behind along the path as the head passes them, then fade.
        const at = i / ghosts.children.length;
        const leftAt = at / 3.25;
        const visible = t >= leftAt;
        ghost.style.transform = `translate(${a.x + (b.x - a.x) * at}px, ${a.y + (b.y - a.y) * at}px)`;
        ghost.style.opacity = visible ? String(Math.max(0, 0.85 - (t - leftAt) * 1.6)) : "0";
      }
      return true;
    });
    raf.current = effects.current.length > 0 ? requestAnimationFrame(animate) : 0;
  };

  const spawn = (from: LatLon, to: LatLon): void => {
    const layer = layerRef.current;
    if (!layer) return;
    const root = document.createElement("div");
    root.className = "dash-fx";
    const puff = document.createElement("div");
    puff.className = "dash-fx-puff";
    for (let i = 0; i < PUFF_COUNT; i += 1) {
      const mote = document.createElement("span");
      const angle = (i / PUFF_COUNT) * Math.PI * 2 + Math.random() * 0.6;
      const reach = 14 + Math.random() * 10;
      mote.style.setProperty("--dx", `${Math.cos(angle) * reach}px`);
      mote.style.setProperty("--dy", `${Math.sin(angle) * reach * 0.6}px`);
      mote.style.animationDelay = `${Math.random() * 40}ms`;
      puff.appendChild(mote);
    }
    const streak = document.createElement("div");
    streak.className = "dash-fx-streak";
    const ghosts = document.createElement("div");
    for (let i = 0; i < GHOST_COUNT; i += 1) {
      const ghost = document.createElement("div");
      ghost.className = "dash-fx-ghost";
      ghosts.appendChild(ghost);
    }
    const landing = document.createElement("div");
    landing.className = "dash-fx-puff dash-fx-landing";
    for (let i = 0; i < 5; i += 1) {
      const mote = document.createElement("span");
      const angle = (i / 5) * Math.PI * 2 + Math.random() * 0.6;
      mote.style.setProperty("--dx", `${Math.cos(angle) * 12}px`);
      mote.style.setProperty("--dy", `${Math.sin(angle) * 7}px`);
      mote.style.animationDelay = "200ms";
      landing.appendChild(mote);
    }
    root.append(puff, streak, ghosts, landing);
    layer.appendChild(root);
    effects.current.push({ id: nextId.current++, from: { ...from }, to: { ...to }, bornAt: performance.now(), root });
    if (!raf.current) raf.current = requestAnimationFrame(animate);
  };

  // Local dash: spawned the instant it is pressed (prediction), not on the server echo.
  const localRevision = useSyncExternalStore(dashClientState.subscribe, dashClientState.getRevision);
  useEffect(() => {
    const start = dashClientState.lastStart;
    if (start && performance.now() - start.atMs < 100) spawn(start.from, start.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localRevision]);

  // Other players: one effect per new active dash seen in snapshots.
  useEffect(() => {
    const seen = seenRemote.current;
    for (const player of players) {
      const dash = player.dash;
      if (!dash?.active || player.playerId === localPlayerId) continue;
      if (seen.get(player.playerId) === dash.startedAt) continue;
      seen.set(player.playerId, dash.startedAt);
      spawn({ lat: dash.fromLat, lon: dash.fromLon }, { lat: dash.toLat, lon: dash.toLon });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, localPlayerId]);

  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    for (const effect of effects.current) effect.root.remove();
    effects.current = [];
  }, []);

  return <div ref={layerRef} className="dash-fx-layer" aria-hidden="true" />;
}
