#!/usr/bin/env python3
"""Disposable Linux fixtures; no devices, services, SSH, or real backups touched."""
import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('watchdog', Path(__file__).with_name('ash-atlas-backup-watchdog.py'))
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ash-atlas-watchdog-test.')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home, self.seagate = self.root / 'home', self.root / 'seagate'
        for base in (self.home, self.seagate):
            for name in ('ash-atlas-telemetry/archive', 'database/receipts', 'reset'):
                (base / name).mkdir(parents=True)
        self.now = 1800001800
        self.env = {'TELEMETRY_HOME_STORAGE_ROOT': str(self.home),
                    'TELEMETRY_HOME_STORAGE_MOUNT': '/', 'TELEMETRY_HOME_STORAGE_UUID': 'internal-uuid',
                    'TELEMETRY_HOME_STORAGE_SERIAL': 'internal-serial', 'TELEMETRY_HOME_STORAGE_FSTYPE': 'ext4',
                    'TELEMETRY_SEAGATE_MOUNT': str(self.seagate), 'TELEMETRY_SEAGATE_UUID': 'seagate-uuid',
                    'TELEMETRY_SEAGATE_SERIAL': 'seagate-serial',
                    'ASH_ATLAS_DATABASE_BACKUP_REMOTE_DIRECTORY': str(self.home / 'database'),
                    'ASH_ATLAS_RESET_BACKUP_REMOTE_DIRECTORY': str(self.home / 'reset')}
        self.portable = (self.seagate / 'ash-atlas-backup-archive' / 'postgresql' /
                         'backup-00000000-0000-0000-0000-000000000001')
        self.portable.mkdir(parents=True)
        (self.portable / 'portable-receipt.json').write_text(json.dumps(
            {'portableCommittedAtUtc': wd.utc(self.now - 60)}))
        self.previous = {'lastDeepAttemptEpoch': self.now - 600, 'lastDeepSuccessEpoch': self.now - 600}
        self.mirror = {'status': 'ok', 'sourceUuid': 'internal-uuid', 'seagateUuid': 'seagate-uuid',
                       'verifiedAtUtc': wd.utc(self.now - 60)}
        self.health = {'version': 1, 'checkedAtUtc': wd.utc(self.now - 60), 'status': 'ok',
                       'capacityAlert': 'ok', 'headroomMarginBytes': 100000000000,
                       'proofAgeMinutes': 10, 'latestBackupCreatedAtUtc': wd.utc(self.now - 900)}
        self.scrub = {'catalogCheckedAtUtc': wd.utc(self.now - 3600), 'status': 'ok',
                      'cycleStartedAtUtc': wd.utc(self.now - 3600), 'attempts': {},
                      'sourceUuid': 'internal-uuid', 'seagateUuid': 'seagate-uuid', 'verification': 'rotating-sha256-deep'}
        self.write_states()
        self.calls = []
        self.fault = ''

    def write_states(self):
        for name, value in (('mirror-state', self.mirror), ('scrub-state', self.scrub)):
            (self.home / ('.ash-atlas-seagate-' + name + '.json')).write_text(json.dumps(value))
        (self.home / '.ash-atlas-ovh-database-health.json').write_text(json.dumps(self.health))
        receipt = {'backupFileName': 'hourly.dump', 'event': 'ash_atlas_postgresql_backup_verified',
                   'restoreCatalogVerified': True, 'bytes': 4, 'createdAtUtc': wd.utc(self.now - 900)}
        (self.home / 'database/receipts/hourly.dump.receipt.json').write_text(json.dumps(receipt))
        (self.home / 'database/hourly.dump').write_text('dump')

    def run_command(self, args, timeout=30):
        self.calls.append(args)
        cmd = args[0]
        if cmd == 'bash':
            if args[-1] == 'seagate' and self.fault in ('unplugged', 'readonly', 'dirty', 'wrong-serial'):
                return 1, '', self.fault
            return 0, '', ''
        if cmd == 'findmnt':
            return 0, json.dumps({'filesystems': [{'target': args[4], 'options': 'ro' if self.fault == 'readonly' else 'rw'}]}), ''
        if cmd == 'df':
            low = (self.fault == 'internal-space' and args[-1] == str(self.home) or
                   self.fault == 'seagate-space' and args[-1] == str(self.seagate))
            return 0, 'Filesystem 1B-blocks Used Available Use% Mounted\ntest 900000000000 1 ' + ('10' if low else '800000000000') + ' 1% /\n', ''
        if cmd == 'udevadm':
            if self.fault == 'unplugged':
                return 1, '', 'No such device'
            return 0, 'ID_SERIAL_SHORT=' + ('other' if self.fault == 'wrong-serial' else 'seagate-serial') + '\n', ''
        if cmd == 'smartctl':
            if self.fault == 'smart-unsupported':
                return 2, '{}', ''
            smart = {'smart_status': {'passed': self.fault != 'smart-failed'},
                     'ata_smart_attributes': {'table': [{'id': i, 'raw': {'value': 1 if self.fault == 'smart-sectors' else 0}}
                                                         for i in (5, 197, 198)]}}
            return 0, json.dumps(smart), ''
        if cmd == 'ntfs-3g.probe':
            return 15, '', 'Volume is dirty'
        if cmd == 'journalctl':
            return 0, ('reset SuperSpeed USB device\nBuffer I/O error on dev sdb1\n' if self.fault == 'usb-io' and '_TRANSPORT=kernel' in args else ''), ''
        if cmd == 'systemctl':
            if args[1] == 'is-active':
                return (3, 'inactive\n', '') if self.fault == 'timer-off' else (0, 'active\n', '')
            if args[1] == 'start':
                return (1, '', 'D-Bus unavailable') if self.fault == 'retry-failed' else (0, '', '')
            failed = ((self.fault == 'mirror-failed' and args[2] == wd.SERVICES[0]) or
                      (self.fault == 'proof-failed' and args[2] == wd.SERVICES[1]))
            active = self.fault == 'active' and args[2] == wd.SERVICES[1]
            return 0, ('LoadState=loaded\nActiveState=' + ('failed' if failed else 'active' if active else 'inactive') +
                       '\nSubState=dead\nResult=' + ('exit-code' if failed else 'success') + '\nExecMainStatus=0\n'), ''
        if cmd == 'rsync':
            return 0, '>f.st...... changed.dump\n' if self.fault == 'divergence' else '', ''
        raise AssertionError(args)

    def collect(self, deep=False):
        if deep:
            self.previous['lastDeepAttemptEpoch'] = self.now - 3601
        real_open = open

        def disposable_open(path, *args, **kwargs):
            if str(path).startswith('/run/lock/'):
                path = self.root / Path(path).name
            return real_open(path, *args, **kwargs)

        original_read = wd.read_json
        def disposable_read(path):
            if str(path) == '/var/lib/ash-atlas/backup-restore/latest.json':
                return {'verifiedAtUtc': wd.utc(self.now - 3600), 'periodicRestoreVersion': 1}
            return original_read(path)
        with patch('builtins.open', disposable_open), patch.object(wd, 'read_json', disposable_read):
            self.report = wd.Watchdog(self.env, self.previous, self.run_command, self.now).collect()
        return self.report

    def assert_issue(self, reason):
        self.assertIn(reason, {issue['reason'] for issue in self.report['issues']})

    def assert_no_recovery(self):
        self.assertFalse([call for call in self.calls if call[:2] == ['systemctl', 'start']])

    def test_healthy_light_does_not_scan_or_start_jobs(self):
        self.assertEqual(self.collect()['status'], 'ok')
        self.assert_no_recovery()
        self.assertNotIn('rsync', [call[0] for call in self.calls])

    def test_bounded_intake_reports_complete_home_and_portable_telemetry(self):
        (self.home / 'legacy-material.bin').write_bytes(b'home')
        portable_telemetry = self.seagate / 'ash-atlas-backup-archive' / 'ash-atlas-telemetry'
        portable_telemetry.mkdir(parents=True)
        (portable_telemetry / 'segment.bin').write_bytes(b'portable')
        self.env.update(TELEMETRY_PORTABLE_TELEMETRY_CAP_BYTES='6',
                        TELEMETRY_PORTABLE_TELEMETRY_WARNING_BYTES='4')
        self.collect()
        intake = self.report['boundedIntake']
        self.assertGreaterEqual(intake['currentBytes'], 4)
        self.assertEqual(intake['portableTelemetryBytes'], 8)
        self.assertEqual(intake['portableTelemetryCapBytes'], 6)
        self.assert_issue('portable_telemetry_cap_exceeded')

    def test_hourly_reuses_locks_parity_and_existing_proof(self):
        self.assertEqual(self.collect(deep=True)['status'], 'ok')
        self.assertEqual(self.report['newestLocalBackupAtUtc'], wd.utc(self.now - 900))
        parity = [call for call in self.calls if call[0] == 'rsync']
        self.assertEqual(len(parity), 1)
        self.assertTrue(all('--dry-run' in call for call in parity))
        self.assertIn(['systemctl', 'start', '--no-block', wd.SERVICES[1]], self.calls)

    def test_unplugged(self):
        self.fault = 'unplugged'
        self.collect()
        self.assert_issue('seagate_absent_or_wrong_identity')
        self.assert_no_recovery()

    def test_readonly(self):
        self.fault = 'readonly'
        self.collect()
        self.assert_issue('seagate_mount_unsafe')
        self.assert_no_recovery()

    def test_dirty_unmountable_only_inspected(self):
        self.fault = 'dirty'
        self.collect(deep=True)
        self.assert_issue('seagate_unmountable_or_unverified')
        self.assertIn(['ntfs-3g.probe', '--readwrite', '/dev/disk/by-uuid/seagate-uuid'], self.calls)
        self.assert_no_recovery()

    def test_wrong_identity_never_probed_or_recovered(self):
        self.fault = 'wrong-serial'
        self.collect(deep=True)
        self.assertNotIn('smartctl', [call[0] for call in self.calls])
        self.assert_no_recovery()

    def test_service_failures_escalate_unknown_causes(self):
        for fault in ('mirror-failed', 'proof-failed'):
            with self.subTest(fault=fault):
                self.fault, self.calls = fault, []
                self.collect(deep=True)
                self.assert_issue('service_failed')
                self.assert_no_recovery()

    def test_stale_backup(self):
        self.health['latestBackupCreatedAtUtc'] = wd.utc(self.now - 11000)
        self.write_states()
        self.collect()
        self.assert_issue('backup_stale')
        self.assert_no_recovery()

    def test_low_space(self):
        for fault, reason in (('internal-space', 'internal_space_low'), ('seagate-space', 'seagate_space_low')):
            with self.subTest(fault=fault):
                self.fault, self.calls = fault, []
                self.collect(deep=True)
                self.assert_issue(reason)
                self.assert_no_recovery()

    def test_smart_warnings_and_missing_coverage(self):
        for fault in ('smart-failed', 'smart-sectors', 'smart-unsupported'):
            with self.subTest(fault=fault):
                self.fault, self.calls = fault, []
                self.assertEqual(self.collect()['status'], 'problem')
                self.assert_no_recovery()

    def test_usb_reset_and_io_burst(self):
        self.fault = 'usb-io'
        self.collect()
        self.assert_issue('kernel_storage_or_interface_errors')
        self.assertEqual(self.report['kernelErrorCount'], 2)
        self.assert_no_recovery()

    def test_mirror_divergence_escalates(self):
        self.fault = 'divergence'
        self.collect(deep=True)
        self.assert_issue('mirror_divergence')
        self.assert_no_recovery()

    def test_deep_failure_persists_until_revalidated(self):
        self.fault = 'divergence'
        self.collect(deep=True)
        self.previous = copy.deepcopy(self.report)
        self.fault, self.calls = '', []
        self.collect()
        self.assert_issue('mirror_divergence')
        self.assert_no_recovery()
        self.previous = copy.deepcopy(self.report)
        self.collect(deep=True)
        self.assertEqual(self.report['status'], 'ok')

    def test_busy_locks_defer_without_starting_proof(self):
        import errno
        with patch.object(wd.fcntl, 'flock', side_effect=BlockingIOError(errno.EAGAIN, 'busy')):
            self.collect(deep=True)
        self.assertIn('deepDeferred', self.report)
        self.assert_no_recovery()

    def test_local_receipt_mismatch(self):
        (self.home / 'database/hourly.dump').write_text('truncated')
        self.collect(deep=True)
        self.assert_issue('deep_validation_failed')
        self.assert_no_recovery()

    def test_alert_contains_identity_and_proof_evidence(self):
        alert = wd.alert_payload(self.collect())
        self.assertEqual(alert['storage']['seagate']['serial'], 'seagate-serial')
        self.assertTrue(alert['lastAcceptedProofAtUtc'])
        self.assertNotIn('recentLog', alert['services'][wd.SERVICES[0]])

    def stale_mirror(self):
        self.mirror['verifiedAtUtc'] = wd.utc(self.now - 1900)
        self.write_states()

    def test_recovery_success_requires_new_durable_marker(self):
        self.stale_mirror()
        self.collect()
        self.assertEqual(self.report['actions'][0]['result'], 'queued')
        self.previous = copy.deepcopy(self.report)
        self.now += 900
        self.mirror['verifiedAtUtc'] = wd.utc(self.now - 60)
        self.write_states()
        self.collect()
        self.assertEqual(self.report['actions'][0]['result'], 'recovered')
        self.assertEqual(self.report['lastRecoveryAction']['result'], 'recovered')
        self.previous = copy.deepcopy(self.report)
        self.collect()
        self.assertEqual(self.report['lastRecoveryAction']['result'], 'recovered')

    def test_recovery_request_failure_latches(self):
        self.stale_mirror()
        self.fault = 'retry-failed'
        self.collect()
        self.assert_issue('recovery_request_failed')
        self.assertTrue(self.report['recoveryLatch'])

    def test_lock_skip_or_recovery_failure_is_not_success(self):
        self.stale_mirror()
        self.collect()
        self.previous = copy.deepcopy(self.report)
        self.now += 900
        self.calls = []
        self.collect()
        self.assert_issue('recovery_failed_or_unconfirmed')
        self.assertTrue(self.report['recoveryLatch'])
        self.assert_no_recovery()

    def test_proof_stale_reuses_existing_proof_service(self):
        self.health['proofAgeMinutes'] = 190
        self.write_states()
        self.collect()
        self.assert_issue('proof_stale')
        self.assertEqual(self.report['pendingRecovery']['unit'], wd.SERVICES[1])

    def test_vps_capacity_warning(self):
        self.health['capacityAlert'] = 'warning'
        self.write_states()
        self.collect()
        self.assert_issue('vps_health_or_headroom')
        self.assert_no_recovery()

    def test_corrupt_status_fails_closed(self):
        (self.home / '.ash-atlas-ovh-database-health.json').write_text('{')
        self.collect()
        self.assert_issue('vps_health_missing_or_invalid')
        self.assert_no_recovery()

    def test_disabled_timer_detected(self):
        self.fault = 'timer-off'
        self.collect()
        self.assert_issue('timer_inactive')
        self.assert_no_recovery()

    def test_future_marker_is_not_a_recoverable_scheduling_miss(self):
        self.mirror['verifiedAtUtc'] = wd.utc(self.now + 3600)
        self.write_states()
        self.collect()
        self.assert_issue('mirror_clock_invalid')
        self.assert_no_recovery()

    def test_atomic_status_roundtrip(self):
        path = self.root / 'status.json'
        wd.atomic_json(path, self.collect())
        self.assertEqual(wd.read_json(path), self.report)

    def test_incident_identity_survives_changed_reasons_and_backs_off(self):
        self.fault = 'smart-unsupported'
        report = self.collect()
        package = wd.stage_incident(report, {}, self.now)
        self.assertEqual(package['escalation']['result'], 'staged_not_dispatched')
        self.assertFalse(package['escalation']['automaticInvocationEnabled'])
        self.assertIn('explicit human approval', package['instructions'])
        self.assertIn('storage', package['evidence'])
        identity = report['incident']['id']
        for offset, count, delay in ((900, 1, 3600), (3600, 2, 7200), (10800, 3, 14400)):
            prior = copy.deepcopy(report)
            report['issues'] = [{'reason': 'seagate_mount_unsafe', 'detail': 'simulated RO'}]
            package = wd.stage_incident(report, prior, self.now + offset)
            self.assertEqual(report['incident']['id'], identity)
            self.assertEqual(report['incident']['packageCount'], count)
            self.assertEqual(report['incident']['cooldownSeconds'], delay)
            if offset == 900:
                self.assertIsNone(package)
                self.assertEqual(report['escalation']['suppressed'], 'handoff_pending_cooldown')
        self.assertEqual(report['incident']['repeatCount'], 4)
        self.assert_no_recovery()

    def test_recovery_suppresses_handoff_then_failure_stages_once(self):
        self.stale_mirror()
        report = self.collect()
        self.assertIsNone(wd.stage_incident(report, {}, self.now))
        self.assertEqual(report['escalation']['suppressed'], 'recovery_active')
        self.previous = copy.deepcopy(report)
        self.now += 900
        report = self.collect()
        self.assertTrue(report['recoveryLatch'])
        self.assertIsNotNone(wd.stage_incident(report, self.previous, self.now))
        self.assertEqual(report['incident']['repeatCount'], 2)

    def test_incident_resolves_and_new_outage_gets_new_identity(self):
        self.fault = 'mirror-failed'
        report = self.collect()
        wd.stage_incident(report, {}, self.now)
        failed = copy.deepcopy(report)
        self.fault = ''
        report = self.collect()
        self.assertIsNone(wd.stage_incident(report, failed, self.now + 900))
        self.assertEqual(report['incident']['state'], 'resolved')
        resolved = copy.deepcopy(report)
        report['issues'] = [{'reason': 'service_failed', 'detail': 'new failure'}]
        wd.stage_incident(report, resolved, self.now + 1800)
        self.assertNotEqual(report['incident']['id'], failed['incident']['id'])

    def test_handoff_backoff_is_capped(self):
        report = self.collect()
        report['issues'] = [{'reason': 'test', 'detail': 'persistent'}]
        for _ in range(12):
            prior = copy.deepcopy(report)
            wd.stage_incident(report, prior, self.now)
            self.now = report['incident']['nextPackageEpoch']
        self.assertEqual(report['incident']['cooldownSeconds'], 86400)

    def test_readonly_status_reports_stale_without_commands_or_writes(self):
        wd.atomic_json(self.root / 'status.json', self.collect())
        before = (self.root / 'status.json').read_bytes()
        with patch.object(wd, 'STATE', self.root), patch.object(wd.os, 'geteuid', return_value=0), \
                patch('sys.argv', ['watchdog', '--status']), \
                patch.object(wd.time, 'time', return_value=self.now + 1900), \
                patch.object(wd, 'command', side_effect=AssertionError('unexpected command')), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(wd.main(), 1)
        self.assertEqual(json.loads(output.getvalue())['status'], 'stale')
        self.assertEqual(before, (self.root / 'status.json').read_bytes())
        self.assertFalse((self.root / 'watchdog.lock').exists())

    def test_force_deep_requests_same_production_checks(self):
        watchdog = wd.Watchdog(self.env, self.previous, self.run_command, self.now, force_deep=True)
        self.assertTrue(watchdog.deep)
        self.assertEqual(watchdog.report['mode'], 'deep')

    def test_kernel_no_matches_is_verified_without_ignoring_query_failure(self):
        def no_matches(args, timeout=30):
            if args[0] == 'journalctl' and '--grep' in args:
                return 1, '', ''
            return self.run_command(args, timeout)
        watchdog = wd.Watchdog(self.env, self.previous, no_matches, self.now)
        watchdog.kernel()
        self.assertFalse(watchdog.report['issues'])
        self.assertIn(['journalctl', '_TRANSPORT=kernel', '--no-pager', '-n', '1'], self.calls)

        def unsupported(args, timeout=30):
            return 1, '', 'unrecognized option --grep'
        watchdog = wd.Watchdog(self.env, self.previous, unsupported, self.now)
        watchdog.kernel()
        self.assertEqual(watchdog.report['issues'][0]['reason'], 'kernel_evidence_unavailable')

    def test_unsafe_deep_attempt_preserves_hourly_cadence_without_success(self):
        self.fault = 'smart-unsupported'
        self.collect(deep=True)
        self.assertEqual(self.report['lastDeepAttemptEpoch'], self.now)
        self.assertEqual(self.report['lastDeepResult'], 'blocked_by_safety')
        self.assertEqual(self.report['lastDeepSuccessEpoch'], self.previous['lastDeepSuccessEpoch'])
        self.previous = copy.deepcopy(self.report)
        self.now += 900
        self.calls = []
        self.collect()
        self.assertEqual(self.report['mode'], 'light')
        self.assertNotIn('rsync', [call[0] for call in self.calls])
        self.assert_no_recovery()

    def test_kernel_keeps_latest_excerpt_and_queries_across_boots(self):
        lines = ['2026-09-20T%02d:00:00+00:00 host kernel: I/O error' % hour for hour in range(10)]
        calls = []
        def newest_first(args, timeout=30):
            calls.append(args)
            return 0, '\n'.join(reversed(lines)), ''
        watchdog = wd.Watchdog(self.env, self.previous, newest_first, self.now)
        watchdog.kernel()
        self.assertEqual(watchdog.report['kernelErrors'], lines)
        self.assertIn(lines[-1], watchdog.report['issues'][0]['detail'])
        self.assertNotIn('-b', calls[0])
        self.assertIn('_TRANSPORT=kernel', calls[0])

    @unittest.skipUnless(shutil.which('systemd-analyze'), 'systemd-analyze unavailable')
    def test_systemd_units_in_disposable_root(self):
        units = self.root / 'etc/systemd/system'
        executable = self.root / 'usr/local/sbin/ash-atlas-backup-watchdog'
        units.mkdir(parents=True)
        executable.parent.mkdir(parents=True)
        sources = Path(__file__).parent
        shutil.copyfile(sources / 'ash-atlas-backup-watchdog.py', executable)
        executable.chmod(0o755)
        for name in ('ash-atlas-backup-watchdog.service', 'ash-atlas-backup-watchdog.timer'):
            shutil.copyfile(sources / name, units / name)
            (units / name).chmod(0o644)
        for target in ('sysinit', 'basic', 'shutdown', 'timers', 'local-fs', 'slices'):
            shutil.copyfile('/usr/lib/systemd/system/' + target + '.target', units / (target + '.target'))
        result = subprocess.run(['systemd-analyze', 'verify', '--root=' + str(self.root), '--man=no',
                                 'ash-atlas-backup-watchdog.service', 'ash-atlas-backup-watchdog.timer'],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
