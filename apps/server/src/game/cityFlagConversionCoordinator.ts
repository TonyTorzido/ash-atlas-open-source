import { randomUUID } from "node:crypto";

import type { AppLogger } from "../logger.js";
import { BoundedReplayCache } from "./boundedReplayCache.js";
import type {
  CityFlagConversionOptions,
  CityFlagConversionPreview,
  CityFlagConversionResult,
  CityService
} from "./cities.js";

const REPLAY_MAX_ENTRIES = 1_024;
const REPLAY_TTL_MS = 10 * 60_000;

export type CityFlagConversionSession = CityFlagConversionPreview & {
  conversionId: string;
  requestId: string;
  playerId: string;
  startedAt: number;
  completesAt: number;
};

type RuntimeSession = CityFlagConversionSession & {
  options: CityFlagConversionOptions;
  status: "waiting" | "completing";
  timer: ReturnType<typeof setTimeout> | null;
};

type CompletedConversion = {
  session: CityFlagConversionSession;
  result: CityFlagConversionResult;
};

type Hooks = Readonly<{
  sendStarted(session: CityFlagConversionSession): void;
  sendError(session: Pick<CityFlagConversionSession, "playerId" | "requestId">, error: unknown): void;
  cancelled(session: CityFlagConversionSession, reason: "movement"): void;
  completed(
    session: CityFlagConversionSession,
    result: CityFlagConversionResult
  ): void | Promise<void>;
  replayCompleted(
    session: CityFlagConversionSession,
    result: CityFlagConversionResult
  ): void | Promise<void>;
}>;

export class CityFlagConversionCoordinator {
  private readonly activeByPlayer = new Map<string, RuntimeSession>();
  private readonly activePlayerByFlag = new Map<string, string>();
  private readonly startingByPlayer = new Map<string, {
    requestId: string;
    flagId: string;
    promise: Promise<CityFlagConversionSession | null>;
  }>();
  private readonly startingPlayerByFlag = new Map<string, string>();
  private readonly completedRequests: BoundedReplayCache<string, CompletedConversion>;
  private readonly latestCompletedByPlayer: BoundedReplayCache<string, CompletedConversion>;

  constructor(
    private readonly durationMs: number,
    private readonly cities: Pick<
      CityService,
      "previewCityFlagConversion" | "replayCityFlagConversion" | "convertCityFlag"
    >,
    private readonly logger: Pick<AppLogger, "info" | "warn">,
    private readonly hooks: Hooks,
    private readonly now: () => number = Date.now
  ) {
    if (!Number.isInteger(durationMs) || durationMs <= 0) {
      throw new Error("city flag conversion duration must be a positive integer");
    }
    this.completedRequests = new BoundedReplayCache(
      REPLAY_MAX_ENTRIES,
      REPLAY_TTL_MS,
      now
    );
    this.latestCompletedByPlayer = new BoundedReplayCache(
      REPLAY_MAX_ENTRIES,
      REPLAY_TTL_MS,
      now
    );
  }

  activeForPlayer(playerId: string): CityFlagConversionSession | null {
    return this.activeByPlayer.get(playerId) ?? null;
  }

  cancelPlayer(playerId: string, reason: "movement"): boolean {
    const session = this.activeByPlayer.get(playerId);
    if (!session || session.status !== "waiting") return false;
    this.clear(session);
    this.hooks.cancelled(session, reason);
    return true;
  }

  connectPlayer(playerId: string): void {
    const session = this.activeByPlayer.get(playerId);
    if (session) {
      this.hooks.sendStarted(session);
      if (session.completesAt <= this.now()) {
        queueMicrotask(() => void this.complete(session));
      }
      return;
    }
    const completed = this.latestCompletedByPlayer.get(playerId);
    if (completed) {
      void Promise.resolve(
        this.hooks.replayCompleted(completed.session, completed.result)
      ).catch((error: unknown) => {
        this.logger.warn({
          err: error,
          playerId,
          requestId: completed.session.requestId,
          conversionId: completed.session.conversionId
        }, "failed to replay completed city flag contribution");
      });
    }
  }

  async start(
    playerId: string,
    requestId: string,
    flagId: string,
    options: CityFlagConversionOptions = {}
  ): Promise<CityFlagConversionSession | null> {
    const replay = this.completedRequests.get(`${playerId}:${requestId}`);
    if (replay) {
      await this.hooks.replayCompleted(replay.session, replay.result);
      return null;
    }

    const active = this.activeByPlayer.get(playerId);
    if (active?.requestId === requestId && active.flagId === flagId) {
      this.hooks.sendStarted(active);
      return active;
    }
    if (active) {
      throw new Error("A city flag contribution is already in progress");
    }

    const starting = this.startingByPlayer.get(playerId);
    if (starting?.requestId === requestId && starting.flagId === flagId) {
      return starting.promise;
    }
    if (starting) {
      throw new Error("A city flag contribution is already starting");
    }
    const activeFlagPlayer = this.activePlayerByFlag.get(flagId)
      ?? this.startingPlayerByFlag.get(flagId);
    if (activeFlagPlayer) {
      throw new Error("This flag is already being contributed");
    }

    const promise = this.begin(playerId, requestId, flagId, options);
    this.startingByPlayer.set(playerId, { requestId, flagId, promise });
    this.startingPlayerByFlag.set(flagId, playerId);
    try {
      return await promise;
    } finally {
      const current = this.startingByPlayer.get(playerId);
      if (current?.promise === promise) this.startingByPlayer.delete(playerId);
      if (this.startingPlayerByFlag.get(flagId) === playerId) {
        this.startingPlayerByFlag.delete(flagId);
      }
    }
  }

  private async begin(
    playerId: string,
    requestId: string,
    flagId: string,
    options: CityFlagConversionOptions
  ): Promise<CityFlagConversionSession | null> {
    const replay = await this.cities.replayCityFlagConversion(playerId, {
      requestId,
      flagId
    });
    if (replay) {
      const replayedAt = this.now();
      const session: CityFlagConversionSession = {
        conversionId: requestId,
        requestId,
        playerId,
        cityId: replay.cityId,
        cityName: "",
        flagId,
        flagName: "",
        position: { lat: 0, lon: 0 },
        startedAt: replayedAt,
        completesAt: replayedAt
      };
      this.completedRequests.set(`${playerId}:${requestId}`, {
        session,
        result: replay
      });
      this.latestCompletedByPlayer.set(playerId, { session, result: replay });
      await this.hooks.replayCompleted(session, replay);
      return null;
    }
    const preview = await this.cities.previewCityFlagConversion(playerId, flagId, options);
    const startedAt = this.now();
    const session: RuntimeSession = {
      ...preview,
      conversionId: randomUUID(),
      requestId,
      playerId,
      startedAt,
      completesAt: startedAt + this.durationMs,
      options,
      status: "waiting",
      timer: null
    };
    this.activeByPlayer.set(playerId, session);
    this.activePlayerByFlag.set(flagId, playerId);
    this.hooks.sendStarted(session);
    this.schedule(session);
    this.logger.info({
      playerId,
      flagId,
      requestId,
      conversionId: session.conversionId,
      completesAt: session.completesAt
    }, "city flag contribution started");
    return session;
  }

  private schedule(session: RuntimeSession): void {
    const delay = Math.max(0, session.completesAt - this.now());
    session.timer = setTimeout(() => void this.complete(session), delay);
    session.timer.unref?.();
  }

  private async complete(session: RuntimeSession): Promise<void> {
    if (
      this.activeByPlayer.get(session.playerId) !== session ||
      session.status !== "waiting"
    ) return;
    const now = this.now();
    if (now < session.completesAt) {
      this.schedule(session);
      return;
    }
    session.status = "completing";
    let result: CityFlagConversionResult;
    try {
      result = await this.cities.convertCityFlag(session.playerId, {
        requestId: session.requestId,
        flagId: session.flagId
      }, session.options);
    } catch (error) {
      this.clear(session);
      this.hooks.sendError(session, error);
      this.logger.info({
        err: error,
        playerId: session.playerId,
        flagId: session.flagId,
        requestId: session.requestId,
        conversionId: session.conversionId
      }, "city flag contribution failed revalidation");
      return;
    }
    this.completedRequests.set(`${session.playerId}:${session.requestId}`, {
      session,
      result
    });
    this.latestCompletedByPlayer.set(session.playerId, { session, result });
    this.clear(session);
    try {
      await this.hooks.completed(session, result);
    } catch (error) {
      this.logger.warn({
        err: error,
        playerId: session.playerId,
        flagId: session.flagId,
        requestId: session.requestId,
        conversionId: session.conversionId
      }, "city flag contribution committed but publication failed");
    }
    this.logger.info({
      playerId: session.playerId,
      flagId: session.flagId,
      requestId: session.requestId,
      conversionId: session.conversionId
    }, "city flag contribution completed");
  }

  private clear(session: RuntimeSession): void {
    if (session.timer) clearTimeout(session.timer);
    if (this.activeByPlayer.get(session.playerId) === session) {
      this.activeByPlayer.delete(session.playerId);
    }
    if (this.activePlayerByFlag.get(session.flagId) === session.playerId) {
      this.activePlayerByFlag.delete(session.flagId);
    }
  }
}
