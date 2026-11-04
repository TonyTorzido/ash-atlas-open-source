export type FlagBuildCountdown = {
  localStartedAt: number;
  localDeadline: number;
  durationMs: number;
  authoritativeComplete: boolean;
};

export function createFlagBuildCountdown(
  message: {
    startedAt: number;
    completesAt: number;
    durationMs: number;
    serverTime: number;
  },
  receivedAt: number
): FlagBuildCountdown {
  const durationMs = Math.max(1, message.durationMs);
  const remainingAtServerSend = Math.max(
    0,
    Math.min(durationMs, message.completesAt - message.serverTime)
  );
  const localDeadline = receivedAt + remainingAtServerSend;
  return {
    localStartedAt: localDeadline - durationMs,
    localDeadline,
    durationMs,
    authoritativeComplete: false
  };
}

export function completeFlagBuildCountdown(
  countdown: FlagBuildCountdown,
  receivedAt: number
): FlagBuildCountdown {
  return {
    ...countdown,
    localDeadline: Math.min(countdown.localDeadline, receivedAt),
    authoritativeComplete: true
  };
}

export function flagBuildRemainingMs(
  countdown: FlagBuildCountdown,
  now: number
): number {
  if (countdown.authoritativeComplete) return 0;
  return Math.max(0, countdown.localDeadline - now);
}

export function buildRemainingTimeLabel(remainingMs: number): string {
  if (remainingMs <= 0) return "Finalizing\u2026";
  const remainingTenths = Math.ceil(remainingMs / 100);
  return `${(remainingTenths / 10).toFixed(1)}s`;
}

export function flagBuildRemainingTimeLabel(
  countdown: FlagBuildCountdown,
  now: number
): string {
  return buildRemainingTimeLabel(flagBuildRemainingMs(countdown, now));
}

export function flagBuildProgress(
  countdown: FlagBuildCountdown,
  now: number
): number {
  if (countdown.authoritativeComplete) return 1;
  return Math.max(0, Math.min(
    1,
    (now - countdown.localStartedAt) / countdown.durationMs
  ));
}
