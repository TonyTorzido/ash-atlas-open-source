import { serializeServerMessage, type ServerMessage } from "@ash-atlas/shared";

import {
  deliveryClassFor,
  sendModeForDeliveryClass,
  type DeliveryClass,
  type OutboundSendMode
} from "./deliveryPolicy.js";

export type PublisherSendResult =
  | "sent"
  | "missing"
  | "not-open"
  | "backpressure-skipped"
  | "closed";

export type PublisherDeliveryResult = Readonly<{
  result: PublisherSendResult;
  bufferedAmount: number;
  backpressureClosure: boolean;
  sendFailure: boolean;
}>;

export type DirectPublisherSocket = Readonly<{
  readyState: number;
  bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}>;

export type RealtimePublisherMetrics = Readonly<{
  framesByMessageType: Readonly<Record<string, number>>;
  bytesByMessageType: Readonly<Record<string, number>>;
  framesByDeliveryClass: Readonly<Record<DeliveryClass, number>>;
  bytesByDeliveryClass: Readonly<Record<DeliveryClass, number>>;
  skippedFrames: number;
  skippedBytes: number;
  serializationFailures: number;
  sendFailures: number;
  backpressureClosures: number;
  maximumSerializedFrameBytes: number;
  currentBufferedAmount: number;
  maximumBufferedAmount: number;
  broadcasts: number;
  broadcastRecipients: number;
  maximumBroadcastRecipients: number;
}>;

type MutablePublisherMetrics = {
  framesByMessageType: Record<string, number>;
  bytesByMessageType: Record<string, number>;
  framesByDeliveryClass: Record<DeliveryClass, number>;
  bytesByDeliveryClass: Record<DeliveryClass, number>;
  skippedFrames: number;
  skippedBytes: number;
  serializationFailures: number;
  sendFailures: number;
  backpressureClosures: number;
  maximumSerializedFrameBytes: number;
  currentBufferedAmount: number;
  maximumBufferedAmount: number;
  broadcasts: number;
  broadcastRecipients: number;
  maximumBroadcastRecipients: number;
};

export class RealtimePublisher {
  private readonly metrics: MutablePublisherMetrics = emptyMetrics();

  publish(
    connectionIds: Iterable<string>,
    message: ServerMessage,
    deliver: (
      connectionId: string,
      payload: string,
      mode: OutboundSendMode
    ) => PublisherDeliveryResult,
    options: Readonly<{
      mode?: OutboundSendMode;
      broadcast?: boolean;
    }> = {}
  ): Map<string, PublisherSendResult> {
    const recipients = [...connectionIds];
    const deliveryClass = deliveryClassFor(message, options.mode);
    const mode = sendModeForDeliveryClass(deliveryClass);
    let payload: string;
    try {
      payload = serializeServerMessage(message);
    } catch (error) {
      this.metrics.serializationFailures += 1;
      throw error;
    }
    const bytes = Buffer.byteLength(payload, "utf8");
    this.metrics.maximumSerializedFrameBytes = Math.max(
      this.metrics.maximumSerializedFrameBytes,
      bytes
    );
    if (options.broadcast) {
      this.metrics.broadcasts += 1;
      this.metrics.broadcastRecipients += recipients.length;
      this.metrics.maximumBroadcastRecipients = Math.max(
        this.metrics.maximumBroadcastRecipients,
        recipients.length
      );
    }
    const results = new Map<string, PublisherSendResult>();
    let currentBufferedAmount = 0;
    for (const connectionId of recipients) {
      increment(this.metrics.framesByMessageType, message.type, 1);
      increment(this.metrics.bytesByMessageType, message.type, bytes);
      increment(this.metrics.framesByDeliveryClass, deliveryClass, 1);
      increment(this.metrics.bytesByDeliveryClass, deliveryClass, bytes);
      const delivery = deliver(connectionId, payload, mode);
      results.set(connectionId, delivery.result);
      currentBufferedAmount = Math.max(currentBufferedAmount, delivery.bufferedAmount);
      this.metrics.maximumBufferedAmount = Math.max(
        this.metrics.maximumBufferedAmount,
        delivery.bufferedAmount
      );
      if (delivery.result === "backpressure-skipped") {
        this.metrics.skippedFrames += 1;
        this.metrics.skippedBytes += bytes;
      }
      if (delivery.sendFailure) this.metrics.sendFailures += 1;
      if (delivery.backpressureClosure) this.metrics.backpressureClosures += 1;
    }
    this.metrics.currentBufferedAmount = currentBufferedAmount;
    return results;
  }

  metricsSnapshot(currentBufferedAmount = this.metrics.currentBufferedAmount): RealtimePublisherMetrics {
    return {
      ...this.metrics,
      currentBufferedAmount,
      framesByMessageType: { ...this.metrics.framesByMessageType },
      bytesByMessageType: { ...this.metrics.bytesByMessageType },
      framesByDeliveryClass: { ...this.metrics.framesByDeliveryClass },
      bytesByDeliveryClass: { ...this.metrics.bytesByDeliveryClass }
    };
  }
}

const directPublisher = new RealtimePublisher();
const DIRECT_RECIPIENT = "direct-socket";
const DIRECT_SOFT_BUFFERED_BYTES = 512 * 1024;
const DIRECT_HARD_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Publishes pre-registration and request-scoped replies through the shared policy engine. */
export function publishDirectServerMessage(
  socket: DirectPublisherSocket,
  message: ServerMessage,
  onSendFailure?: (error: unknown) => void
): PublisherSendResult {
  return directPublisher.publish(
    [DIRECT_RECIPIENT],
    message,
    (_recipient, payload, mode) => deliverDirect(socket, payload, mode, onSendFailure),
    { mode: "critical" }
  ).get(DIRECT_RECIPIENT) ?? "missing";
}

export function directPublisherMetricsSnapshot(): RealtimePublisherMetrics {
  return directPublisher.metricsSnapshot();
}

function deliverDirect(
  socket: DirectPublisherSocket,
  payload: string,
  mode: OutboundSendMode,
  onSendFailure?: (error: unknown) => void
): PublisherDeliveryResult {
  const bufferedAmount = socket.bufferedAmount ?? 0;
  if (socket.readyState !== 1) return directDelivery("not-open", bufferedAmount);
  if (bufferedAmount >= DIRECT_HARD_BUFFERED_BYTES) {
    socket.close(4008, "websocket backpressure limit exceeded");
    return directDelivery("closed", bufferedAmount, { backpressureClosure: true });
  }
  const skipAt = mode === "recoverable-social" || mode === "transient-social"
    ? Math.min(DIRECT_SOFT_BUFFERED_BYTES, 128 * 1024)
    : DIRECT_SOFT_BUFFERED_BYTES;
  if (mode !== "critical" && bufferedAmount >= skipAt) {
    return directDelivery("backpressure-skipped", bufferedAmount);
  }
  try {
    socket.send(payload);
    return directDelivery("sent", bufferedAmount);
  } catch (error) {
    onSendFailure?.(error);
    return directDelivery("closed", bufferedAmount, { sendFailure: true });
  }
}

function directDelivery(
  result: PublisherSendResult,
  bufferedAmount: number,
  flags: Readonly<{ backpressureClosure?: boolean; sendFailure?: boolean }> = {}
): PublisherDeliveryResult {
  return {
    result,
    bufferedAmount,
    backpressureClosure: flags.backpressureClosure ?? false,
    sendFailure: flags.sendFailure ?? false
  };
}

function emptyMetrics(): MutablePublisherMetrics {
  const byClass = (): Record<DeliveryClass, number> => ({
    critical: 0,
    "replaceable-world": 0,
    "replaceable-combat": 0,
    "replaceable-population": 0,
    "terminal-population": 0,
    "recoverable-social": 0,
    "transient-social": 0
  });
  return {
    framesByMessageType: {},
    bytesByMessageType: {},
    framesByDeliveryClass: byClass(),
    bytesByDeliveryClass: byClass(),
    skippedFrames: 0,
    skippedBytes: 0,
    serializationFailures: 0,
    sendFailures: 0,
    backpressureClosures: 0,
    maximumSerializedFrameBytes: 0,
    currentBufferedAmount: 0,
    maximumBufferedAmount: 0,
    broadcasts: 0,
    broadcastRecipients: 0,
    maximumBroadcastRecipients: 0
  };
}

function increment(record: Record<string, number>, key: string, amount: number): void {
  record[key] = (record[key] ?? 0) + amount;
}
