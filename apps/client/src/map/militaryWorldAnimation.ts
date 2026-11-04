import { Container, Graphics, MeshPlane, Sprite, Texture } from "pixi.js";
import { MILITARY_SIEGE_LAUNCH_DURATION_MS } from "./militaryWorldPresentation.js";

export const SIEGE_ACTION_MS = MILITARY_SIEGE_LAUNCH_DURATION_MS;
export const BOMBER_ESCAPE_MS = 2_400;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const smooth = (value: number): number => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

/** One placement per authoritative channel; keep working at the planted bomb afterward. */
export function bomberPlantPose(startedAt: number, now: number, reducedMotion: boolean): number {
  return reducedMotion ? 1 : smooth((now - startedAt - 350) / 1050);
}

export type SiegePose = Readonly<{ launch: number; rockFlight: number | null; recoil: number; loaded: boolean }>;
export function siegeVolleyPose(occurredAt: number, now: number, reducedMotion: boolean): SiegePose {
  const t = clamp01((now - occurredAt) / SIEGE_ACTION_MS);
  if (reducedMotion) return { launch: 1, rockFlight: null, recoil: 0, loaded: false };
  return {
    launch: t < 0.3 ? smooth(t / 0.3) : t < 0.58 ? 1 : 1 - smooth((t - 0.58) / 0.42),
    // Constant horizontal speed avoids the projectile stopping in mid-air at each end.
    rockFlight: t >= 0.3 && t < 0.95 ? (t - 0.3) / 0.65 : null,
    recoil: 0,
    loaded: t < 0.3 || t >= 1
  };
}

/** One production rig, shared with the frame-inspection preview. Coordinates follow the authored PNG. */
export function drawMilitaryAction(
  root: Container,
  idleTexture: Texture,
  actionTexture: Texture,
  anchorX: number,
  anchorY: number,
  kind: "bomber" | "siege",
  amount: number,
  direction: number,
  rockFlight: number | null = null,
  rockTexture: Texture | null = null,
  rockTarget: Readonly<{ x: number; y: number }> | null = null,
  loaded = rockFlight === null,
  stationary = false,
  bomberWorkMs = 0
): void {
  const width = idleTexture.width;
  const height = idleTexture.height;
  const art = new Container();
  art.scale.x = direction > 0 ? -1 : 1;
  root.addChild(art);

  if (kind === "bomber") {
    // Lower the intact painting with a small rigid pivot about the boots. Stretching
    // its torso against fixed foot vertices distorted the clothing and anatomy.
    const body = new MeshPlane({ texture: actionTexture, verticesX: 33, verticesY: 33 });
    const geometry = body.geometry;
    body.once("destroyed", () => geometry.destroy());
    const positions = geometry.positions;
    const lift = 1 - amount;
    for (let i = 0; i < positions.length; i += 2) {
      const x = positions[i]! / actionTexture.width;
      const y = positions[i + 1]! / actionTexture.height;
      if (amount === 1 && bomberWorkMs > 0) {
        // Local sleeve/glove weights stop before the box, boots, face and torso.
        // Alternate the hands as though tightening the fuse; the bomb never jitters.
        const left = Math.max(0, 1 - ((x - 0.286) / 0.073) ** 2 - ((y - 0.625) / 0.105) ** 2) ** 2
          * (1 - smooth((y - 0.64) / 0.025));
        const right = Math.max(0, 1 - ((x - 0.505) / 0.095) ** 2 - ((y - 0.683) / 0.14) ** 2) ** 2
          * smooth((x - 0.418) / 0.025);
        const phase = bomberWorkMs / 145;
        positions[i] = positions[i]! + (Math.sin(phase) * left - Math.sin(phase + 0.8) * right) * actionTexture.width * 0.012;
        positions[i + 1] = positions[i + 1]! - (Math.sin(phase) * left + Math.sin(phase + Math.PI) * right) * actionTexture.height * 0.01;
      }
    }
    body.geometry.getBuffer("aPosition").update();
    // The bomb's painted ground contact is the target; move the complete figure,
    // never pull the bomb away from its hands to reach a flag.
    const footX = actionTexture.width * 0.71;
    const footY = actionTexture.height * 0.84;
    body.pivot.set(footX, footY);
    body.rotation = lift * 0.2;
    body.position.set(
      footX + (rockTarget ? rockTarget.x - actionTexture.width * 0.33 : -actionTexture.width * anchorX),
      footY + (rockTarget ? rockTarget.y - actionTexture.height * 0.91 : -actionTexture.height * anchorY)
    );
    art.addChild(body);
    return;
  }

  if (stationary) {
    const sprite = new Sprite(actionTexture);
    sprite.anchor.set(anchorX, anchorY);
    art.addChild(sprite);
    return;
  }

  const rig = new Container();
  rig.position.set(-width * anchorX, -height * anchorY);
  rig.scale.set(width / 1280, height / 1280);
  art.addChild(rig);
  const piece = (points: number[], parent: Container = rig): Container => {
    const layer = new Container();
    const sprite = new Sprite(idleTexture);
    sprite.width = 1280;
    sprite.height = 1280;
    const mask = new Graphics().poly(points).fill(0xffffff);
    sprite.mask = mask;
    layer.addChild(sprite, mask);
    parent.addChild(layer);
    return layer;
  };
  const pivot = { x: 720, y: 510 };
  const angle = amount * 1.18;
  const rotate = (x: number, y: number, theta = angle): { x: number; y: number } => ({
    x: pivot.x + (x - pivot.x) * Math.cos(theta) - (y - pivot.y) * Math.sin(theta),
    y: pivot.y + (x - pivot.x) * Math.sin(theta) + (y - pivot.y) * Math.cos(theta)
  });

  // Stationary chassis from the same drawing as the arm: no perspective jump,
  // no sliding wheels, and no second painted throwing beam beneath the rig.
  piece([470, 906, 530, 864, 580, 708, 650, 510, 655, 475, 710, 444,
    748, 451, 817, 457, 857, 513, 855, 563, 946, 766, 1023, 761,
    1117, 838, 1140, 1210, 461, 1220, 445, 1073]);

  // Counterweight hangs vertically from the moving short end, rather than
  // rotating as a rigid lump welded to the beam.
  const weightJoint = rotate(965, 112);
  const weight = piece([916, 145, 962, 144, 1060, 319, 1119, 340,
    1119, 499, 1076, 548, 974, 579, 827, 515, 824, 369, 872, 328]);
  weight.position.set(weightJoint.x - 965, weightJoint.y - 112);

  const arm = piece([329, 706, 943, 49, 979, 28, 1018, 47,
    1035, 90, 1000, 163, 411, 767, 347, 758]);
  arm.pivot.set(pivot.x, pivot.y);
  arm.position.set(pivot.x, pivot.y);
  arm.rotation = angle;

  const slingTop = rotate(375, 738);
  // At release the sling extends with the throw; the empty sling then hangs.
  const slingAngle = -amount * 0.72;
  const slingLength = 244;
  const slingEnd = { x: slingTop.x + Math.sin(slingAngle) * slingLength,
    y: slingTop.y + Math.cos(slingAngle) * slingLength };
  const sling = new Graphics()
    .moveTo(slingTop.x - 17, slingTop.y).lineTo(slingEnd.x - 48, slingEnd.y)
    .quadraticCurveTo(slingEnd.x, slingEnd.y + 66, slingEnd.x + 48, slingEnd.y)
    .lineTo(slingTop.x + 17, slingTop.y)
    .stroke({ color: 0x201b24, width: 31, cap: "round", join: "round" })
    .moveTo(slingTop.x - 17, slingTop.y).lineTo(slingEnd.x - 48, slingEnd.y)
    .quadraticCurveTo(slingEnd.x, slingEnd.y + 66, slingEnd.x + 48, slingEnd.y)
    .lineTo(slingTop.x + 17, slingTop.y)
    .stroke({ color: 0xe9bb72, width: 20, cap: "round", join: "round" });
  rig.addChild(sling);
  const addRock = (x: number, y: number): void => {
    if (rockTexture && rockTexture !== Texture.EMPTY) {
      const rock = new Sprite(rockTexture);
      rock.anchor.set(0.5);
      rock.width = 110;
      rock.height = 110;
      rock.position.set(x, y);
      rig.addChild(rock);
    } else {
      // The independently editable military-siege-rock slot may not have bytes yet.
      // A complete faceted stone remains coherent both in the sling and in flight.
      const rock = new Graphics()
        .poly([-49, -24, -20, -53, 28, -48, 52, -13, 43, 31, 8, 51, -36, 36])
        .fill(0x676978).stroke({ color: 0x24232c, width: 9, join: "round" })
        .poly([-43, -21, -18, -44, 25, -40, 12, -6, -19, 10]).fill(0x90929e);
      rock.position.set(x, y);
      rig.addChild(rock);
    }
  };
  if (loaded) addRock(slingEnd.x, slingEnd.y - 18);

  // Reuse the whole crew silhouette, including its glove; do not swap crew poses.
  piece([98, 1091, 158, 1043, 197, 1020, 133, 980, 140, 947,
    185, 899, 233, 884, 286, 901, 322, 947, 330, 965,
    351, 966, 361, 985, 347, 1014, 307, 1053, 335, 1108,
    313, 1137, 325, 1164, 303, 1181, 260, 1171, 230, 1163,
    220, 1196, 182, 1195, 165, 1174, 147, 1178, 118, 1155]);
  // The front axle cap occludes the arm's pivot throughout the rotation.
  piece([654, 486, 670, 464, 700, 456, 740, 468, 752, 500,
    742, 545, 706, 558, 655, 538]);

  if (rockFlight !== null) {
    const releaseTop = rotate(375, 738, 1.18);
    const startX = releaseTop.x + Math.sin(-0.72) * slingLength;
    const startY = releaseTop.y + Math.cos(-0.72) * slingLength - 18;
    const endX = rockTarget ? rockTarget.x * 1280 / width + anchorX * 1280 : startX - 750;
    const endY = rockTarget ? rockTarget.y * 1280 / height + anchorY * 1280 : 1140;
    addRock(startX + (endX - startX) * rockFlight,
      startY + (endY - startY) * rockFlight - 4 * rockFlight * (1 - rockFlight) * 280);
  }
}

/** A confirmed, presentation-only aftermath: the consumed unit is never restored. */
export function drawBomberDetonation(
  root: Container, escapeTexture: Texture, blastTexture: Texture,
  elapsed: number, direction: number, reducedMotion: boolean
): void {
  if (elapsed < 0 || elapsed >= BOMBER_ESCAPE_MS) return;
  const size = 1280;
  const blast = clamp01(elapsed / 550);
  if (blast < 1) {
    if (blastTexture !== Texture.EMPTY) {
      const sprite = new Sprite(blastTexture);
      sprite.anchor.set(0.5, 0.65);
      sprite.width = sprite.height = size * 0.65;
      sprite.alpha = 1 - blast;
      root.addChild(sprite);
    } else {
      // Safe fallback for the independently editable military-bomber-detonation PNG.
      const burst = new Graphics();
      const radius = reducedMotion ? 130 : 70 + blast * 240;
      burst.circle(0, -70, radius).fill({ color: 0xeaa24e, alpha: (1 - blast) * 0.55 });
      burst.circle(0, -70, radius * 0.58).fill({ color: 0xffe6ad, alpha: (1 - blast) * 0.8 });
      root.addChild(burst);
    }
  }
  if (escapeTexture === Texture.EMPTY) return;
  const t = clamp01((elapsed - 100) / (BOMBER_ESCAPE_MS - 100));
  const runner = new Container();
  runner.position.set(direction * size * (0.2 + (reducedMotion ? 0 : t * 0.88)), 0);
  runner.scale.x = direction > 0 ? -1 : 1;
  runner.alpha = 1 - smooth((t - 0.62) / 0.38);
  const body = new MeshPlane({ texture: escapeTexture, verticesX: 17, verticesY: 21 });
  const geometry = body.geometry;
  body.once("destroyed", () => geometry.destroy());
  const positions = geometry.positions;
  const stride = reducedMotion ? 0 : Math.sin(elapsed / 74);
  for (let i = 0; i < positions.length; i += 2) {
    const x = positions[i]! / escapeTexture.width;
    const y = positions[i + 1]! / escapeTexture.height;
    const leg = smooth((y - 0.71) / 0.18);
    const side = x < 0.49 ? 1 : -1;
    positions[i] = positions[i]! + stride * side * leg * escapeTexture.width * 0.042;
    positions[i + 1] = positions[i + 1]! - Math.max(0, stride * side) * leg * escapeTexture.height * 0.032;
  }
  geometry.getBuffer("aPosition").update();
  body.scale.set(size / escapeTexture.height);
  body.position.set(-size * 0.5, -size * 0.92 - (reducedMotion ? 0 : Math.abs(stride) * 9));
  runner.addChild(body);
  root.addChild(runner);
}
