# Migration serialization and integrity

The migration runner acquires the database-wide session advisory lock named
`ash-atlas-schema-migrations-v1` before it creates, inspects, or changes the migration
ledger. It keeps that same connection and lock until every per-file transaction has
finished. Concurrent runners therefore wait, then re-read the ledger after the first
runner completes.

Each newly applied migration records the SHA-256 of its exact SQL bytes in
`schema_migrations.content_sha256`. A recorded hash mismatch or a recorded migration
whose SQL file is absent stops the run before pending migrations execute.

## One-time baseline for existing databases

Databases created by the previous runner have applied rows without hashes. Ordinary
migration runs fail closed when they encounter those rows. An operator must first
verify that the checked-out migration files are the approved historical source, retain
the emitted baseline event as deployment evidence, and run exactly once:

```powershell
$env:MIGRATION_HASH_BASELINE = 'confirm-current-files'
pnpm db:migrate
Remove-Item Env:MIGRATION_HASH_BASELINE
```

The baseline updates only rows whose hash is still null, in one transaction, and logs
every filename and resulting hash to stderr. The runner then makes the hash column
`NOT NULL` and enforces a lowercase 64-character hexadecimal constraint. The sentinel
is intentionally not a normal persistent application setting; remove it immediately
after the audited baseline.

Rollback does not mean editing an applied SQL file. Restore the application version
and use a new forward migration for any schema correction.
