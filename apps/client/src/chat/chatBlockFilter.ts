import { ProfileApiClient } from "../profiles/profileClient.js";

const BLOCK_LIST_RETRY_SCHEDULE = [0, 1_000, 2_000, 5_000];
const BLOCK_LIST_MAX_AUTO_ATTEMPTS = BLOCK_LIST_RETRY_SCHEDULE.length;

export type BlockFilterSnapshot = {
  hiddenSenderIds: ReadonlySet<string>;
  hasValidData: boolean;
  loadedRefreshToken: number | null;
  initialLoadError: boolean;
  refreshError: boolean;
  loading: boolean;
};

type Listener = () => void;

export type BlockFilterDeps = {
  serverHttpBase: string;
  csrfToken: string;
  createProfileApi?: (serverHttpBase: string, csrfToken: string) => ProfileApiClient;
  now?: () => number;
};

export class ChatBlockFilter {
  private hiddenSenderIds: ReadonlySet<string> = new Set();
  private hasValidData = false;
  private loadedRefreshToken: number | null = null;
  private initialLoadError = false;
  private refreshError = false;
  private loading = false;

  private requestEpoch = 0;
  private active = true;
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly listeners = new Set<Listener>();
  private readonly deps: BlockFilterDeps;
  private snapshot: BlockFilterSnapshot;

  private currentPlayerId: string | null = null;
  private currentRefreshToken = -1;

  constructor(deps: BlockFilterDeps) {
    this.deps = deps;
    this.snapshot = this.createSnapshot();
  }

  subscribe = (listener: Listener): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): BlockFilterSnapshot => this.snapshot;

  activate(): void {
    if (this.disposed || this.active) return;
    this.active = true;
    this.ensureLoading();
  }

  deactivate(): void {
    if (this.disposed || !this.active) return;
    this.active = false;
    this.requestEpoch += 1;
    this.cancelRetry();
    if (this.loading) {
      this.loading = false;
      this.publish();
    }
  }

  setPlayer(playerId: string, refreshToken: number): void {
    if (this.disposed || !this.active) return;
    if (this.currentPlayerId !== playerId) {
      this.cancelRetry();
      this.requestEpoch += 1;
      this.hiddenSenderIds = new Set();
      this.hasValidData = false;
      this.loadedRefreshToken = null;
      this.initialLoadError = false;
      this.refreshError = false;
      this.loading = false;
      this.currentPlayerId = playerId;
      this.currentRefreshToken = refreshToken;
      this.startLoad(playerId, refreshToken, 0);
      return;
    }

    if (this.currentRefreshToken !== refreshToken) {
      this.cancelRetry();
      this.requestEpoch += 1;
      this.currentRefreshToken = refreshToken;
      this.initialLoadError = false;
      this.refreshError = false;
      this.loading = false;
      this.startLoad(playerId, refreshToken, 0);
      return;
    }

    this.currentRefreshToken = refreshToken;
    if (this.currentPlayerId !== null) {
      this.ensureLoading();
    }
  }

  retry(): void {
    if (this.disposed || !this.active || this.currentPlayerId === null) return;
    this.cancelRetry();
    this.requestEpoch += 1;
    this.initialLoadError = false;
    this.refreshError = false;
    this.loading = false;
    this.startLoad(this.currentPlayerId, this.currentRefreshToken, 0);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.requestEpoch += 1;
    this.cancelRetry();
    if (this.loading) {
      this.loading = false;
      this.snapshot = this.createSnapshot();
    }
    this.listeners.clear();
  }

  private ensureLoading(): void {
    if (this.loading) return;
    if (this.initialLoadError) return;
    if (!this.hasValidData || this.loadedRefreshToken !== this.currentRefreshToken) {
      const playerId = this.currentPlayerId;
      if (playerId !== null) this.startLoad(playerId, this.currentRefreshToken, 0);
    }
  }

  private startLoad(targetPlayerId: string, targetRefreshToken: number, attemptIndex: number): void {
    const epoch = this.requestEpoch;
    if (!this.loading) {
      this.loading = true;
      this.publish();
    }

    const createApi = this.deps.createProfileApi ?? ((base, token) => new ProfileApiClient(base, token));
    const api = createApi(this.deps.serverHttpBase, this.deps.csrfToken);
    void (async () => {
      const playerIds = new Set<string>();
      let offset = 0;
      for (let page = 0; page < 100; page += 1) {
        if (!this.isCurrentRequest(epoch, targetPlayerId, targetRefreshToken)) return;
        const list = await api.list("blocked", offset, 50);
        for (const entry of list.entries) playerIds.add(entry.playerId);
        if (!list.hasMore || list.entries.length === 0) break;
        offset += list.entries.length;
      }
      if (this.isCurrentRequest(epoch, targetPlayerId, targetRefreshToken)) {
        this.hiddenSenderIds = playerIds;
        this.loading = false;
        this.initialLoadError = false;
        this.refreshError = false;
        this.hasValidData = true;
        this.loadedRefreshToken = targetRefreshToken;
        this.publish();
      }
    })().catch(() => {
      if (!this.isCurrentRequest(epoch, targetPlayerId, targetRefreshToken)) return;
      const nextAttempt = attemptIndex + 1;
      if (nextAttempt < BLOCK_LIST_MAX_AUTO_ATTEMPTS) {
        const delay = BLOCK_LIST_RETRY_SCHEDULE[nextAttempt];
        this.cancelRetry();
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.isCurrentRequest(epoch, targetPlayerId, targetRefreshToken)) {
            this.startLoad(targetPlayerId, targetRefreshToken, nextAttempt);
          }
        }, delay);
      } else {
        this.loading = false;
        if (this.hasValidData) {
          this.refreshError = true;
        } else {
          this.initialLoadError = true;
        }
        this.publish();
      }
    });
  }

  private isCurrentRequest(
    epoch: number,
    targetPlayerId: string,
    targetRefreshToken: number
  ): boolean {
    return this.active &&
      this.requestEpoch === epoch &&
      this.currentPlayerId === targetPlayerId &&
      this.currentRefreshToken === targetRefreshToken;
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private publish(): void {
    this.snapshot = this.createSnapshot();
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  private createSnapshot(): BlockFilterSnapshot {
    return {
      hiddenSenderIds: this.hiddenSenderIds,
      hasValidData: this.hasValidData,
      loadedRefreshToken: this.loadedRefreshToken,
      initialLoadError: this.initialLoadError,
      refreshError: this.refreshError,
      loading: this.loading
    };
  }
}
