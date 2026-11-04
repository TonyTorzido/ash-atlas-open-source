import { requestIdCrypto as crypto } from "../requestId.js";

export function startFlagVisitOperation(options: Readonly<{
  connected: boolean;
  pendingRequestId: string | null;
  preferredRequestId?: string;
  send(requestId: string): string | null;
  beforeSend(requestId: string): void;
  showError(message: string): void;
}>): string | null {
  if (!options.connected) {
    options.showError("Cannot travel while disconnected or reconnecting.");
    return null;
  }
  if (options.pendingRequestId) {
    options.showError("Travel is already in progress.");
    return null;
  }
  const requestId = options.preferredRequestId ?? crypto.randomUUID();
  options.beforeSend(requestId);
  const sentRequestId = options.send(requestId);
  if (!sentRequestId) {
    options.showError("Cannot travel while disconnected or reconnecting.");
    return null;
  }
  return sentRequestId;
}
