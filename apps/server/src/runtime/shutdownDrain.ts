export type ShutdownStepResult = {
  timedOut: boolean;
  error: unknown | null;
};

export async function awaitMandatoryShutdownStep(
  work: Promise<unknown>,
  timeoutMs: number
): Promise<ShutdownStepResult> {
  const observed = work.then(
    () => ({ status: "completed" as const }),
    (error: unknown) => ({ status: "failed" as const, error })
  );
  let timeout: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    observed,
    new Promise<{ status: "timed-out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ status: "timed-out" }), Math.max(0, timeoutMs));
    })
  ]);
  if (timeout) clearTimeout(timeout);
  if (outcome.status === "failed") return { timedOut: false, error: outcome.error };
  if (outcome.status === "completed") return { timedOut: false, error: null };

  // A deadline is a durability failure, but callers must not close the pool while
  // the timed-out work still owns a client or query.
  const settled = await observed;
  return {
    timedOut: true,
    error: settled.status === "failed" ? settled.error : null
  };
}
