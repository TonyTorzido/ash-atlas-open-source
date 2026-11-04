// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
const native=vi.hoisted(() => ({ request:vi.fn(),listener:undefined as undefined | ((value:{url:string})=>void),remove:vi.fn(async () => {}),open:vi.fn(async () => {}),close:vi.fn(async () => {}) }));
vi.mock("@capacitor/app",() => ({ App:{ addListener:vi.fn(async (_name:string,listener:(value:{url:string})=>void) => { native.listener=listener;return {remove:native.remove}; }) } }));
vi.mock("@capacitor/browser",() => ({ Browser:{open:native.open,close:native.close,addListener:vi.fn(async () => ({remove:native.remove}))} }));
vi.mock("./nativeRequest.js",() => ({nativeAuthRequest:native.request}));
import { linkAppleInNativeBrowser } from "./nativeAppleLink.js";
afterEach(() => {vi.clearAllMocks();});
describe("native Apple linking return",() => {
  it("ignores an old return and verifies a matching return against the authenticated server",async () => {
    native.request.mockResolvedValueOnce(new Response(JSON.stringify({authorizationUrl:"https://appleid.apple.com/auth/authorize"}))).mockResolvedValueOnce(new Response(JSON.stringify({status:"linked"})));
    const work=linkAppleInNativeBrowser("https://playashatlas.com","csrf");
    await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
    native.listener!({url:`com.ashatlas.game://auth/apple-link?state=${"x".repeat(43)}&outcome=completed`});
    expect(native.request).toHaveBeenCalledTimes(1);
    const state=JSON.parse(native.request.mock.calls[0]![1].body).nativeReturnState;
    native.listener!({url:`com.ashatlas.game://auth/apple-link?state=${state}&outcome=completed`});
    await work;
    expect(String(native.request.mock.calls[1]![0])).toContain(`/api/auth/apple/link/status?state=${state}`);
    expect(native.close).toHaveBeenCalledOnce();
  });
  it("does not trust a completed URL when the current server session rejects the result",async () => {
    native.request.mockResolvedValueOnce(new Response(JSON.stringify({authorizationUrl:"https://appleid.apple.com/auth/authorize"}))).mockResolvedValueOnce(new Response(JSON.stringify({error:{message:"not current account"}}),{status:409}));
    const work=linkAppleInNativeBrowser("https://playashatlas.com","csrf");
    const rejected=expect(work).rejects.toThrow("not confirmed");
    await vi.waitFor(() => expect(native.open).toHaveBeenCalledOnce());
    const state=JSON.parse(native.request.mock.calls[0]![1].body).nativeReturnState;
    native.listener!({url:`com.ashatlas.game://auth/apple-link?state=${state}&outcome=completed`});
    await rejected;
  });
});
