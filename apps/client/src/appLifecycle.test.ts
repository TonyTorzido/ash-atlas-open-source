import { afterEach, describe, expect, it, vi } from "vitest";
import { SUSPEND_GRACE_MS, subscribeAppLifecycle, subscribeAppResume } from "./appLifecycle.js";

afterEach(() => { vi.useRealTimers(); });

describe("standalone app lifecycle", () => {
  it("resumes a rapid native pagehide/pageshow even after a recent resume", () => {
    const events=new Map<string,EventListener>();
    const documentTarget={visibilityState:"visible" as DocumentVisibilityState,addEventListener:vi.fn(),removeEventListener:vi.fn()};
    const windowTarget={addEventListener:(name:string,listener:EventListener) => events.set(name,listener),removeEventListener:vi.fn()};
    const handlers={onSuspend:vi.fn(),onResume:vi.fn(),onOnline:vi.fn(),onOffline:vi.fn()};
    subscribeAppLifecycle(documentTarget,windowTarget,handlers,() => () => {});
    events.get("pageshow")!(new Event("pageshow"));events.get("pagehide")!(new Event("pagehide"));events.get("pageshow")!(new Event("pageshow"));
    expect(handlers.onResume).toHaveBeenCalledTimes(2);
  });
  it("handles rapid native background/foreground transitions and removes the native listener", () => {
    const documentTarget = { visibilityState: "visible" as DocumentVisibilityState, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const windowTarget = { addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const handlers = { onSuspend: vi.fn(), onResume: vi.fn(), onOnline: vi.fn(), onOffline: vi.fn() };
    let nativeState!: (active: boolean) => void;
    const removeNative = vi.fn();
    const unsubscribe = subscribeAppLifecycle(documentTarget, windowTarget, handlers, (handler) => { nativeState = handler; return removeNative; });
    vi.useFakeTimers();
    nativeState(false); nativeState(true); nativeState(false);
    vi.advanceTimersByTime(SUSPEND_GRACE_MS);
    nativeState(true); nativeState(true);
    expect(handlers.onSuspend).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(removeNative).toHaveBeenCalledOnce();
  });
  it("binds and removes one lifecycle listener without forcing reconnects", () => {
    const documentListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const documentTarget = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: vi.fn((name: string, listener: EventListener) => documentListeners.set(name, listener)),
      removeEventListener: vi.fn()
    };
    const windowTarget = {
      addEventListener: vi.fn((name: string, listener: EventListener) => windowListeners.set(name, listener)),
      removeEventListener: vi.fn()
    };
    const onResume = vi.fn();
    const unsubscribe = subscribeAppResume(documentTarget, windowTarget, onResume);
    documentListeners.get("visibilitychange")?.(new Event("visibilitychange"));
    windowListeners.get("pageshow")?.(new Event("pageshow"));
    windowListeners.get("online")?.(new Event("online"));
    expect(onResume).toHaveBeenCalledTimes(3);
    expect(documentTarget.addEventListener).toHaveBeenCalledTimes(1);
    expect(windowTarget.addEventListener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(documentTarget.removeEventListener).toHaveBeenCalledTimes(1);
    expect(windowTarget.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it("waits until a visible online or foreground signal before recovering", () => {
    const documentListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const documentTarget = {
      visibilityState: "hidden" as DocumentVisibilityState,
      addEventListener: (name: string, listener: EventListener) => documentListeners.set(name, listener),
      removeEventListener: vi.fn()
    };
    const windowTarget = {
      addEventListener: (name: string, listener: EventListener) => windowListeners.set(name, listener),
      removeEventListener: vi.fn()
    };
    const onResume = vi.fn();
    subscribeAppResume(documentTarget, windowTarget, onResume);

    windowListeners.get("online")?.(new Event("online"));
    windowListeners.get("pageshow")?.(new Event("pageshow"));
    expect(onResume).not.toHaveBeenCalled();

    documentTarget.visibilityState = "visible";
    documentListeners.get("visibilitychange")?.(new Event("visibilitychange"));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("keeps routine tab switches connected while routing page and network lifecycle", () => {
    const documentListeners = new Map<string, EventListener>();
    const windowListeners = new Map<string, EventListener>();
    const documentTarget = {
      visibilityState: "visible" as DocumentVisibilityState,
      addEventListener: (name: string, listener: EventListener) =>
        documentListeners.set(name, listener),
      removeEventListener: vi.fn()
    };
    const windowTarget = {
      addEventListener: (name: string, listener: EventListener) =>
        windowListeners.set(name, listener),
      removeEventListener: vi.fn()
    };
    const handlers = {
      onSuspend: vi.fn(),
      onResume: vi.fn(),
      onOnline: vi.fn(),
      onOffline: vi.fn()
    };
    const unsubscribe = subscribeAppLifecycle(documentTarget, windowTarget, handlers);

    documentTarget.visibilityState = "hidden";
    documentListeners.get("visibilitychange")?.(new Event("visibilitychange"));
    expect(handlers.onSuspend).not.toHaveBeenCalled();
    windowListeners.get("pagehide")?.(new Event("pagehide"));
    documentTarget.visibilityState = "visible";
    windowListeners.get("pageshow")?.(new Event("pageshow"));
    windowListeners.get("offline")?.(new Event("offline"));
    windowListeners.get("online")?.(new Event("online"));

    expect(handlers.onSuspend).toHaveBeenCalledOnce();
    expect(handlers.onResume).toHaveBeenCalledOnce();
    expect(handlers.onOffline).toHaveBeenCalledOnce();
    expect(handlers.onOnline).toHaveBeenCalledOnce();
    unsubscribe();
    expect(documentTarget.removeEventListener).toHaveBeenCalledOnce();
    expect(windowTarget.removeEventListener).toHaveBeenCalledTimes(4);
  });

  describe("suspend grace", () => {
    const setup = (): {
      doc: { visibilityState: DocumentVisibilityState; addEventListener: (n: string, l: EventListener) => void; removeEventListener: () => void };
      fire: (name: string) => void;
      handlers: { onSuspend: ReturnType<typeof vi.fn>; onResume: ReturnType<typeof vi.fn>; onOnline: ReturnType<typeof vi.fn>; onOffline: ReturnType<typeof vi.fn> };
    } => {
      vi.useFakeTimers();
      const listeners = new Map<string, EventListener>();
      const doc = {
        visibilityState: "visible" as DocumentVisibilityState,
        addEventListener: (n: string, l: EventListener) => { listeners.set(n, l); },
        removeEventListener: () => undefined
      };
      const win = { addEventListener: (n: string, l: EventListener) => { listeners.set(n, l); }, removeEventListener: () => undefined };
      const handlers = { onSuspend: vi.fn(), onResume: vi.fn(), onOnline: vi.fn(), onOffline: vi.fn() };
      subscribeAppLifecycle(doc, win, handlers);
      return { doc, fire: (name) => listeners.get(name)?.(new Event(name)), handlers };
    };

    it("does not suspend on a quick hide and show", () => {
      const { doc, fire, handlers } = setup();
      doc.visibilityState = "hidden"; fire("visibilitychange");
      vi.advanceTimersByTime(2000);
      doc.visibilityState = "visible"; fire("visibilitychange");
      vi.advanceTimersByTime(SUSPEND_GRACE_MS * 2);
      expect(handlers.onSuspend).not.toHaveBeenCalled();
      expect(handlers.onResume).toHaveBeenCalledOnce();
    });

    it("suspends once the grace timer fires, then resumes", () => {
      const { doc, fire, handlers } = setup();
      doc.visibilityState = "hidden"; fire("visibilitychange");
      vi.advanceTimersByTime(SUSPEND_GRACE_MS);
      expect(handlers.onSuspend).toHaveBeenCalledOnce();
      doc.visibilityState = "visible"; fire("visibilitychange");
      expect(handlers.onResume).toHaveBeenCalledOnce();
    });

    it("suspends then resumes on a long lock whose timer was frozen", () => {
      const { doc, fire, handlers } = setup();
      doc.visibilityState = "hidden"; fire("visibilitychange");
      const jumped = Date.now() + SUSPEND_GRACE_MS + 1000;
      vi.clearAllTimers(); // frozen: the grace callback never runs
      vi.setSystemTime(jumped);
      doc.visibilityState = "visible"; fire("visibilitychange");
      expect(handlers.onSuspend).toHaveBeenCalledOnce();
      expect(handlers.onResume).toHaveBeenCalledOnce();
      expect(handlers.onSuspend.mock.invocationCallOrder[0]!).toBeLessThan(handlers.onResume.mock.invocationCallOrder[0]!);
    });

    it("suspends immediately on pagehide and cancels the pending grace timer", () => {
      const { doc, fire, handlers } = setup();
      doc.visibilityState = "hidden"; fire("visibilitychange");
      fire("pagehide");
      expect(handlers.onSuspend).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(SUSPEND_GRACE_MS * 2);
      expect(handlers.onSuspend).toHaveBeenCalledOnce();
    });
  });
});
