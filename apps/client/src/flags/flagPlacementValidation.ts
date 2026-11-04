export const FLAG_PLACEMENT_VALIDATION_TIMEOUT_MS = 12_000;

export type FlagPlacementValidation = {
  requestId: string;
  sentAt: number;
};

export type FlagPlacementSubmissionResult =
  | { status: "sent"; validation: FlagPlacementValidation }
  | { status: "duplicate"; validation: FlagPlacementValidation }
  | { status: "disconnected" };

export class FlagPlacementValidationGate {
  private validation: FlagPlacementValidation | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: (validation: FlagPlacementValidation | null) => void,
    private readonly onTimeout: () => void,
    private readonly now: () => number = Date.now
  ) {}

  begin(send: () => string | null): FlagPlacementSubmissionResult {
    if (this.validation) return { status: "duplicate", validation: this.validation };

    // The WebSocket send deliberately happens before any UI state transition.
    const requestId = send();
    if (!requestId) return { status: "disconnected" };

    const validation = { requestId, sentAt: this.now() };
    this.validation = validation;
    this.onChange(validation);
    this.timeout = globalThis.setTimeout(() => {
      if (this.validation?.requestId !== requestId) return;
      this.validation = null;
      this.timeout = null;
      this.onChange(null);
      this.onTimeout();
    }, FLAG_PLACEMENT_VALIDATION_TIMEOUT_MS);
    return { status: "sent", validation };
  }

  complete(requestId?: string): boolean {
    if (!this.validation || (requestId && requestId !== this.validation.requestId)) return false;
    this.clear();
    return true;
  }

  clear(): void {
    if (this.timeout !== null) globalThis.clearTimeout(this.timeout);
    this.timeout = null;
    if (!this.validation) return;
    this.validation = null;
    this.onChange(null);
  }

  destroy(): void {
    if (this.timeout !== null) globalThis.clearTimeout(this.timeout);
    this.timeout = null;
    this.validation = null;
  }

  pending(): FlagPlacementValidation | null {
    return this.validation;
  }
}
