import { describe, expect, it, vi } from "vitest";

import {
  BoundedModerationDispatcher,
  InProcessChatModerationConsumer,
  resolveAutomatedModerationAction,
  type ModerationDecisionInput
} from "./moderation.js";
import { CHAT_AUTOMATION_POLICY } from "./policy.js";
import type { ChatModerationEvent } from "./types.js";

describe("bounded asynchronous moderation", () => {
  it("retries safely, dead-letters once, and never retains failed work", async () => {
    const deadLetter = vi.fn();
    const consumer = new InProcessChatModerationConsumer(async () => {
      throw new Error("offline");
    });
    const dispatcher = new BoundedModerationDispatcher(consumer, 4, 2, deadLetter);

    expect(dispatcher.enqueue(event("message-1"))).toBe(true);
    await dispatcher.flush();

    expect(deadLetter).toHaveBeenCalledOnce();
    expect(dispatcher.metricsSnapshot()).toMatchObject({
      queueDepth: 0,
      accepted: 1,
      retries: 2,
      failures: 1,
      processed: 0
    });
  });

  it("has an explicit capacity and deduplicates queued message IDs", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dispatcher = new BoundedModerationDispatcher(
      new InProcessChatModerationConsumer(async () => blocked),
      2,
      0
    );
    expect(dispatcher.enqueue(event("active"))).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(dispatcher.enqueue(event("queued-1"))).toBe(true);
    expect(dispatcher.enqueue(event("queued-1"))).toBe(true);
    expect(dispatcher.enqueue(event("queued-2"))).toBe(true);
    expect(dispatcher.enqueue(event("overflow"))).toBe(false);
    expect(dispatcher.metricsSnapshot()).toMatchObject({ droppedAtCapacity: 1, duplicates: 1 });
    release?.();
    await dispatcher.flush();
    expect(dispatcher.metricsSnapshot().queueDepth).toBe(0);
  });

  it("never invokes an in-process moderation consumer on the enqueue call stack", async () => {
    const handle = vi.fn(async () => undefined);
    const dispatcher = new BoundedModerationDispatcher(
      new InProcessChatModerationConsumer(handle),
      2,
      0
    );

    expect(dispatcher.enqueue(event("deferred"))).toBe(true);
    expect(handle).not.toHaveBeenCalled();
    await dispatcher.flush();
    expect(handle).toHaveBeenCalledOnce();
  });

  it("only automates configured severe, high-confidence actions and caps mute duration", () => {
    expect(resolveAutomatedModerationAction(
      decision({ confidence: 0.5, categories: ["credible_threat"] }),
      0.92,
      CHAT_AUTOMATION_POLICY.severeCategories,
      3_600
    )).toMatchObject({ action: "flag_for_review", muteDurationSeconds: null });
    expect(resolveAutomatedModerationAction(
      decision({ confidence: 0.99, categories: ["spam"], requestedDurationSeconds: 500 }),
      0.92,
      CHAT_AUTOMATION_POLICY.severeCategories,
      3_600
    )).toMatchObject({ action: "flag_for_review" });
    expect(resolveAutomatedModerationAction(
      decision({ confidence: 0.99, categories: ["credible_threat"], requestedDurationSeconds: 99_999 }),
      0.92,
      CHAT_AUTOMATION_POLICY.severeCategories,
      3_600
    )).toMatchObject({ action: "temporary_global_mute", muteDurationSeconds: 3_600 });
  });
});

function event(messageId: string): ChatModerationEvent {
  return {
    messageId,
    channelId: "channel",
    channelKey: "public:general",
    channelType: "public",
    senderPlayerId: "player",
    body: "plain text",
    serverCreatedAt: new Date(0).toISOString(),
    moderationPolicyVersion: "public_chat_v1"
  };
}

function decision(overrides: Partial<ModerationDecisionInput> = {}): ModerationDecisionInput {
  return {
    decisionId: "05000000-0000-4000-8000-000000000111",
    messageId: "05000000-0000-4000-8000-000000000222",
    playerId: "player",
    categories: ["credible_threat"],
    confidence: 0.99,
    recommendedAction: "temporary_global_mute",
    requestedMuteScope: "global",
    requestedDurationSeconds: 600,
    reason: "policy",
    policyVersion: "public_chat_v1",
    ...overrides
  };
}
