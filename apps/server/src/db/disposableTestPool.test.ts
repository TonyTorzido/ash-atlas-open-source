import { setImmediate } from "node:timers/promises";

import pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { DisposableTestPool } from "./disposableTestPool.js";

// Exercise the real pg-pool lifecycle with a client whose close completion is
// controlled by the test. No sockets, PostgreSQL, clock delays, or private pool fields.
class DelayedClient extends pg.Client {
  private readonly closeCallbacks: Array<() => void> = [];

  override connect(): Promise<pg.Client>;
  override connect(callback: ((error: Error) => void) | ((error: null, client: pg.Client) => void)): void;
  override connect(callback?: ((error: Error) => void) | ((error: null, client: pg.Client) => void)): Promise<pg.Client> | void {
    if (callback) {
      (callback as (error: null, client: pg.Client) => void)(null, this);
      return;
    }
    return Promise.resolve(this);
  }

  override end(): Promise<void>;
  override end(callback: (error: Error) => void): void;
  override end(callback?: (error: Error) => void): Promise<void> | void {
    if (callback) {
      this.closeCallbacks.push(callback as () => void);
      return;
    }
    return new Promise<void>((resolve) => this.closeCallbacks.push(resolve));
  }

  finishClose(): void {
    expect(this.closeCallbacks.length).toBeGreaterThan(0);
    for (const callback of this.closeCallbacks.splice(0)) callback();
    this.emit("end");
  }
}

function createPool(): DisposableTestPool {
  return new DisposableTestPool({ Client: DelayedClient, idleTimeoutMillis: 0 });
}

function finishClose(client: pg.PoolClient): void {
  expect(client).toBeInstanceOf(DelayedClient);
  (client as unknown as DelayedClient).finishClose();
}

describe("disposable fixture pool shutdown", () => {
  it("waits for every idle connection to close", async () => {
    const pool = createPool();
    const first = await pool.connect();
    const second = await pool.connect();
    first.release();
    second.release();

    const completed = vi.fn();
    const ending = pool.end().then(completed);
    // Flush promise continuations at the next event-loop turn, without a delay.
    await setImmediate();
    expect(pool.totalCount).toBe(0);
    expect(completed).not.toHaveBeenCalled();
    finishClose(first);
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    finishClose(second);
    await ending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("waits for a checked-out client released during shutdown", async () => {
    const pool = createPool();
    const client = await pool.connect();
    const completed = vi.fn();
    const ending = pool.end().then(completed);
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    client.release();
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    finishClose(client);
    await ending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("includes a connection already removed before shutdown starts", async () => {
    const pool = createPool();
    const client = await pool.connect();
    client.release(true);
    expect(pool.totalCount).toBe(0);
    const completed = vi.fn();
    const ending = pool.end().then(completed);
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    finishClose(client);
    await ending;
    expect(completed).toHaveBeenCalledOnce();
  });

  it("waits for closure in the callback API and preserves lifecycle errors", async () => {
    const pool = createPool();
    const client = await pool.connect();
    client.release();
    const completed = vi.fn();
    const ending = new Promise<void>((resolve) => {
      expect(pool.end((error) => {
        completed(error);
        resolve();
      })).toBeUndefined();
    });
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    finishClose(client);
    await ending;
    expect(completed).toHaveBeenCalledExactlyOnceWith(undefined);
    await expect(pool.end()).rejects.toThrow("Called end on pool more than once");
    const errorCallback = vi.fn();
    pool.end(errorCallback);
    expect(errorCallback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Called end on pool more than once" })
    );
    await expect(pool.connect()).rejects.toThrow("Cannot use a pool after calling end on the pool");
  });

  it("leaves idle-client errors unhandled rather than suppressing them", async () => {
    const pool = createPool();
    const client = await pool.connect();
    client.release();
    const failure = new Error("unexpected idle failure");
    expect(pool.listenerCount("error")).toBe(0);
    expect(() => client.emit("error", failure)).toThrow(failure);
    const ending = pool.end();
    finishClose(client);
    await ending;
  });
});
