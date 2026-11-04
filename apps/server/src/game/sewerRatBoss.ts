import type { BossController } from "./bossFramework.js";

export const SEWER_RAT_MINIBOSS_PHASES = ["normal", "steam", "rest"] as const;
export type SewerRatMinibossPhase = (typeof SEWER_RAT_MINIBOSS_PHASES)[number];

// Short, readable windows keep the first dungeon boss legible without turning
// the encounter into a scripted cutscene.
export const SEWER_RAT_MINIBOSS_PHASE_DURATION_MS: Readonly<
  Record<SewerRatMinibossPhase, number>
> = Object.freeze({ normal: 8_000, steam: 4_000, rest: 3_000 });

export const SEWER_RAT_MINIBOSS_MOVEMENT_SPEED_MULTIPLIERS: Readonly<
  Record<SewerRatMinibossPhase, number>
> = Object.freeze({ normal: 0.8, steam: 0.95, rest: 0 });

export const SEWER_RAT_MINIBOSS_DAMAGE_MULTIPLIERS: Readonly<
  Record<SewerRatMinibossPhase, Readonly<{ outgoing: number; incoming: number }>>
> = Object.freeze({
  normal: Object.freeze({ outgoing: 1, incoming: 1 }),
  steam: Object.freeze({ outgoing: 2, incoming: 1 }),
  rest: Object.freeze({ outgoing: 0, incoming: 3 })
});

export const sewerRatMinibossPhaseLabel = (phase: string | null): string => {
  switch (phase) {
    case "steam": return "Steam / Enraged";
    case "rest": return "Rest / Vulnerable";
    case "normal": return "Normal";
    default: return phase ?? "Preparing";
  }
};

function nextPhase(phase: SewerRatMinibossPhase): SewerRatMinibossPhase {
  return phase === "normal" ? "steam" : phase === "steam" ? "rest" : "normal";
}

/**
 * Shared BossDefinition/controller seam for the sewer rat miniboss. Phase
 * deadlines and modifiers live on the server encounter; clients only receive
 * the resulting phase projection and telegraph state.
 */
export function createSewerRatMinibossController(
  playerBaseSpeedMps = 125
): BossController {
  let phaseDeadlineAt: number | null = null;

  const applyPhase = (
    context: Parameters<NonNullable<BossController["onPhaseTransition"]>>[0],
    phase: SewerRatMinibossPhase
  ): void => {
    const duration = SEWER_RAT_MINIBOSS_PHASE_DURATION_MS[phase];
    phaseDeadlineAt = context.now + duration;
    const multipliers = SEWER_RAT_MINIBOSS_DAMAGE_MULTIPLIERS[phase];
    context.encounter.setPhaseDeadline(phaseDeadlineAt);
    context.encounter.setMovementOverride({
      id: `sewer-rat-miniboss-${phase}`,
      generation: context.lifeGeneration,
      endsAt: phaseDeadlineAt,
      movementSpeedMps: playerBaseSpeedMps *
        SEWER_RAT_MINIBOSS_MOVEMENT_SPEED_MULTIPLIERS[phase],
      outgoingDamageMultiplier: multipliers.outgoing,
      incomingDamageMultiplier: multipliers.incoming
    });
  };

  return {
    onActivate: (context) => {
      const phase = context.encounter.phase;
      if (phase === null) {
        context.encounter.transitionPhase("normal");
      } else if ((SEWER_RAT_MINIBOSS_PHASES as readonly string[]).includes(phase)) {
        applyPhase(context, phase as SewerRatMinibossPhase);
      }
    },
    onPhaseTransition: (context) => {
      const phase = context.encounter.phase;
      if ((SEWER_RAT_MINIBOSS_PHASES as readonly string[]).includes(phase ?? "")) {
        applyPhase(context, phase as SewerRatMinibossPhase);
      }
    },
    update: (context) => {
      const phase = context.encounter.phase;
      if (!phase || !(SEWER_RAT_MINIBOSS_PHASES as readonly string[]).includes(phase)) {
        context.encounter.transitionPhase("normal");
        return;
      }
      if (phaseDeadlineAt === null) {
        applyPhase(context, phase as SewerRatMinibossPhase);
        return;
      }
      if (context.now >= phaseDeadlineAt) {
        context.encounter.transitionPhase(nextPhase(phase as SewerRatMinibossPhase));
      }
    },
    onReset: (context) => {
      phaseDeadlineAt = null;
      context.encounter.setPhaseDeadline(null);
      context.encounter.setMovementOverride(null);
    },
    onDefeat: (context) => {
      phaseDeadlineAt = null;
      context.encounter.setPhaseDeadline(null);
      context.encounter.setMovementOverride(null);
    },
    destroy: (context) => {
      phaseDeadlineAt = null;
      context.encounter.setPhaseDeadline(null);
      context.encounter.setMovementOverride(null);
    }
  };
}
