import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const controller = readFileSync(new URL('./deploy-control.sh', import.meta.url), 'utf8').replaceAll('\r', '');
const updater = readFileSync(new URL('./deploy-test-update.sh', import.meta.url), 'utf8').replaceAll('\r', '');
const handoff = controller.slice(controller.indexOf('handoff_retirement_prepared_updater()'), controller.indexOf('\nprepare_operation()'));
const script = handoff.slice(handoff.indexOf("<<'NODE'\n") + 9, handoff.indexOf('\nNODE'));
const oldHash = 'a48707a2eb3ec28bd0b4281f22073fa26345570adb55ce40681d4cea23832d67';
const newHash = createHash('sha256').update(updater).digest('hex');
const target = '4811473f91d3b209ddd3da7f47f4a41de97ca121';
const r = { operation_id: 'coordinated-20260101T000000-00000000', requested_target_sha: target,
  requested_generation: 'test/t1278', release_mode: 'active', requested_action: 'prepare',
  result: 'prepared', prepare_result: 'completed', updater_hash: oldHash,
  activation_started: false, activation_completed: false, migration_started: false,
  migration_completed: false, migration_outcome_uncertain: false, activation_result: 'pending',
  prepared_descriptor_version: 4, prepared_descriptor_sha256: 'a'.repeat(64),
  prepare_receipt_sha256: 'a'.repeat(64), prepared_env_sha256: 'b'.repeat(64) };
const releases = Object.entries({ ios: ['1111111111111111111111111111111111111111111111111111111111111111',
  '00000000-0000-4000-8000-000000000000'], android: [
  '2222222222222222222222222222222222222222222222222222222222222222', '8'] })
  .map(([platform, [artifactSha256, storeBuildId]]) => ({ platform, artifactSha256, storeBuildId,
    build: 8, marketingVersion: '1.1.0', generation: 't1278', sourceSha: target,
    compatibilityProtected: true, releaseId: 'coord-coordinated-20260101T000000-00000000-000000000000' }));

function fixture(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'ash-atlas-retirement-handoff-'));
  const receipt = join(directory, 'receipt.json');
  const registry = join(directory, 'registry.json');
  const audit = join(directory, 'audit.json');
  writeFileSync(receipt, JSON.stringify(r)); writeFileSync(registry, JSON.stringify({ releases }));
  const run = () => spawnSync(process.execPath, ['-', receipt, audit, oldHash, newHash, registry, 'c'.repeat(40)],
    { input: script, encoding: 'utf8' });
  try { fn({ run, receipt, registry, audit }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('the bridge pins the exact installed updater and frozen operation', () => {
  assert.ok(handoff.includes(`"$new_hash" = ${newHash}`));
  assert.ok(handoff.includes('"$RECON_LOCK_STATE" = free'));
  assert.ok(handoff.includes('prepared_receipt_sha "$receipt"'));
  assert.ok(handoff.includes('prepared_env_sha256'));
  assert.ok(handoff.includes('prepared_previous_game_sha'));
  assert.ok(handoff.includes('prepared_previous_public_sha'));
  const ps = readFileSync(new URL('../accept-and-publish-test-server.ps1', import.meta.url), 'utf8');
  assert.ok(ps.includes(`$currentUpdaterHash -cne '${newHash}'`));
});

test('handoff audits original evidence and keeps preparation and submissions unchanged; retry is idempotent', () => {
  fixture(({ run, receipt, audit }) => {
    const before = readFileSync(receipt, 'utf8');
    const initial = run();
    assert.equal(initial.status, 0, initial.stderr);
    const rawAudit = readFileSync(audit, 'utf8');
    const proof = JSON.parse(rawAudit);
    assert.equal(proof.prior_receipt_sha256, createHash('sha256').update(before).digest('hex'));
    assert.deepEqual(proof.prior_receipt, r);
    assert.equal(proof.prepared_descriptor_sha256, r.prepared_descriptor_sha256);
    assert.equal(proof.build8_submissions.length, 2);
    assert.equal(readFileSync(receipt, 'utf8'), before);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(audit, 'utf8'), rawAudit);
    writeFileSync(receipt, JSON.stringify({ ...r, status_projection_result: 'published',
      status_projection_updated_at_utc: '2026-09-26T01:00:00Z' }));
    assert.equal(run().status, 0);
    assert.equal(readFileSync(audit, 'utf8'), rawAudit);
  });
});

test('activation, migration, changed descriptor or frozen identity refuse handoff', () => {
  for (const patch of [{ activation_started: true }, { activation_completed: true },
    { migration_started: true }, { migration_completed: true }, { migration_outcome_uncertain: true },
    { activation_intent_id: 'existing-intent' }, { result: 'completed' },
    { requested_target_sha: 'c'.repeat(40) }, { requested_generation: 'test/t1282' },
    { prepare_receipt_sha256: 'c'.repeat(64) }, { updater_hash: 'd'.repeat(64) }]) {
    fixture(({ run, receipt }) => {
      writeFileSync(receipt, JSON.stringify({ ...r, ...patch }));
      const result = run();
      assert.notEqual(result.status, 0, JSON.stringify(patch));
    });
  }
});

test('different build 8 identities or an active registry intent refuse handoff', () => {
  for (const field of ['artifactSha256', 'storeBuildId', 'sourceSha', 'releaseId', 'marketingVersion']) {
    fixture(({ run, registry }) => {
      const changed = structuredClone(releases); changed[0][field] = 'different';
      writeFileSync(registry, JSON.stringify({ releases: changed }));
      assert.notEqual(run().status, 0, field);
    });
  }
  fixture(({ run, registry }) => {
    writeFileSync(registry, JSON.stringify({ releases, activationIntent: { intentId: 'active' } }));
    assert.notEqual(run().status, 0);
  });
});

test('conflicting existing audit is refused without overwriting it', () => {
  fixture(({ run, audit }) => {
    writeFileSync(audit, '{"operation_id":"other-operation"}');
    const before = readFileSync(audit, 'utf8');
    assert.notEqual(run().status, 0);
    assert.equal(readFileSync(audit, 'utf8'), before);
  });
});

test('both integration guards restrict descendants to release tooling and preserve exact master/tag checks', () => {
  for (const source of [controller, updater]) {
    const guard = source.slice(source.indexOf('frozen_integration_tooling_only()'),
      source.indexOf('\n}\n', source.indexOf('frozen_integration_tooling_only()')) + 3);
    assert.ok(guard.includes(target));
    assert.ok(guard.includes('tools/release/*|tools/mobile-release/*|docs/architecture/IN_APP_UPDATES_PLAN.md'));
    assert.ok(guard.includes('*) return 1'));
  }
  assert.ok(controller.includes("fail 'origin/master does not equal the PREPARED target'"));
  assert.ok(controller.includes("fail 'immutable generation does not equal the PREPARED target'"));
  assert.ok(updater.includes("fail 'published master differs from the prepared target'"));
  assert.ok(updater.includes("fail 'published generation differs from the prepared target'"));
});

test('executed integration guards admit tooling descendants but refuse gameplay, unknown source, ancestry and git failures',
  { skip: process.platform !== 'linux' }, () => {
    for (const source of [controller, updater]) {
      const start = source.indexOf('frozen_integration_tooling_only()');
      const guard = source.slice(start, source.indexOf('\n}\n', start) + 3);
      const mocks = `
MIRROR_ROOT=fixture
remote_ref_sha() { printf '%s' "$TIP"; }
remote_integration_contains_target() { test "$ANCESTOR" = yes && test "$TAGGED" = yes; }
sudo() { shift 2; "$@"; }
git() {
  case "$*" in
    *rev-parse*) printf '%s' "$TIP" ;;
    *merge-base*) test "$ANCESTOR" = yes ;;
    *tag\\ --points-at*) test "$TAGGED" != yes || printf 'test/t1282\\n' ;;
    *diff\\ --name-only*) test "$DIFF_FAIL" != yes || return 1; printf '%s\\n' "$CHANGES" ;;
    *) return 1 ;;
  esac
}
`;
      const cases = [
        { changes: 'tools/release/vps/deploy-control.sh\ntools/mobile-release/registry.mjs', allowed: true },
        { changes: 'apps/server/src/config.ts', allowed: false },
        { changes: 'tools/release/a.sh\nconfig/protocol-versions.json', allowed: false },
        { changes: 'tools/release/a.sh', ancestor: 'no', allowed: false },
        { changes: 'tools/release/a.sh', tagged: 'no', allowed: false },
        { changes: 'tools/release/a.sh', diffFail: 'yes', allowed: false },
        { changes: 'tools/release/a.sh', source: 'f'.repeat(40), allowed: false }
      ];
      for (const c of cases) {
        const result = spawnSync('bash', ['-c', `${mocks}\n${guard}\nfrozen_integration_tooling_only "$SOURCE"`],
          { env: { ...process.env, TIP: 'd'.repeat(40), SOURCE: c.source ?? target, CHANGES: c.changes,
            ANCESTOR: c.ancestor ?? 'yes', TAGGED: c.tagged ?? 'yes', DIFF_FAIL: c.diffFail ?? 'no' }, encoding: 'utf8' });
        assert.equal(result.status === 0, c.allowed, `${c.changes}: ${result.stderr}`);
      }
    }
  });
