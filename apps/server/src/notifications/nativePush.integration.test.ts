import { randomUUID } from "node:crypto";
import { copyFile,mkdtemp,readdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { DisposableTestPool } from "../db/disposableTestPool.js";
import { loadConfig } from "../config.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { NativePushService } from "./nativePushService.js";
import { enqueueNativePush } from "./nativePushOutbox.js";
import { DEFAULT_NATIVE_PUSH_PREFERENCES } from "@ash-atlas/shared";
import type { AppLogger } from "../logger.js";
import { NativePushWorker,sourceStillRelevant } from "./nativePushWorker.js";
import type { PushEnvelope,PushSender,PushSendResult } from "./nativePushProviders.js";
import { PlayerPackageService } from "../game/playerPackages.js";
import { DirectMessageService } from "../directMessages/directMessageService.js";
import { PostgresPartyAuthority } from "../game/party/PostgresPartyAuthority.js";

const adminUrl=process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const databaseSuite=adminUrl ? describe : describe.skip;
databaseSuite("native push populated migration and durable race guards",() => {
  const databaseName=`ash_atlas_stability_native_push_${randomUUID().replaceAll("-","").slice(0,12)}`;
  let admin:pg.Pool;
  let pool:DisposableTestPool;
  let directory="";
  let databaseUrl="";
  let service:NativePushService;
  const accountId=randomUUID(),deviceId=randomUUID(),sessionId=randomUUID(),identityId=randomUUID();
  const playerId="retained-native-player";
  const session={sessionId,account:{id:accountId},player:{id:playerId},deviceInstallationId:deviceId,csrfToken:"fixture-csrf"} as AuthenticatedSession;
  beforeAll(async () => {
    const url=new URL(adminUrl!);
    if(!["127.0.0.1","localhost"].includes(url.hostname) || url.pathname!=="/ash_atlas_stability" || !["postgres:","postgresql:"].includes(url.protocol)) throw new Error("Native push tests require local disposable ash_atlas_stability admin");
    admin=new pg.Pool({connectionString:adminUrl,max:1});
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    url.pathname=`/${databaseName}`; databaseUrl=url.toString();
    directory=await mkdtemp(path.join(tmpdir(),"ash-atlas-native-push-"));
    const migrations=path.resolve(process.cwd(),"../../db/migrations");
    for(const file of await readdir(migrations)) {
      if(file.endsWith(".sql") && file.localeCompare("0860_")<0) await copyFile(path.join(migrations,file),path.join(directory,file));
    }
    await runMigrations(databaseUrl,{migrationsDirectory:directory});
    pool=new DisposableTestPool({connectionString:databaseUrl,max:10});
    await pool.query("INSERT INTO accounts(id,trust_tier,test_access_status) VALUES($1,'standard','approved')",[accountId]);
    await pool.query("INSERT INTO account_identities(id,account_id,provider,provider_subject,email,email_verified) VALUES($1,$2,'google',$3,'fixture@example.invalid',true)",[identityId,accountId,randomUUID()]);
    await pool.query("INSERT INTO players(id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom) VALUES($1,$2,'Preserved Ranger','GLOBAL',1,2,1,2,1250,false,ST_SetSRID(ST_MakePoint(2,1),4326))",[playerId,accountId]);
    await pool.query("INSERT INTO device_installations(id,token_hash) VALUES($1,$2)",[deviceId,randomUUID()]);
    await pool.query("INSERT INTO auth_sessions(id,account_id,identity_id,device_installation_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day')",[sessionId,accountId,identityId,deviceId,randomUUID()]);
    await pool.query("INSERT INTO apple_auth_transactions(id,state_hash,nonce_hash,intent,return_path,expires_at) VALUES($1,$2,$3,'signin','/play/',now()+interval '5 minutes')",[randomUUID(),"a".repeat(64),"b".repeat(64)]);
    await copyFile(path.join(migrations,"0860_native_push_and_apple_return.sql"),path.join(directory,"0860_native_push_and_apple_return.sql"));
    expect(await runMigrations(databaseUrl,{migrationsDirectory:directory})).toEqual(["0860_native_push_and_apple_return.sql"]);
    service=new NativePushService(pool,loadConfig({NODE_ENV:"test",NATIVE_PUSH_REGISTRATION_ENABLED:"true",NATIVE_PUSH_ACCOUNT_ALLOWLIST:accountId,NATIVE_PUSH_CATEGORY_ALLOWLIST:"package",NATIVE_PUSH_TOKEN_KEY_ID:"fixture",NATIVE_PUSH_TOKEN_KEY_BASE64:Buffer.alloc(32,7).toString("base64")}));
  },120_000);
  afterAll(async () => {
    await pool?.end();
    if(admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);await admin.end(); }
    if(directory) await rm(directory,{recursive:true,force:true});
  });
  it("preserves populated players, sessions, Apple web returns and has an empty second migration run",async () => {
    expect((await pool.query("SELECT username,lat,lon,account_id FROM players WHERE id=$1",[playerId])).rows).toEqual([{username:"Preserved Ranger",lat:1,lon:2,account_id:accountId}]);
    expect((await pool.query("SELECT account_id,identity_id,revoked_at FROM auth_sessions WHERE id=$1",[sessionId])).rows).toEqual([{account_id:accountId,identity_id:identityId,revoked_at:null}]);
    expect((await pool.query("SELECT intent,return_path,state_hash,nonce_hash,native_return,native_return_state FROM apple_auth_transactions")).rows).toEqual([{intent:"signin",return_path:"/play/",state_hash:"a".repeat(64),nonce_hash:"b".repeat(64),native_return:false,native_return_state:null}]);
    expect((await pool.query("SELECT native_push_session_id FROM device_installations WHERE id=$1",[deviceId])).rows[0].native_push_session_id).toBe(sessionId);
    expect(await runMigrations(databaseUrl,{migrationsDirectory:directory})).toEqual([]);
  });
  it("keeps epoch and token revisions separate and rejects stale token callbacks",async () => {
    await service.register(session,{platform:"ios",token:"a".repeat(64),expectedEpoch:0,expectedTokenVersion:0});
    const initial=(await service.status(session)).binding!;
    expect(initial).toMatchObject({epoch:1,tokenVersion:1,enabled:true});
    await service.register(session,{platform:"ios",token:"b".repeat(64),expectedEpoch:initial.epoch,expectedTokenVersion:initial.tokenVersion});
    await expect(service.register(session,{platform:"ios",token:"a".repeat(64),expectedEpoch:1,expectedTokenVersion:1})).rejects.toMatchObject({statusCode:409});
    expect((await service.status(session)).binding).toMatchObject({epoch:1,tokenVersion:2});
  });
  it("accepts only one concurrent preference writer and never overwrites a newer opt-out",async () => {
    await service.setPreferences(session,{...DEFAULT_NATIVE_PUSH_PREFERENCES,enabled:true});
    const preferences=await service.preferences(playerId);
    const results=await Promise.allSettled([
      service.setPreferences(session,{...preferences,enabled:false}),
      service.setPreferences(session,{...preferences,quietStart:1320,quietEnd:480})
    ]);
    expect(results.filter((value) => value.status==="fulfilled")).toHaveLength(1);
    const latest=await service.preferences(playerId);
    await service.setPreferences(session,{...latest,enabled:false});
    await expect(service.setPreferences(session,{...preferences,enabled:true})).rejects.toMatchObject({statusCode:409});
    expect((await service.preferences(playerId)).enabled).toBe(false);
  });
  it("makes enqueue rollback and duplicate event replay follow the source transaction",async () => {
    await service.setPreferences(session,{...await service.preferences(playerId),enabled:true});
    const client=await pool.connect();
    const event={enabled:true,audience:{accounts:[accountId],kinds:["package" as const]},kind:"package" as const,playerId,sourceId:randomUUID(),eventKey:"fixture-package"};
    try {
      await client.query("BEGIN");await enqueueNativePush(client,event);await client.query("ROLLBACK");
      expect((await pool.query("SELECT id FROM native_push_deliveries WHERE event_key=$1",[event.eventKey])).rowCount).toBe(0);
      await client.query("BEGIN");await enqueueNativePush(client,event);await enqueueNativePush(client,event);await client.query("COMMIT");
      expect((await pool.query("SELECT id FROM native_push_deliveries WHERE event_key=$1",[event.eventKey])).rowCount).toBe(1);
    } finally {client.release();}
  });
  it("invalidates bindings on same-timestamp session replacement and rejects the old account's delayed registration",async () => {
    const replacementId=randomUUID();
    await pool.query("INSERT INTO auth_sessions(id,account_id,identity_id,device_installation_id,created_at,token_hash,expires_at) SELECT $1,account_id,identity_id,device_installation_id,created_at,$3,expires_at FROM auth_sessions WHERE id=$2",[replacementId,sessionId,randomUUID()]);
    const stale=await service.status(session);
    expect(stale.binding?.enabled).toBe(false);
    await expect(service.register(session,{platform:"ios",token:"old".repeat(32),expectedEpoch:stale.binding!.epoch,expectedTokenVersion:stale.binding!.tokenVersion})).rejects.toMatchObject({statusCode:409});
    const replacement={...session,sessionId:replacementId};
    await service.register(replacement,{platform:"ios",token:"new".repeat(32),expectedEpoch:stale.binding!.epoch,expectedTokenVersion:stale.binding!.tokenVersion});
    const registered=(await service.status(replacement)).binding!;
    await pool.query("UPDATE auth_sessions SET revoked_at=now(),revoke_reason='logout' WHERE id=$1",[replacementId]);
    expect((await service.status(replacement)).binding).toMatchObject({enabled:false,epoch:registered.epoch+1});
    await expect(service.register(replacement,{platform:"ios",token:"late".repeat(32),expectedEpoch:registered.epoch,expectedTokenVersion:registered.tokenVersion})).rejects.toMatchObject({statusCode:409});
  });
  async function freshSession():Promise<AuthenticatedSession> {
    const nextDevice=randomUUID(),nextSession=randomUUID();
    await pool.query("INSERT INTO device_installations(id,token_hash) VALUES($1,$2)",[nextDevice,randomUUID()]);
    await pool.query("INSERT INTO auth_sessions(id,account_id,identity_id,device_installation_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 day')",[nextSession,accountId,identityId,nextDevice,randomUUID()]);
    return {...session,sessionId:nextSession,deviceInstallationId:nextDevice};
  }
  it("accepts only one simultaneous token revision writer",async () => {
    const current=await freshSession();
    await service.register(current,{platform:"ios",token:randomUUID().replaceAll("-","").repeat(2),expectedEpoch:0,expectedTokenVersion:0});
    const results=await Promise.allSettled(["c","d"].map((token) => service.register(current,{platform:"ios",token:token.repeat(64),expectedEpoch:1,expectedTokenVersion:1})));
    expect(results.filter((result) => result.status==="fulfilled")).toHaveLength(1);
    expect((await service.status(current)).binding).toMatchObject({epoch:1,tokenVersion:2,enabled:true});
  });
  it("never creates an enabled binding when revocation wins before initial registration",async () => {
    const current=await freshSession(),revoker=await pool.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query("UPDATE auth_sessions SET revoked_at=now(),revoke_reason='fixture_logout' WHERE id=$1",[current.sessionId]);
      const registration=service.register(current,{platform:"ios",token:"e".repeat(64),expectedEpoch:0,expectedTokenVersion:0});
      const rejected=expect(registration).rejects.toMatchObject({statusCode:409});
      await vi.waitFor(async () => expect((await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid() AND query LIKE 'SELECT id FROM auth_sessions%'
        AND cardinality(pg_blocking_pids(pid))>0`)).rows[0].count).toBe(1));
      await revoker.query("COMMIT");await rejected;
      expect((await pool.query("SELECT id FROM native_push_bindings WHERE session_id=$1 AND enabled",[current.sessionId])).rowCount).toBe(0);
    } finally {await revoker.query("ROLLBACK");revoker.release();}
  });
  it("keeps one owner when two installations register the same provider token concurrently",async () => {
    const first=await freshSession(),second=await freshSession();
    const token="f".repeat(64);
    const results=await Promise.allSettled([first,second].map((current) => service.register(current,{platform:"ios",token,expectedEpoch:0,expectedTokenVersion:0})));
    expect(results.some((result) => result.status==="fulfilled")).toBe(true);
    expect((await pool.query("SELECT id FROM native_push_bindings WHERE session_id=ANY($1::uuid[]) AND enabled",[[first.sessionId,second.sessionId]])).rowCount).toBe(1);
  });
  const audience={accounts:[accountId],kinds:["direct_message","party_invite","kingdom_invite","package"] as const};
  it("serializes simultaneous native sessions by the installation row, not timestamp or UUID order",async () => {
    const current=await freshSession(),first=await pool.connect(),second=await pool.connect();
    const firstId=randomUUID(),secondId=randomUUID();
    const insert="INSERT INTO auth_sessions(id,account_id,identity_id,device_installation_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,'2026-01-01',now()+interval '1 day')";
    try {
      await first.query("BEGIN");await second.query("BEGIN");
      await first.query(insert,[firstId,accountId,identityId,current.deviceInstallationId,randomUUID()]);
      const pid=(await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const waiting=second.query(insert,[secondId,accountId,identityId,current.deviceInstallationId,randomUUID()]);
      await vi.waitFor(async () => expect((await pool.query("SELECT cardinality(pg_blocking_pids($1)) AS count",[pid])).rows[0].count).toBeGreaterThan(0));
      await first.query("COMMIT");await waiting;await second.query("COMMIT");
      expect((await pool.query("SELECT native_push_session_id FROM device_installations WHERE id=$1",[current.deviceInstallationId])).rows[0].native_push_session_id).toBe(secondId);
      await expect(service.register({...current,sessionId:firstId},{platform:"ios",token:"stale".repeat(16),expectedEpoch:0,expectedTokenVersion:0})).rejects.toMatchObject({statusCode:409});
    } finally {await first.query("ROLLBACK");await second.query("ROLLBACK");first.release();second.release();}
  });
  it("keeps reset authoritative against a simultaneous token refresh",async () => {
    const current=await freshSession();
    await service.register(current,{platform:"ios",token:randomUUID().replaceAll("-","").repeat(2),expectedEpoch:0,expectedTokenVersion:0});
    const results=await Promise.allSettled([
      service.reset(current,1),
      service.register(current,{platform:"ios",token:randomUUID().replaceAll("-","").repeat(2),expectedEpoch:1,expectedTokenVersion:1})
    ]);
    expect(results[0]!.status).toBe("fulfilled");
    expect((await service.status(current)).binding).toMatchObject({enabled:false,epoch:2});
  });
  const logger={info:vi.fn(),warn:vi.fn()} as unknown as AppLogger;
  async function workerFixture() {
    // All rows belong exclusively to this randomized disposable fixture database.
    await pool.query("DELETE FROM native_push_deliveries");
    await pool.query("UPDATE native_push_bindings SET enabled=false,token_hash=NULL,token_encrypted=NULL");
    await pool.query("UPDATE accounts SET test_access_status='approved' WHERE id=$1",[accountId]);
    service.config.NATIVE_PUSH_DELIVERY_ENABLED=true;
    service.config.NATIVE_PUSH_ACCOUNT_ALLOWLIST=[accountId];
    service.config.NATIVE_PUSH_CATEGORY_ALLOWLIST=[...audience.kinds];
    await service.setPreferences(session,{...DEFAULT_NATIVE_PUSH_PREFERENCES,revision:(await service.preferences(playerId)).revision,enabled:true});
    const current=await freshSession();
    await service.register(current,{platform:"ios",token:randomUUID().replaceAll("-","").repeat(2),expectedEpoch:0,expectedTokenVersion:0});
    const packages=new PlayerPackageService(pool,{pushEnqueueEnabled:true,pushAudience:audience});
    const input={operationKey:randomUUID(),targetMode:"specific" as const,recipientPlayerIds:[playerId],title:"Disposable worker proof",message:"",items:[{itemKind:"gold" as const,itemId:"gold" as const,quantity:1}]};
    const result=await packages.createCampaign({subject:"fixture",playerId},input);
    const packageId=result.packages[0]!.packageId;
    const delivery=(await pool.query<{id:string;binding_id:string}>("SELECT id,binding_id FROM native_push_deliveries WHERE source_id=$1",[packageId])).rows[0]!;
    expect(delivery).toBeDefined();
    return {current,packageId,delivery,packages,input};
  }
  function pausedSender() {
    let release!:()=>void;
    const ready=new Promise<void>((resolve) => {release=resolve;});
    const transmitted=vi.fn();
    const send:PushSender=vi.fn(async (message:PushEnvelope):Promise<PushSendResult> => {
      await ready;
      if(!await message.beforeDispatch()) return {outcome:"suppressed",code:"state_changed"};
      transmitted(message.id);return {outcome:"sent",code:"accepted"};
    });
    return {send,release,transmitted};
  }
  it("atomically creates package outbox rows, deduplicates replay and serializes two real workers",async () => {
    const f=await workerFixture();
    const replay=await f.packages.createCampaign({subject:"fixture",playerId},f.input);
    expect(replay.replayed).toBe(true);
    expect((await pool.query("SELECT id FROM native_push_deliveries")).rowCount).toBe(1);
    await f.packages.createCampaign({subject:"fixture",playerId},{...f.input,operationKey:randomUUID()});
    expect((await pool.query("SELECT id FROM native_push_deliveries WHERE binding_id=$1",[f.delivery.binding_id])).rowCount).toBe(2);
    const provider=pausedSender();
    const first=new NativePushWorker(service,provider.send,logger),second=new NativePushWorker(service,provider.send,logger);
    const pending=first.tick();await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
    await second.tick();expect(provider.send).toHaveBeenCalledOnce();
    provider.release();await pending;
    expect(provider.transmitted).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT status,attempts FROM native_push_deliveries WHERE binding_id=$1",[f.delivery.binding_id])).rows).toEqual([{status:"sent",attempts:1},{status:"sent",attempts:1}]);
  });
  it("rolls back actual package persistence if transactional outbox insertion fails",async () => {
    const f=await workerFixture(),operationKey=randomUUID();
    await pool.query(`CREATE FUNCTION fixture_reject_push() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $$;
      CREATE TRIGGER fixture_reject_push BEFORE INSERT ON native_push_deliveries FOR EACH ROW EXECUTE FUNCTION fixture_reject_push()`);
    try {
      await expect(f.packages.createCampaign({subject:"fixture",playerId},{...f.input,operationKey})).rejects.toThrow("fixture outbox failure");
      expect((await pool.query("SELECT id FROM player_package_campaigns WHERE operation_key=$1",[operationKey])).rowCount).toBe(0);
      expect((await pool.query("SELECT id FROM native_push_deliveries")).rowCount).toBe(1);
    } finally {await pool.query("DROP TRIGGER fixture_reject_push ON native_push_deliveries; DROP FUNCTION fixture_reject_push()");}
  });
  it("fences a paused worker after its expired lease is reclaimed",async () => {
    const f=await workerFixture(),old=pausedSender();
    const pending=new NativePushWorker(service,old.send,logger).tick();await vi.waitFor(() => expect(old.send).toHaveBeenCalledOnce());
    await pool.query("UPDATE native_push_deliveries SET leased_until=now()-interval '1 second' WHERE id=$1",[f.delivery.id]);
    const newer=pausedSender();newer.release();await new NativePushWorker(service,newer.send,logger).tick();
    old.release();await pending;
    expect(old.transmitted).not.toHaveBeenCalled();expect(newer.transmitted).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT status,attempts FROM native_push_deliveries WHERE id=$1",[f.delivery.id])).rows[0]).toEqual({status:"sent",attempts:2});
  });
  it.each(["logout","token","preferences","read","access","inactivity","cohort","category"])("rechecks real current %s state after provider credential delay",async (change) => {
    const f=await workerFixture(),provider=pausedSender();
    const pending=new NativePushWorker(service,provider.send,logger).tick();await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
    if(change==="logout") await pool.query("UPDATE auth_sessions SET revoked_at=now(),revoke_reason='fixture_logout' WHERE id=$1",[f.current.sessionId]);
    if(change==="token") await service.register(f.current,{platform:"ios",token:randomUUID().replaceAll("-","").repeat(2),expectedEpoch:1,expectedTokenVersion:1});
    if(change==="preferences") await service.setPreferences(f.current,{...await service.preferences(playerId),enabled:false});
    if(change==="read") await pool.query("UPDATE player_packages SET read_at=now() WHERE id=$1",[f.packageId]);
    if(change==="access") await pool.query("UPDATE accounts SET test_access_status='revoked' WHERE id=$1",[accountId]);
    if(change==="inactivity") await pool.query("UPDATE auth_sessions SET last_seen_at=now()-interval '15 days' WHERE id=$1",[f.current.sessionId]);
    if(change==="cohort") service.config.NATIVE_PUSH_ACCOUNT_ALLOWLIST=[];
    if(change==="category") service.config.NATIVE_PUSH_CATEGORY_ALLOWLIST=[];
    provider.release();await pending;
    expect(provider.transmitted).not.toHaveBeenCalled();
    expect((await pool.query("SELECT status FROM native_push_deliveries WHERE id=$1",[f.delivery.id])).rows[0].status).toBe("suppressed");
  });
  it("retains a live lease after ambiguous submission and parses the token invalidation path",async () => {
    const f=await workerFixture();
    const retry:PushSender=vi.fn(async (message:PushEnvelope):Promise<PushSendResult> => {expect(await message.beforeDispatch()).toBe(true);return {outcome:"retry",code:"provider_timeout"};});
    await new NativePushWorker(service,retry,logger).tick();
    const row=(await pool.query("SELECT status,leased_until>now() AS protected,next_attempt_at>=leased_until AS delayed FROM native_push_deliveries WHERE id=$1",[f.delivery.id])).rows[0];
    expect(row).toEqual({status:"pending",protected:true,delayed:true});
    await new NativePushWorker(service,retry,logger).tick();expect(retry).toHaveBeenCalledOnce();
    await pool.query("UPDATE native_push_deliveries SET leased_until=now()-interval '1 second',next_attempt_at=now() WHERE id=$1",[f.delivery.id]);
    const invalid:PushSender=async (message) => {expect(await message.beforeDispatch()).toBe(true);return {outcome:"invalid_token",code:"invalid_token"};};
    await new NativePushWorker(service,invalid,logger).tick();
    expect((await service.status(f.current)).binding).toMatchObject({enabled:false,tokenVersion:2});
  });
  async function senderPlayer():Promise<string> {
    const id=randomUUID();
    await pool.query("INSERT INTO players(id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom) VALUES($1,$2,'GLOBAL',1,2,1,2,1250,false,ST_SetSRID(ST_MakePoint(2,1),4326))",[id,`Sender ${id.slice(0,8)}`]);
    return id;
  }
  it("executes the durable DM enqueue and current read-state SQL against canonical tables",async () => {
    await workerFixture();await pool.query("DELETE FROM native_push_deliveries");
    const sender=await senderPlayer(),messages=new DirectMessageService(pool,{pushEnqueueEnabled:true,pushAudience:audience});
    const message=await messages.send({senderPlayerId:sender,recipientPlayerId:playerId,clientMessageId:randomUUID(),body:"Disposable private text"});
    const delivery={kind:"direct_message",source_id:message.message.id,player_id:playerId};
    expect((await pool.query("SELECT id FROM native_push_deliveries WHERE source_id=$1",[delivery.source_id])).rowCount).toBe(1);
    expect(await sourceStillRelevant(pool,delivery)).toBe(true);
    const provider=pausedSender(),pending=new NativePushWorker(service,provider.send,logger).tick();
    await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
    const conversation=await messages.openConversation(playerId,sender);
    await messages.markRead(playerId,conversation.id,message.message.sequence);
    expect(await sourceStillRelevant(pool,delivery)).toBe(false);
    provider.release();await pending;expect(provider.transmitted).not.toHaveBeenCalled();
    expect((await pool.query("SELECT status FROM native_push_deliveries WHERE source_id=$1",[delivery.source_id])).rows[0].status).toBe("suppressed");
  });
  it.each(["party_invite","kingdom_invite"])("suppresses only the exact read revision for %s",async (kind) => {
    await workerFixture();await pool.query("DELETE FROM native_push_deliveries");
    const sender=await senderPlayer(),id=randomUUID();
    let sourceId=id;
    if(kind==="party_invite") {
      const party=new PostgresPartyAuthority(pool,true,audience);await party.initialize();
      try {
        await party.createParty(randomUUID(),sender,randomUUID());
        await party.inviteMember(playerId,sender,randomUUID());
        sourceId=(await pool.query("SELECT id FROM party_invites WHERE invited_by_player_id=$1 AND target_player_id=$2",[sender,playerId])).rows[0].id;
        expect((await pool.query("SELECT id FROM native_push_deliveries WHERE source_id=$1",[sourceId])).rowCount).toBe(1);
      } finally {await party.close();}
    } else {
      const kingdomId=randomUUID();
      await pool.query("INSERT INTO kingdoms(id,normalized_name,display_name,founder_player_id,leader_player_id,founding_request_id) VALUES($1,$2,'Fixture Kingdom',$3,$3,$4)",[kingdomId,`fixture ${kingdomId.slice(0,8)}`,sender,randomUUID()]);
      await pool.query("INSERT INTO kingdom_invitations(id,kingdom_id,target_player_id,invited_by_player_id,request_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes')",[id,kingdomId,playerId,sender,randomUUID()]);
      await enqueueNativePush(pool,{enabled:true,audience,kind:"kingdom_invite",playerId,sourceId:id,eventKey:`kingdom:${id}`});
    }
    const delivery={kind,source_id:sourceId,player_id:playerId};
    expect(await sourceStillRelevant(pool,delivery)).toBe(true);
    const provider=pausedSender(),pending=new NativePushWorker(service,provider.send,logger).tick();
    await vi.waitFor(() => expect(provider.send).toHaveBeenCalledOnce());
    const table=kind==="party_invite" ? "party_invites":"kingdom_invitations";
    const revision=kind==="party_invite" ? "updated_at":"created_at";
    const timestamp=(await pool.query(`SELECT ${revision} AS revision FROM ${table} WHERE id=$1`,[sourceId])).rows[0].revision as Date;
    const entryKey=`${kind==="party_invite" ? "party":"kingdom"}:${sourceId}`;
    await pool.query("INSERT INTO player_inbox_read_receipts(player_id,entry_key,read_revision) VALUES($1,$2,$3)",[playerId,entryKey,timestamp.toISOString()]);
    expect(await sourceStillRelevant(pool,delivery)).toBe(false);
    provider.release();await pending;expect(provider.transmitted).not.toHaveBeenCalled();
    expect((await pool.query("SELECT status FROM native_push_deliveries WHERE source_id=$1",[sourceId])).rows[0].status).toBe("suppressed");
    await pool.query("UPDATE player_inbox_read_receipts SET read_revision=$3 WHERE player_id=$1 AND entry_key=$2",[playerId,entryKey,new Date(timestamp.getTime()-1).toISOString()]);
    expect(await sourceStillRelevant(pool,delivery)).toBe(true);
  });
});
