import {
  UNIVERSAL_TAUNT_PULSE_DURATION_MS,
  type CombatEvent,
  type LatLon
} from "@ash-atlas/shared";

export type TauntPulsePresentation = {
  eventId: string;
  position: LatLon;
  radiusM: number;
  progress: number;
  opacity: number;
};

type ActiveTauntPulse = {
  eventId: string;
  position: LatLon;
  radiusM: number;
  startedAtMs: number;
};

export class TauntPulseState {
  private active: ActiveTauntPulse | null = null;

  enqueue(events: readonly CombatEvent[], localPlayerId: string, nowMs: number): void {
    for (const event of events) {
      if (
        event.type !== "TAUNT_ACTIVATED" ||
        event.sourceEntityId !== localPlayerId ||
        !event.position ||
        event.radiusM === undefined
      ) continue;
      this.active = {
        eventId: event.eventId,
        position: { ...event.position },
        radiusM: event.radiusM,
        startedAtMs: nowMs
      };
    }
  }

  presentation(nowMs: number): TauntPulsePresentation | null {
    if (!this.active) return null;
    const progress = Math.max(0, (nowMs - this.active.startedAtMs) / UNIVERSAL_TAUNT_PULSE_DURATION_MS);
    if (progress >= 1) {
      this.active = null;
      return null;
    }
    return {
      eventId: this.active.eventId,
      position: { ...this.active.position },
      radiusM: this.active.radiusM,
      progress,
      opacity: 1 - progress
    };
  }

  clear(): void {
    this.active = null;
  }
}
