import { runtimePngAssetRegistrationById } from "@ash-atlas/shared";
import { Application, Assets, Container, Graphics, Text, Texture } from "pixi.js";
import { useEffect, useRef, useState } from "react";
import { runtimePngAssetUrl } from "../map/runtimePngAssetUrl.js";
import { bomberPlantPose, drawMilitaryAction, drawBomberDetonation, siegeVolleyPose } from "../map/militaryWorldAnimation.js";
import { siegeFacingTarget } from "../map/militaryTargetPresentation.js";

async function militaryTexture(id: string): Promise<Texture> {
  const registration = runtimePngAssetRegistrationById(id);
  const url = registration ? runtimePngAssetUrl(registration.relativeFile) : null;
  if (!url) return Texture.EMPTY;
  try { return await Assets.load<Texture>(url); } catch { return Texture.EMPTY; }
}

/** Inspect the production rig through one channel, including its held endpoint. */
export function MilitaryAnimationPreview(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  const [faceRight, setFaceRight] = useState(false);
  const [paused, setPaused] = useState(false);
  const [timeline, setTimeline] = useState(0);
  const controls = useRef({ reducedMotion, faceRight, paused });
  controls.current = { reducedMotion, faceRight, paused };
  const elapsedRef = useRef(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const app = new Application();
    let disposed = false;
    let ready = false;
    let destroyed = false;
    const destroy = (): void => {
      if (ready && !destroyed) {
        destroyed = true;
        app.destroy({ removeView: true }, { children: true });
      }
    };
    const run = async (): Promise<void> => {
      await app.init({ width: 440, height: 570, backgroundColor: 0x355338, antialias: true });
      ready = true;
      if (disposed) { destroy(); return; }
      app.canvas.style.width = "100%";
      app.canvas.style.height = "auto";
      app.canvas.setAttribute("aria-label", "Bomber planting at a flag and siege firing toward a target");
      host.replaceChildren(app.canvas);
      const [bomberIdle, bomberPlanting, siegeDeployed, siegeLaunch, rock, escape, blast] = await Promise.all([
        militaryTexture("military-bomber-idle"), militaryTexture("military-bomber-planting"),
        militaryTexture("military-siege-deployed"), militaryTexture("military-siege-launch"),
        militaryTexture("military-siege-rock"), militaryTexture("military-bomber-escaping"),
        militaryTexture("military-bomber-detonation")
      ]);
      if (disposed) return;
      const bomber = new Container();
      const siege = new Container();
      bomber.position.set(220, 260);
      siege.position.set(250, 540);
      bomber.scale.set(0.17);
      siege.scale.set(0.16);
      const ground = new Graphics()
        .moveTo(28, 260).lineTo(412, 260).stroke({ color: 0xa5a681, alpha: 0.45, width: 1 })
        .moveTo(28, 530).lineTo(412, 530).stroke({ color: 0xa5a681, alpha: 0.45, width: 1 });
      const flag = new Graphics().rect(0, -103, 4, 103).fill(0x48321f)
        .poly([4, -103, 35, -94, 4, -72]).fill(0xc84b2f);
      const target = new Graphics().circle(0, 0, 7).stroke({ color: 0xe1c788, width: 2 });
      const towers = new Graphics();
      const targetLabel = new Text({ text: "", style: { fill: 0xf3e6c8, fontSize: 12, fontFamily: "Georgia, serif" } });
      targetLabel.position.set(16, 316);
      app.stage.addChild(ground, flag, towers, target, targetLabel, bomber, siege);
      ["Kippen Bomber · plant, configure, escape", "Kippen Siege · load, release, recover"].forEach((label, index) => {
        const text = new Text({ text: label, style: { fill: 0xf3e6c8, fontSize: 16, fontFamily: "Georgia, serif" } });
        text.position.set(16, index === 0 ? 15 : 292);
        app.stage.addChild(text);
      });
      let previousAt = performance.now();
      let reportedAt = previousAt;
      app.ticker.add(() => {
        const now = performance.now();
        const delta = Math.min(100, now - previousAt);
        previousAt = now;
        if (!controls.current.paused) elapsedRef.current = Math.min(7500, elapsedRef.current + delta);
        const elapsed = elapsedRef.current;
        if (elapsed >= 7500 && !controls.current.paused) setPaused(true);
        if (now - reportedAt > 80) { setTimeline(Math.round(elapsed)); reportedAt = now; }
        const direction = controls.current.faceRight ? 1 : -1;
        flag.position.set(220 + direction * 112, 260);
        flag.scale.x = direction;
        siege.position.x = 220;
        const targetXs = direction < 0 ? [65, 410] : [30, 375];
        const targetFlags = targetXs.map((x, index) => ({
          id: `preview-tower-${index}`, lat: 0, lon: (x - 220) * 0.00001,
          ownerId: "enemy", controlType: "personal" as const, anchorKind: "flag" as const,
          cityId: null, kingdomId: null, systemControlled: false, burning: false,
          reinforcementLevel: 3, upgradeTier: "tower" as const, health: 2700, maximumHealth: 2700
        }));
        const facingTarget = siegeFacingTarget({
          unitType: "field_ballista", locationState: "DEPLOYED_FIELD", lat: 0, lon: 0,
          ownerPlayerId: "preview-owner", targetFlagId: targetFlags[direction < 0 ? 1 : 0]!.id
        }, targetFlags, [])!;
        const selectedX = 220 + facingTarget.lon / 0.00001;
        const siegeDirection = Math.sign(selectedX - siege.x) || -1;
        target.position.set(selectedX, 530);
        targetLabel.text = `Two attacked towers · face nearest (${siegeDirection < 0 ? "left" : "right"})`;
        towers.clear();
        targetXs.forEach((x) => {
          towers.rect(x - 11, 490, 22, 34).fill(x === selectedX ? 0xb6a582 : 0x737765)
            .rect(x - 14, 484, 28, 10).fill(0x6b6250);
        });
        bomber.removeChildren().forEach((child) => child.destroy({ children: true }));
        siege.removeChildren().forEach((child) => child.destroy({ children: true }));
        bomber.position.x = elapsed < 5000 ? 220 : 220 + direction * 76.5;
        if (elapsed < 5000) {
          drawMilitaryAction(bomber, bomberIdle, bomberPlanting, 0.5, 1, "bomber",
            bomberPlantPose(0, elapsed, controls.current.reducedMotion), direction,
            null, null, { x: -450, y: 0 }, true, controls.current.reducedMotion,
            controls.current.reducedMotion ? 0 : Math.max(0, elapsed - 1400));
        } else {
          // The gallery explicitly simulates the successful server cue at five seconds.
          drawBomberDetonation(bomber, escape, blast, elapsed - 5000, -direction, controls.current.reducedMotion);
        }
        const volleyElapsed = Math.max(0, elapsed - 1500);
        const pose = siegeVolleyPose(0, volleyElapsed, controls.current.reducedMotion);
        drawMilitaryAction(siege, siegeDeployed,
          controls.current.reducedMotion && (elapsed < 1500 || elapsed >= 2500) ? siegeDeployed : siegeLaunch,
          0.5, 1, "siege", pose.launch,
          siegeDirection, pose.rockFlight, rock,
          { x: -Math.abs(selectedX - siege.x) / siege.scale.x, y: -62.5 }, pose.loaded, controls.current.reducedMotion);
      });
    };
    void run().catch(() => { destroy(); });
    return () => { disposed = true; destroy(); };
  }, []);

  return <div>
    <div role="group" aria-label="Military animation preview options" style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
      <button type="button" className="game-app-button" onClick={() => { if (paused && elapsedRef.current >= 7500) elapsedRef.current = 0; setPaused(!paused); }}>{paused ? "Play" : "Pause"}</button>
      <button type="button" className="game-app-button" onClick={() => { elapsedRef.current = 0; setTimeline(0); setPaused(false); }}>Replay</button>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 7, minHeight: 44 }}>
        <input type="checkbox" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} />
        <span>Reduced motion</span>
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 7, minHeight: 44 }}>
        <input type="checkbox" checked={faceRight} onChange={(event) => setFaceRight(event.target.checked)} />
        <span>Reverse facing</span>
      </label>
    </div>
    <label style={{ display: "grid", gap: 4, marginBottom: 12 }}>
      <span>{timeline < 1400 ? "Lowering bomb" : timeline < 5000 ? "Configuring planted bomb" : "Simulated confirmed detonation · escape"}</span>
      <span>Inspect frame · {(timeline / 1000).toFixed(2)} s of 7.5 s</span>
      <input aria-label="Military animation time" type="range" min={0} max={7500} step={10} value={timeline}
        style={{ width: "100%", minHeight: 44 }}
        onChange={(event) => { const value = Number(event.target.value); elapsedRef.current = value; setTimeline(value); setPaused(true); }} />
    </label>
    <div ref={hostRef} style={{ maxWidth: 440, width: "100%" }} />
  </div>;
}
