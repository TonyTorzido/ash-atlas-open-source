import {
  registerRealtimeApplication,
  type RealtimeDependencies,
  type RealtimeLifecycle
} from "./realtimeApplication.js";

export * from "./realtimeApplication.js";

export function registerRealtime(
  dependencies: RealtimeDependencies
): Promise<RealtimeLifecycle> {
  return registerRealtimeApplication(dependencies);
}
