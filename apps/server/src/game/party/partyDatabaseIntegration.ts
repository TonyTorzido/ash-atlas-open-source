import { loadConfig } from "../../config.js";
import { createPool } from "../../db/pool.js";
import { PartyAuthorityError } from "./PartyAuthority.js";
import { PostgresPartyAuthority } from "./PostgresPartyAuthority.js";

const suffix = crypto.randomUUID();
const basePlayerIds = [
  "leader-a",
  "leader-b",
  "target",
  "member",
  "other-target",
  "decline-target",
  "create-target",
  "full-member-a",
  "full-member-b",
  "full-member-c",
  "full-member-d",
  "capacity-pending-target",
  "capacity-new-target",
  "atomic-leader",
  "atomic-target"
].map((id) => `party-integration-${id}-${suffix}`);
const [
  leaderA,
  leaderB,
  target,
  member,
  otherTarget,
  declineTarget,
  createTarget,
  fullMemberA,
  fullMemberB,
  fullMemberC,
  fullMemberD,
  capacityPendingTarget,
  capacityNewTarget,
  atomicLeader,
  atomicTarget
] = basePlayerIds as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string
];
const mergeLeaderA = `party-integration-merge-leader-a-${suffix}`;
const mergeMemberA = `party-integration-merge-member-a-${suffix}`;
const mergeMemberB = `party-integration-merge-member-b-${suffix}`;
const mergeLeaderB = `party-integration-merge-leader-b-${suffix}`;
const mergeMemberC = `party-integration-merge-member-c-${suffix}`;
const playerIds = [
  ...basePlayerIds,
  mergeLeaderA,
  mergeMemberA,
  mergeMemberB,
  mergeLeaderB,
  mergeMemberC
];
const partyA = `party:integration:a:${suffix}`;
const partyB = `party:integration:b:${suffix}`;
const targetParty = `party:integration:target:${suffix}`;
const mergePartyA = `party:integration:merge:a:${suffix}`;
const mergePartyB = `party:integration:merge:b:${suffix}`;
const partyIds = [partyA, partyB, targetParty, mergePartyA, mergePartyB];
const pool = createPool({ databaseUrl: loadConfig().DATABASE_URL });
const authorities: PostgresPartyAuthority[] = [];

try {
  for (const playerId of playerIds) await insertPlayer(playerId);

  const firstProcess = authority();
  await firstProcess.initialize();
  const contender = authority();
  await expectPartyError(contender.initialize(), "PARTY_UNAVAILABLE");

  const atomicInvite = await firstProcess.inviteToParty(
    atomicTarget,
    atomicLeader,
    "atomic-invite"
  );
  const replayedAtomicInvite = await firstProcess.inviteToParty(
    atomicTarget,
    atomicLeader,
    "atomic-invite"
  );
  assert(
    replayedAtomicInvite.invitationId === atomicInvite.invitationId,
    "atomic create-and-invite replay created a second invitation"
  );
  const atomicParty = firstProcess.partyForPlayer(atomicLeader);
  assert(
    atomicParty?.memberPlayerIds.join(",") === atomicLeader,
    "atomic create-and-invite did not persist the solo leader party"
  );
  await firstProcess.cancelInvite(atomicInvite.invitationId, atomicLeader, "atomic-cancel");
  await firstProcess.disbandParty(atomicParty.partyId, atomicLeader, "atomic-disband");

  await firstProcess.createParty(mergePartyA, mergeLeaderA, "merge-create-a");
  for (const [index, mergeMember] of [mergeMemberA, mergeMemberB].entries()) {
    const memberInvite = await firstProcess.inviteMember(
      mergeMember,
      mergeLeaderA,
      `merge-invite-a-${index}`
    );
    await firstProcess.acceptInvite(
      memberInvite.invitationId,
      mergeMember,
      `merge-accept-a-${index}`
    );
  }
  await firstProcess.createParty(mergePartyB, mergeLeaderB, "merge-create-b");
  const sourceMemberInvite = await firstProcess.inviteMember(
    mergeMemberC,
    mergeLeaderB,
    "merge-invite-b"
  );
  await firstProcess.acceptInvite(
    sourceMemberInvite.invitationId,
    mergeMemberC,
    "merge-accept-b"
  );
  const mergeInvite = await firstProcess.inviteMember(
    mergeMemberC,
    mergeLeaderA,
    "merge-invite-parties"
  );
  const forwardedMergeInvite = await firstProcess.forwardInvite(
    mergeInvite.invitationId,
    mergeMemberC,
    "merge-forward"
  );
  assert(
    forwardedMergeInvite.targetPlayerId === mergeLeaderB,
    "member did not forward the merge invitation to the source party leader"
  );
  const mergedParty = await firstProcess.acceptInvite(
    mergeInvite.invitationId,
    mergeLeaderB,
    "merge-accept"
  );
  assert(
    mergedParty.memberPlayerIds.join(",") === [
      mergeLeaderA,
      mergeMemberA,
      mergeMemberB,
      mergeLeaderB,
      mergeMemberC
    ].sort().join(","),
    "two-player party was not atomically merged into the three-player party"
  );
  assert(
    firstProcess.partyForPlayer(mergeLeaderB)?.partyId === mergePartyA,
    "source party remained after merge"
  );
  assert(
    (await firstProcess.forwardInvite(
      mergeInvite.invitationId,
      mergeMemberC,
      "merge-forward"
    )).invitationId === mergeInvite.invitationId,
    "forward replay lost its durable result after merge acceptance"
  );

  const created = await firstProcess.createParty(partyA, leaderA, "create-a");
  assert(created.memberPlayerIds.join(",") === leaderA, "party creation enrolled a player without consent");

  const invite = await firstProcess.inviteMember(target, leaderA, "invite-target");
  assert(invite.partyId === partyA, "invitation did not reference the actor's party");
  assert(firstProcess.partyForPlayer(target) === null, "invitation enrolled its target before acceptance");
  assert(firstProcess.invitesForPlayer(target).length === 1, "target invitation was not cached");
  assert(firstProcess.outgoingInvitesForParty(partyA)[0]?.targetPlayerId === target,
    "outgoing invitation was not cached");
  await expectPartyError(
    firstProcess.inviteMember(target, leaderA, "invite-target"),
    "PARTY_REQUEST_DUPLICATE"
  );
  await expectPartyError(
    firstProcess.inviteMember(otherTarget, leaderA, "invite-target"),
    "PARTY_OPERATION_CONFLICT"
  );

  await firstProcess.close();
  const restarted = authority();
  await restarted.initialize();
  assert(restarted.partyForPlayer(target) === null, "restart inferred invitation as membership");
  assert(restarted.invitesForPlayer(target)[0]?.partyId === partyA,
    "pending invitation did not survive restart");
  assert(restarted.outgoingInvitesForParty(partyA)[0]?.targetPlayerId === target,
    "outgoing invitation did not survive restart");

  const accepted = await restarted.acceptInvite(partyA, target, "accept-target");
  assert(accepted.memberPlayerIds.join(",") === [leaderA, target].sort().join(","),
    "target acceptance did not enroll the target exactly once");
  assert(accepted.revision === 2, "target acceptance did not increment revision exactly once");
  assert(restarted.invitesForPlayer(target).length === 0, "acceptance did not clear target invitations");
  assert(restarted.inboxInvitesForPlayer(target).some((receipt) =>
    receipt.invitationId === invite.invitationId && receipt.status === "accepted"
  ), "accepted invitation was not retained as an inbox receipt");
  const replayedAccepted = await restarted.acceptInvite(partyA, target, "accept-target");
  assert(replayedAccepted.revision === accepted.revision,
    "replayed acceptance changed the durable party");
  await expectPartyError(
    restarted.acceptInvite(partyB, target, "accept-target"),
    "PARTY_OPERATION_CONFLICT"
  );

  await restarted.inviteMember(member, leaderA, "invite-member");
  const withMember = await restarted.acceptInvite(partyA, member, "accept-member");
  assert(withMember.revision === 3, "second consented member did not increment revision exactly once");

  const changed = await restarted.changePartyLeader(target, leaderA, "change-leader");
  assert(changed.leaderPlayerId === target && changed.revision === 4,
    "leadership change was not committed");
  await expectPartyError(
    restarted.changePartyLeader(target, leaderA, "change-leader"),
    "PARTY_REQUEST_DUPLICATE"
  );
  await expectPartyError(
    restarted.changePartyLeader(member, leaderA, "change-leader"),
    "PARTY_OPERATION_CONFLICT"
  );

  const removed = await restarted.removePartyMember(member, target, "remove-member");
  assert(removed?.revision === 5 && !removed.memberPlayerIds.includes(member),
    "leader removal did not persist exactly once");
  await expectPartyError(
    restarted.removePartyMember(member, target, "remove-member"),
    "PARTY_REQUEST_DUPLICATE"
  );

  const afterLeave = await restarted.leaveParty(leaderA, "leave-a");
  assert(afterLeave?.memberPlayerIds.join(",") === target,
    "leaving player remained in party membership");
  await expectPartyError(restarted.leaveParty(leaderA, "leave-a"), "PARTY_REQUEST_DUPLICATE");
  await expectPartyError(restarted.leaveParty(leaderA, "leave-new"), "PARTY_NOT_FOUND");

  await restarted.createParty(partyB, leaderB, "create-b");
  await restarted.inviteMember(declineTarget, leaderB, "invite-decline");
  await restarted.inviteMember(createTarget, leaderB, "invite-create-target");
  await restarted.createParty(targetParty, createTarget, "create-target-party");
  assert(restarted.invitesForPlayer(createTarget).length === 0,
    "creating a party did not clear the new leader's stale invitations");

  await restarted.close();
  const secondRestart = authority();
  await secondRestart.initialize();
  assert(secondRestart.partyForPlayer(target)?.leaderPlayerId === target,
    "membership and leadership did not rehydrate after a second restart");
  assert(secondRestart.invitesForPlayer(declineTarget)[0]?.partyId === partyB,
    "declinable invitation did not rehydrate after restart");
  assert(await secondRestart.declineInvite(partyB, declineTarget, "decline-b"),
    "target decline did not remove a pending invitation");
  assert(await secondRestart.declineInvite(partyB, declineTarget, "decline-b"),
    "replayed decline did not return the committed result");

  await secondRestart.close();
  const finalRestart = authority();
  await finalRestart.initialize();
  assert(finalRestart.invitesForPlayer(declineTarget).length === 0,
    "declined invitation reappeared after restart");
  assert(finalRestart.inboxInvitesForPlayer(declineTarget).some((receipt) =>
    receipt.status === "declined" && receipt.partyId === partyB
  ), "declined invitation receipt did not survive restart");
  await expectPartyError(finalRestart.createParty(`party:replay:${suffix}`, leaderB, "create-b"),
    "PARTY_REQUEST_DUPLICATE");
  assert(finalRestart.partyForPlayer(leaderB)?.partyId === partyB,
    "replayed create replaced the durable party");

  await finalRestart.inviteMember(otherTarget, leaderB, "invite-expiry");
  await pool.query(
    `UPDATE party_invites
     SET issued_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'
     WHERE party_id = $1 AND target_player_id = $2`,
    [partyB, otherTarget]
  );
  assert(finalRestart.invitesForPlayer(otherTarget).length === 1,
    "external expiry fixture did not exercise stale-cache repair");
  await finalRestart.reconcileCache();
  assert(finalRestart.invitesForPlayer(otherTarget).length === 0,
    "full cache reconciliation restored an expired invitation");
  assert(finalRestart.inboxInvitesForPlayer(otherTarget).some((receipt) =>
    receipt.status === "expired" && receipt.partyId === partyB
  ), "expired invitation was not retained as an inbox receipt");
  await expectPartyError(
    finalRestart.acceptInvite(partyB, otherTarget, "accept-expired"),
    "PARTY_INVITE_EXPIRED"
  );

  await finalRestart.inviteMember(
    capacityPendingTarget,
    leaderB,
    "invite-capacity-pending"
  );
  for (const [index, fullMember] of [
    fullMemberA,
    fullMemberB,
    fullMemberC,
    fullMemberD
  ].entries()) {
    await finalRestart.inviteMember(fullMember, leaderB, `invite-full-member-${index}`);
    await finalRestart.acceptInvite(partyB, fullMember, `accept-full-member-${index}`);
  }
  await expectPartyError(
    finalRestart.inviteMember(capacityNewTarget, leaderB, "invite-when-full"),
    "PARTY_FULL"
  );
  await expectPartyError(
    finalRestart.acceptInvite(partyB, capacityPendingTarget, "accept-when-full"),
    "PARTY_FULL"
  );

  const incompleteOperations = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM party_operations
     WHERE player_id = ANY($1::text[]) AND completed_at IS NULL`,
    [playerIds]
  );
  assert(Number(incompleteOperations.rows[0]?.count) === 0,
    "committed request reservations were not marked complete");

  console.log(JSON.stringify({
    ok: true,
    consentRequired: true,
    inviteRestartRehydrated: true,
    requestReplayDurable: true,
    payloadConflictRejected: true,
    inviteExpiryReconciled: true,
    partyCapacityEnforced: true,
    explicitCacheReconciliation: true,
    writerLeaseExclusive: true,
    writerLeaseReleased: true,
    finalPartyRevision: finalRestart.partyForPlayer(target)?.revision
  }, null, 2));
} finally {
  for (const partyAuthority of authorities.reverse()) {
    await partyAuthority.close().catch(() => undefined);
  }
  await pool.query(`DELETE FROM parties WHERE party_id = ANY($1::text[])`, [partyIds]);
  await pool.query(`DELETE FROM players WHERE id = ANY($1::text[])`, [playerIds]);
  await pool.end();
}

function authority(): PostgresPartyAuthority {
  const instance = new PostgresPartyAuthority(pool);
  authorities.push(instance);
  return instance;
}

async function insertPlayer(playerId: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id, username, username_normalized, region_code, lat, lon, anchor_lat, anchor_lon,
       move_leash_radius_m, geom
     ) VALUES ($1,$1,$1,'NM',35.0844,-106.6504,35.0844,-106.6504,1000,
       ST_SetSRID(ST_MakePoint(-106.6504,35.0844),4326))`,
    [playerId]
  );
}

async function expectPartyError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    assert(error instanceof PartyAuthorityError && error.code === code, `Expected ${code}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
