import { expect,it,vi } from "vitest";
const recorded=vi.hoisted(() => vi.fn());
vi.mock("@capacitor/core",() => ({Capacitor:{isNativePlatform:() => true,getPlatform:() => "ios"}}));
vi.mock("../config.js",() => ({clientConfig:{nativeVersion:"1.0.0",nativeBuild:7,buildSha:"12345678901234567890"}}));
vi.mock("../diagnostics/bugReportDiagnostics.js",() => ({bugReportDiagnostics:{recordNativeBoundary:recorded}}));
import { recordNativeDiagnostic } from "./nativeDiagnostics.js";
it("correlates allowlisted events with only public build identity in existing diagnostics",() => {
  recordNativeDiagnostic("launch");recordNativeDiagnostic("auth_request_failed");
  expect(recorded.mock.calls[0]?.[0]).toBe("launch:ios:1.0.0:7:123456789012");
  expect(recorded.mock.calls[1]?.[0]).toBe("auth_request_failed:ios:1.0.0:7:123456789012");
  expect(recorded.mock.calls[0]?.[1]).toMatch(/^native:[a-f0-9-]+$/);
  expect(recorded.mock.calls[1]?.[1]).toBe(recorded.mock.calls[0]?.[1]);
});
