import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { AppleAuthService } from "./appleAuth.js";
import type { AuthService } from "./authService.js";
import { registerAuthRoutes } from "./authRoutes.js";
import type { OnboardingService } from "./onboardingService.js";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Apple form_post callback routes", () => {
  it("returns a native cancellation only with the server-stored attempt correlation", async () => {
    const state="s".repeat(43);
    const app=await callbackApp(vi.fn().mockResolvedValue({returnPath:"/play/",outcome:"cancelled",nativeReturn:true,nativeReturnState:state}));
    const response=await app.inject({method:"POST",url:"/api/auth/apple/callback",headers:{"content-type":"application/x-www-form-urlencoded"},payload:"state=provider-state&error=user_cancelled_authorize"});
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`com.ashatlas.game://auth/apple-link?state=${state}&outcome=cancelled`);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("redirects cancellation without requiring a prior device cookie", async () => {
    const cancel = vi.fn().mockResolvedValue({
      returnPath: "/play/?source=apple",
      outcome: "cancelled"
    });
    const app = await callbackApp(cancel);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "state=opaque-state&error=user_cancelled_authorize"
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      "https://playashatlas.com/play/?source=apple&apple_auth=cancelled"
    );
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(cancel).toHaveBeenCalledWith("opaque-state", "user_cancelled_authorize");
  });

  it("falls back to the public play route instead of honoring an unsafe stored return", async () => {
    const app = await callbackApp(vi.fn().mockResolvedValue({
      returnPath: "https://attacker.example/phish",
      outcome: "provider_error"
    }));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "state=opaque-state&error=server_error"
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      "https://playashatlas.com/play/?apple_auth=provider_error"
    );
  });

  it("redirects a replayed or expired cancellation to the fixed public fallback", async () => {
    const app = await callbackApp(vi.fn().mockRejectedValue(new Error("state already consumed")));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/apple/callback",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "state=replayed-state&error=user_cancelled_authorize"
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(
      "https://playashatlas.com/play/?apple_auth=provider_error"
    );
  });
});

async function callbackApp(cancel: ReturnType<typeof vi.fn>) {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  registerAuthRoutes(
    app,
    {} as AuthService,
    {} as OnboardingService,
    { APP_PUBLIC_ORIGIN: "https://playashatlas.com" } as AppConfig,
    { finalizeAccountConnections: vi.fn(async () => undefined) },
    undefined,
    { enabled: true, cancel } as unknown as AppleAuthService
  );
  await app.ready();
  return app;
}
