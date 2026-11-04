import pg from "pg";

/** Fixture pool whose end() waits for connections before their database is dropped. */
export class DisposableTestPool extends pg.Pool {
  private readonly clientClosures = new Set<Promise<void>>();

  constructor(configuration?: pg.PoolConfig) {
    super(configuration);
    this.on("connect", (client) => {
      const closed = new Promise<void>((resolve) => {
        client.once("end", () => {
          this.clientClosures.delete(closed);
          resolve();
        });
      });
      this.clientClosures.add(closed);
    });
  }

  override end(): Promise<void>;
  override end(callback: (error?: Error) => void): void;
  override end(callback?: (error?: Error) => void): Promise<void> | void {
    // pg-pool removes clients from its counts before their close callbacks finish.
    // Track from connection creation so removals started before end() are covered.
    if (callback) {
      return super.end((error?: Error) => {
        if (error) {
          callback(error);
          return;
        }
        void Promise.all(this.clientClosures).then(() => callback());
      });
    }
    return super.end().then(async () => {
      await Promise.all(this.clientClosures);
    });
  }
}
