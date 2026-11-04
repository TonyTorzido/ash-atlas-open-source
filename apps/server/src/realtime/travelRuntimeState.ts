export type TrackedTravelTransition = {
  playerId: string;
  requestId: string;
  connectionId: string | null;
  connectionGeneration: number;
  relocationRevision: number;
  startedAtMs: number;
  phase:
    | "started"
    | "phase-one-running"
    | "committed"
    | "waiting-visible-population";
  committed: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
};

export class TravelRuntimeState {
  private readonly populationGenerationByPlayer = new Map<string, number>();
  private readonly transitions = new Map<symbol, TrackedTravelTransition>();

  nextPopulationGeneration(playerId: string): number {
    const generation = (this.populationGenerationByPlayer.get(playerId) ?? 0) + 1;
    this.populationGenerationByPlayer.set(playerId, generation);
    return generation;
  }

  isPopulationGenerationCurrent(playerId: string, generation: number): boolean {
    return this.populationGenerationByPlayer.get(playerId) === generation;
  }

  clearPopulationGeneration(playerId: string): void {
    this.populationGenerationByPlayer.delete(playerId);
  }

  trackTransition(token: symbol, transition: TrackedTravelTransition): void {
    this.transitions.set(token, transition);
  }

  transition(token: symbol): TrackedTravelTransition | null {
    return this.transitions.get(token) ?? null;
  }

  releaseTransition(token: symbol): TrackedTravelTransition | null {
    const transition = this.transitions.get(token) ?? null;
    if (transition?.watchdog) clearTimeout(transition.watchdog);
    this.transitions.delete(token);
    return transition;
  }

  transitionsForPlayer(playerId: string): readonly Readonly<{
    token: symbol;
    transition: TrackedTravelTransition;
  }>[] {
    return [...this.transitions]
      .filter(([, transition]) => transition.playerId === playerId)
      .map(([token, transition]) => ({ token, transition }));
  }

  trackedTransitions(): readonly Readonly<{
    token: symbol;
    transition: TrackedTravelTransition;
  }>[] {
    return [...this.transitions].map(([token, transition]) => ({ token, transition }));
  }
}
