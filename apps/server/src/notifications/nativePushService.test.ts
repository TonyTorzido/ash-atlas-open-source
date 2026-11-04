import { describe,expect,it,vi } from "vitest";
import type pg from "pg";
import type { AuthenticatedSession } from "../auth/types.js";
import { DEFAULT_NATIVE_PUSH_PREFERENCES,nativePushRegistrationSchema } from "@ash-atlas/shared";
import { loadConfig } from "../config.js";
import { isNativePushAccountAllowed,isPushQuietTime,NativePushService } from "./nativePushService.js";
import { enqueueNativePush } from "./nativePushOutbox.js";
describe("native push private binding contracts",() => {
  it("requires an explicit account cohort and category at enqueue, status and registration",async () => {
    const account="00000000-0000-4000-8000-000000000111";
    const config=loadConfig({NODE_ENV:"test",NATIVE_PUSH_REGISTRATION_ENABLED:"true",NATIVE_PUSH_TOKEN_KEY_ID:"test",NATIVE_PUSH_TOKEN_KEY_BASE64:Buffer.alloc(32).toString("base64")});
    expect(config.NATIVE_PUSH_ACCOUNT_ALLOWLIST).toEqual([]);
    expect(config.NATIVE_PUSH_CATEGORY_ALLOWLIST).toEqual(["direct_message"]);
    const query=vi.fn(async () => ({rows:[],rowCount:0}));
    const service=new NativePushService({query} as unknown as pg.Pool,config);
    const session={account:{id:account},player:{id:"player"},deviceInstallationId:"device",sessionId:"session"} as AuthenticatedSession;
    expect((await service.status(session)).available).toBe(false);
    await expect(service.register(session,{platform:"ios",token:"a".repeat(64),expectedEpoch:0,expectedTokenVersion:0})).rejects.toMatchObject({statusCode:503});
    config.NATIVE_PUSH_ACCOUNT_ALLOWLIST.push(account);
    expect(isNativePushAccountAllowed(config,account)).toBe(true);expect((await service.status(session)).available).toBe(true);
    query.mockClear();
    const event={enabled:true,kind:"package" as const,playerId:"player",sourceId:"source",eventKey:"event"};
    await enqueueNativePush({query} as unknown as pg.PoolClient,event);
    await enqueueNativePush({query} as unknown as pg.PoolClient,{...event,audience:{accounts:[account],kinds:["direct_message"]}});
    expect(query).not.toHaveBeenCalled();
    await enqueueNativePush({query} as unknown as pg.PoolClient,{...event,audience:{accounts:[account],kinds:["package"]}});
    expect(query).toHaveBeenCalledWith(expect.stringContaining("b.account_id=ANY($7::uuid[])"),expect.arrayContaining([[account]]));
    config.NATIVE_PUSH_ACCOUNT_ALLOWLIST=[];
    expect((await service.status(session)).available).toBe(false);
    await expect(service.register(session,{platform:"ios",token:"a".repeat(64),expectedEpoch:0,expectedTokenVersion:0})).rejects.toMatchObject({statusCode:503});
  });
  it("defaults all server switches off and does not enqueue",async () => {
    const config=loadConfig({NODE_ENV:"test"});
    expect([config.NATIVE_PUSH_REGISTRATION_ENABLED,config.NATIVE_PUSH_ENQUEUE_ENABLED,config.NATIVE_PUSH_DELIVERY_ENABLED]).toEqual([false,false,false]);
    const query=vi.fn();
    await enqueueNativePush({query} as unknown as pg.PoolClient,{enabled:false,kind:"package",playerId:"player",sourceId:"source",eventKey:"event"});
    expect(query).not.toHaveBeenCalled();
  });
  it("encrypts provider tokens with authenticated versioned material and fails closed on a wrong key",() => {
    const config=loadConfig({NODE_ENV:"test",NATIVE_PUSH_TOKEN_KEY_ID:"fixture",NATIVE_PUSH_TOKEN_KEY_BASE64:Buffer.alloc(32,1).toString("base64")});
    const service=new NativePushService({} as pg.Pool,config);
    const token="not-a-real-provider-token";
    const encrypted=service.encryptToken(token);
    expect(JSON.stringify(encrypted)).not.toContain(token);
    expect(service.decryptToken(encrypted)).toBe(token);
    expect(() => service.decryptToken({...encrypted,keyId:"wrong"})).toThrow();
    expect(() => service.decryptToken({...encrypted,tag:Buffer.alloc(16).toString("base64")})).toThrow();
  });
  it("checks local-time quiet hours across midnight and daylight-saving offsets",() => {
    const preferences={...DEFAULT_NATIVE_PUSH_PREFERENCES,quietStart:1320,quietEnd:480,timeZone:"America/Denver"};
    expect(isPushQuietTime(preferences,new Date("2026-07-01T05:00:00Z"))).toBe(true);
    expect(isPushQuietTime(preferences,new Date("2026-07-01T18:00:00Z"))).toBe(false);
    expect(isPushQuietTime({...preferences,quietStart:0,quietEnd:0})).toBe(true);
  });
  it("rejects untrusted account IDs, destinations, and missing token revision",() => {
    expect(nativePushRegistrationSchema.safeParse({token:"a".repeat(64),platform:"ios",expectedEpoch:1}).success).toBe(false);
    expect(nativePushRegistrationSchema.safeParse({token:"a".repeat(64),platform:"ios",expectedEpoch:1,expectedTokenVersion:1,accountId:"someone-else"}).success).toBe(false);
  });
});
