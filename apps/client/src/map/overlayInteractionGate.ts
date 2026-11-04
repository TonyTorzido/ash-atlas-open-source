export type OverlayInteractionKind = "drag" | "move" | "zoom";

export type OverlayInteractionBeginResult =
  | "started"
  | "already-active"
  | "superseded-programmatic";
export type OverlayInteractionEndResult = "inactive" | "still-active" | "wait-for-idle";
export type OverlayInteractionIdleResult = "ended" | "none";
export type OverlayProgrammaticBeginResult = "started" | "already-active";
export type OverlayProgrammaticEndResult = "ended" | "still-active" | "inactive";

export class OverlayInteractionGate {
  private readonly activeKinds = new Set<OverlayInteractionKind>();
  private programmaticDepth = 0;
  private waitingForIdle = false;

  begin(kind: OverlayInteractionKind): OverlayInteractionBeginResult {
    if (this.programmaticDepth > 0) {
      this.programmaticDepth = 0;
      this.activeKinds.clear();
      this.waitingForIdle = false;
      this.activeKinds.add(kind);
      return "superseded-programmatic";
    }
    const wasFrozen = this.isFrozen();
    this.waitingForIdle = false;
    this.activeKinds.add(kind);
    return wasFrozen ? "already-active" : "started";
  }

  end(kind: OverlayInteractionKind): OverlayInteractionEndResult {
    if (!this.activeKinds.delete(kind)) {
      return this.isFrozen() ? "still-active" : "inactive";
    }
    if (this.activeKinds.size > 0) {
      return "still-active";
    }
    this.waitingForIdle = true;
    return "wait-for-idle";
  }

  finishIdle(): OverlayInteractionIdleResult {
    if (this.activeKinds.size > 0 || !this.waitingForIdle) {
      return "none";
    }
    this.waitingForIdle = false;
    return "ended";
  }

  beginProgrammaticCameraMove(): OverlayProgrammaticBeginResult {
    if (this.programmaticDepth > 0) {
      return "already-active";
    }
    this.activeKinds.clear();
    this.waitingForIdle = false;
    this.programmaticDepth = 1;
    return "started";
  }

  endProgrammaticCameraMove(): OverlayProgrammaticEndResult {
    if (this.programmaticDepth === 0) {
      return "inactive";
    }
    this.programmaticDepth -= 1;
    return this.programmaticDepth === 0 ? "ended" : "still-active";
  }

  isProgrammaticCameraMoveActive(): boolean {
    return this.programmaticDepth > 0;
  }

  isFrozen(): boolean {
    return this.activeKinds.size > 0 || this.waitingForIdle;
  }
}
