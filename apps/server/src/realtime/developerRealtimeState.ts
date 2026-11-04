import type { ServerMessage } from "@ash-atlas/shared";

type CompletedTeleport = Extract<ServerMessage, { type: "DEV_TELEPORT_COMPLETED" }>;

export class DeveloperRealtimeState {
  private readonly activeTeleports = new Set<string>();
  private readonly completedTeleports = new Map<string, CompletedTeleport>();

  replay(key: string): CompletedTeleport | null {
    return this.completedTeleports.get(key) ?? null;
  }

  isActive(key: string): boolean {
    return this.activeTeleports.has(key);
  }

  begin(key: string): boolean {
    if (this.activeTeleports.has(key)) return false;
    this.activeTeleports.add(key);
    return true;
  }

  finish(key: string): void {
    this.activeTeleports.delete(key);
  }

  complete(key: string, completion: CompletedTeleport): void {
    this.completedTeleports.set(key, completion);
    if (this.completedTeleports.size > 2_048) {
      const oldest = this.completedTeleports.keys().next().value as string | undefined;
      if (oldest) this.completedTeleports.delete(oldest);
    }
  }
}
