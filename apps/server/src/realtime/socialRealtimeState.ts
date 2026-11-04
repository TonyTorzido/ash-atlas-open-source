export class SocialRealtimeState {
  private readonly bootstrapReadyConnections = new Set<string>();
  private readonly bootstrapFlights = new Map<string, Promise<void>>();

  isBootstrapReady(connectionId: string): boolean {
    return this.bootstrapReadyConnections.has(connectionId);
  }

  bootstrapFlight(connectionId: string): Promise<void> | null {
    return this.bootstrapFlights.get(connectionId) ?? null;
  }

  beginBootstrap(connectionId: string, flight: Promise<void>): void {
    this.bootstrapFlights.set(connectionId, flight);
  }

  finishBootstrap(connectionId: string, flight: Promise<void>, ready: boolean): void {
    if (ready) this.bootstrapReadyConnections.add(connectionId);
    if (this.bootstrapFlights.get(connectionId) === flight) {
      this.bootstrapFlights.delete(connectionId);
    }
  }

  clearConnection(connectionId: string): void {
    this.bootstrapReadyConnections.delete(connectionId);
    this.bootstrapFlights.delete(connectionId);
  }
}
