/** Maps the sandbox's authoritative clock into the renderer's clock domain. */
export class PlaytestPresentationClock {
  private serverTime = 0;
  private receivedAt = 0;
  private rate = 0;
  sync(serverTime: number, speed: number, paused: boolean, receivedAt: number): void {
    this.serverTime = serverTime;
    this.receivedAt = receivedAt;
    this.rate = paused ? 0 : speed;
  }
  now(realNow: number): number {
    // Bound extrapolation exactly like transport: stalled tabs never catch up invisibly.
    return this.serverTime + Math.max(0, Math.min(250, realNow - this.receivedAt)) * this.rate;
  }
}
