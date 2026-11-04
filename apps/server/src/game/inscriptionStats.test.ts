import type pg from "pg";
import { describe, expect, it } from "vitest";

import { InscriptionStatsRecorder } from "./inscriptionStats.js";

describe("InscriptionStatsRecorder.flush", () => {
  it("keeps every unwritten item when a write fails partway, merged with newer counts", async () => {
    const written: string[] = [];
    let calls = 0;
    let recorder: InscriptionStatsRecorder;
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        calls += 1;
        const id = params[0] as string;
        if (calls === 2) {
          // A kill recorded while the flush is running.
          recorder.add("c", "kills", 5);
          throw new Error("connection lost");
        }
        written.push(id);
        return { rows: [], rowCount: 1 };
      }
    } as unknown as pg.Pool;
    recorder = new InscriptionStatsRecorder(pool);
    recorder.add("a", "kills", 1);
    recorder.add("b", "kills", 2);
    recorder.max("b", "highestDamageTaken", 40);
    recorder.add("c", "kills", 3);

    await expect(recorder.flush()).rejects.toThrow("connection lost");
    // "a" was written; "b" failed; "c" was still tried after the failure.
    expect(written).toEqual(["a", "c"]);
    expect(recorder.pendingCount()).toBe(2);

    const payloads = new Map<string, Record<string, number>>();
    const retryPool = {
      query: async (_sql: string, params: unknown[]) => {
        payloads.set(params[0] as string, JSON.parse(params[1] as string));
        return { rows: [], rowCount: 1 };
      }
    } as unknown as pg.Pool;
    (recorder as unknown as { pool: pg.Pool }).pool = retryPool;
    recorder.max("b", "highestDamageTaken", 30);
    await recorder.flush();
    expect(payloads.get("b")).toEqual({ kills: 2, highestDamageTaken: 40 });
    expect(payloads.get("c")).toEqual({ kills: 5 });
    expect(payloads.has("a")).toBe(false);
    expect(recorder.pendingCount()).toBe(0);
  });
});
