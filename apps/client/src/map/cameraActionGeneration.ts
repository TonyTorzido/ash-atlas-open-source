export class CameraActionGeneration {
  private generation = 0;
  private activeGeneration: number | null = null;

  begin(): number {
    this.activeGeneration = ++this.generation;
    return this.activeGeneration;
  }

  supersede(): void {
    this.generation += 1;
    this.activeGeneration = null;
  }

  complete(generation: number): boolean {
    if (this.activeGeneration !== generation) {
      return false;
    }
    this.activeGeneration = null;
    return true;
  }
}
