import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { afterEach,describe,expect,it,vi } from "vitest";
import { DEFAULT_NATIVE_PUSH_PREFERENCES } from "@ash-atlas/shared";
import { installAuthGuard } from "../auth/authGuard.js";
import { AuthError } from "../auth/types.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import type { NativePushService } from "../notifications/nativePushService.js";
import { registerNativePushRoutes } from "./nativePushRoutes.js";
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async () => {await Promise.all(apps.splice(0).map((app) => app.close()));});
describe("native push route authority",() => {
  async function fixture() {
    const app=Fastify();apps.push(app);await app.register(cookie);
    const session={sessionId:"session",account:{id:"account"},player:{id:"player"},deviceInstallationId:"device",csrfToken:"csrf"};
    const register=vi.fn(async () => {});
    const auth={sessionCookieName:"session",authenticateSession:async (token:string) => token==="valid" ? session : null,
      assertOrigin:() => {},assertCsrf:(_session:unknown,token:string) => {if(token!=="csrf") throw new AuthError("AUTHENTICATION_REQUIRED","CSRF required",403);},requireGameplayReady:async () => {}} as unknown as AuthService;
    installAuthGuard(app,{...loadConfig({NODE_ENV:"test"}),AUTH_REQUIRED:true},auth);
    registerNativePushRoutes(app,{register,status:async () => ({available:true,binding:null,preferences:DEFAULT_NATIVE_PUSH_PREFERENCES})} as unknown as NativePushService);
    await app.ready();return {app,register,session};
  }
  it("does not treat the native header or submitted account IDs as authentication",async () => {
    const {app,register}=await fixture();
    const payload={token:"a".repeat(64),platform:"ios",expectedEpoch:0,expectedTokenVersion:0};
    expect((await app.inject({method:"POST",url:"/api/native-push/register",headers:{"x-ash-atlas-native-client":"capacitor-ios"},payload})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/native-push/register",headers:{cookie:"session=valid","x-ash-atlas-native-client":"capacitor-ios"},payload})).statusCode).toBe(403);
    expect(register).not.toHaveBeenCalled();
  });
  it("derives the binding owner from the authenticated native session and rejects extra authority fields",async () => {
    const {app,register,session}=await fixture();
    const headers={cookie:"session=valid","x-csrf-token":"csrf","x-ash-atlas-native-client":"capacitor-ios"};
    const payload={token:"a".repeat(64),platform:"ios",expectedEpoch:0,expectedTokenVersion:0};
    expect((await app.inject({method:"POST",url:"/api/native-push/register",headers,payload:{...payload,playerId:"victim"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/native-push/register",headers,payload})).statusCode).toBe(200);
    expect(register).toHaveBeenCalledExactlyOnceWith(session,payload);
  });
});
