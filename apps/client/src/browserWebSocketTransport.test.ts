import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserWebSocketTransport,
  type WebSocketSendOutcome
} from "./browserWebSocketTransport.js";

const SEND_OUTCOME_STATUSES = {
  sent: true,
  "socket-not-open": true,
  "stale-socket": true,
  "serialization-failed": true,
  "send-failed": true,
  "intentionally-disconnected": true,
  "protocol-incompatible": true
} as const satisfies Record<WebSocketSendOutcome["status"], true>;

type SocketListener = (event: Event & { data?: unknown; code?: number }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  sendError: Error | null = null;
  private readonly listeners = new Map<string, SocketListener[]>();
  private readonly registered = new Map<string, SocketListener[]>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    this.registered.set(type, [...(this.registered.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
    );
  }

  send(data: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  emitRegistered(type: string, event = new Event(type)): void {
    for (const listener of this.registered.get(type) ?? []) listener(event);
  }

  activeListenerCount(): number {
    return [...this.listeners.values()].reduce((total, listeners) => total + listeners.length, 0);
  }
}

describe("BrowserWebSocketTransport", () => {
  afterEach(() => {
    FakeWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it("keeps the complete send-outcome contract exhaustive", () => {
    expect(Object.keys(SEND_OUTCOME_STATUSES)).toHaveLength(7);
  });

  it("returns sent, socket-not-open, and stale-socket outcomes", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new BrowserWebSocketTransport();
    const generation = transport.open("ws://server/ws", handlers());
    const socket = FakeWebSocket.instances[0]!;

    expect(transport.send({ type: "HELLO" }, generation)).toEqual({
      status: "socket-not-open",
      readyState: 0
    });
    socket.readyState = 1;
    expect(transport.send({ type: "HELLO" }, generation)).toEqual({ status: "sent" });
    expect(socket.sent).toEqual([JSON.stringify({ type: "HELLO" })]);

    transport.open("ws://server/ws", handlers());
    expect(transport.send({ type: "PING" }, generation)).toMatchObject({
      status: "stale-socket",
      expectedGeneration: generation
    });
  });

  it("guards serialization and native send exceptions without throwing", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new BrowserWebSocketTransport();
    const generation = transport.open("ws://server/ws", handlers());
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = 1;
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(transport.send(circular, generation)).toMatchObject({
      status: "serialization-failed",
      error: expect.any(TypeError)
    });
    expect(socket.sent).toEqual([]);

    socket.sendError = new Error("native send failed");
    expect(transport.send({ type: "PING" }, generation)).toEqual({
      status: "send-failed",
      error: socket.sendError
    });
    expect(socket.sent).toEqual([]);
  });

  it("detaches replaced socket listeners while fencing a captured stale event", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const stale = vi.fn();
    const transport = new BrowserWebSocketTransport();
    transport.open("ws://server/ws", handlers(stale));
    const first = FakeWebSocket.instances[0]!;
    transport.open("ws://server/ws", handlers(stale));

    expect(first.activeListenerCount()).toBe(0);
    first.emitRegistered("message", Object.assign(new Event("message"), { data: "{}" }));
    expect(stale).toHaveBeenCalledWith("message");
  });
});

function handlers(onStaleEvent = vi.fn()) {
  return {
    onOpen: vi.fn(),
    onMessage: vi.fn(),
    onClose: vi.fn(),
    onError: vi.fn(),
    onStaleEvent
  };
}
