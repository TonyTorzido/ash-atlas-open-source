import { perfMetrics } from "./perf/perfMetrics.js";

export type WebSocketSendOutcome =
  | Readonly<{ status: "sent" }>
  | Readonly<{ status: "socket-not-open"; readyState: number | null }>
  | Readonly<{ status: "stale-socket"; expectedGeneration: number; activeGeneration: number }>
  | Readonly<{ status: "serialization-failed"; error: unknown }>
  | Readonly<{ status: "send-failed"; error: unknown }>
  | Readonly<{ status: "intentionally-disconnected" }>
  | Readonly<{ status: "protocol-incompatible" }>;

export type BrowserWebSocketTransportHandlers = Readonly<{
  onOpen(generation: number): void;
  onMessage(generation: number, event: MessageEvent): void;
  onClose(generation: number, event: CloseEvent): void;
  onError(generation: number, event: Event): void;
  onStaleEvent?(eventType: "open" | "message" | "close" | "error"): void;
}>;

const WEB_SOCKET_OPEN = 1;

/** Sole browser owner for raw WebSocket construction and generation fencing. */
export class BrowserWebSocketTransport {
  private socket: WebSocket | null = null;
  private generation = 0;
  private detachSocketListeners: (() => void) | null = null;

  open(
    url: string,
    handlers: BrowserWebSocketTransportHandlers,
    protocols: readonly string[] = []
  ): number {
    this.close();
    const generation = ++this.generation;
    const socket = protocols.length > 0
      ? new WebSocket(url, [...protocols])
      : new WebSocket(url);
    this.socket = socket;
    const current = (eventType: "open" | "message" | "close" | "error"): boolean => {
      if (this.socket === socket && this.generation === generation) return true;
      handlers.onStaleEvent?.(eventType);
      return false;
    };
    const onOpen = () => {
      if (current("open")) handlers.onOpen(generation);
    };
    const onMessage = (event: MessageEvent) => {
      if (current("message")) {
        const data: unknown = event.data;
        perfMetrics.noteWebSocketBytes(
          typeof data === "string" ? data.length : (data as { byteLength?: number } | null)?.byteLength ?? 0
        );
        handlers.onMessage(generation, event);
      }
    };
    const onClose = (event: CloseEvent) => {
      if (!current("close")) return;
      this.socket = null;
      this.detachActiveSocketListeners();
      handlers.onClose(generation, event);
    };
    const onError = (event: Event) => {
      if (current("error")) handlers.onError(generation, event);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
    this.detachSocketListeners = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    return generation;
  }

  send(message: unknown, expectedGeneration = this.generation): WebSocketSendOutcome {
    if (expectedGeneration !== this.generation) {
      return {
        status: "stale-socket",
        expectedGeneration,
        activeGeneration: this.generation
      };
    }
    const socket = this.socket;
    if (socket?.readyState !== WEB_SOCKET_OPEN) {
      return { status: "socket-not-open", readyState: socket?.readyState ?? null };
    }
    let data: string;
    try {
      const serialized = JSON.stringify(message);
      if (serialized === undefined) {
        throw new TypeError("websocket message could not be serialized");
      }
      data = serialized;
    } catch (error) {
      return { status: "serialization-failed", error };
    }
    try {
      socket.send(data);
      return { status: "sent" };
    } catch (error) {
      return { status: "send-failed", error };
    }
  }

  close(code?: number, reason?: string): void {
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    this.detachActiveSocketListeners();
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // The socket is already detached; lifecycle remains fenced.
    }
  }

  readyState(): number | null {
    return this.socket?.readyState ?? null;
  }

  currentGeneration(): number {
    return this.generation;
  }

  private detachActiveSocketListeners(): void {
    this.detachSocketListeners?.();
    this.detachSocketListeners = null;
  }
}
