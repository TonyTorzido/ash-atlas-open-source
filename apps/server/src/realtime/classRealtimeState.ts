import { ClassRequestError } from "../game/classes/classService.js";
import { isDeveloperEconomyMode } from "../auth/developerAuthorization.js";
import type { AppConfig } from "../config.js";

export class ClassRealtimeState {
  private readonly rateWindowsByPlayer = new Map<string, Map<string, number[]>>();
  private readonly activeMutations = new Map<string, symbol>();

  enforceRate(
    playerId: string,
    key: string,
    maximum: number,
    windowMs: number,
    exempt = false,
    now = Date.now()
  ): void {
    if (exempt) return;
    const windows = this.windowsForPlayer(playerId);
    const retained = (windows.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
    if (retained.length >= maximum) {
      throw new ClassRequestError("CLASS_RATE_LIMITED", "Too many class requests; try again shortly");
    }
    retained.push(now);
    windows.set(key, retained);
  }

  hasActiveMutation(playerId: string): boolean {
    return this.activeMutations.has(playerId);
  }

  beginMutation(playerId: string): symbol {
    if (this.activeMutations.has(playerId)) {
      throw new ClassRequestError(
        "CLASS_MUTATION_PENDING",
        "Another class mutation is still pending"
      );
    }
    const token = Symbol(playerId);
    this.activeMutations.set(playerId, token);
    return token;
  }

  endMutation(playerId: string, token: symbol): void {
    if (this.activeMutations.get(playerId) === token) {
      this.activeMutations.delete(playerId);
    }
  }

  clearPlayer(playerId: string): void {
    this.rateWindowsByPlayer.delete(playerId);
    this.activeMutations.delete(playerId);
  }

  private windowsForPlayer(playerId: string): Map<string, number[]> {
    const existing = this.rateWindowsByPlayer.get(playerId);
    if (existing) return existing;
    if (this.rateWindowsByPlayer.size >= 10_000) {
      const oldest = this.rateWindowsByPlayer.keys().next().value as string | undefined;
      if (oldest) this.rateWindowsByPlayer.delete(oldest);
    }
    const created = new Map<string, number[]>();
    this.rateWindowsByPlayer.set(playerId, created);
    return created;
  }
}

export function isDeveloperClassRateExempt(
  config: AppConfig | undefined,
  authorizedDeveloper: boolean
): boolean {
  return Boolean(
    config &&
    config.DEV_TOOLS_ENABLED &&
    authorizedDeveloper &&
    isDeveloperEconomyMode(config)
  );
}

export function enforceClassRate(
  windows: Map<string, number[]>,
  key: string,
  maximum: number,
  windowMs: number,
  exempt = false
): void {
  if (exempt) return;
  const now = Date.now();
  const retained = (windows.get(key) ?? []).filter((timestamp) => now - timestamp < windowMs);
  if (retained.length >= maximum) {
    throw new ClassRequestError("CLASS_RATE_LIMITED", "Too many class requests; try again shortly");
  }
  retained.push(now);
  windows.set(key, retained);
}
