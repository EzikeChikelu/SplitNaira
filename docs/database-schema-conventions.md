# Database Schema Ownership and Migration Conventions

Issue #1472. Checker: [`backend/src/lib/schema-conventions.ts`](../backend/src/lib/schema-conventions.ts).
Tests: [`backend/src/__tests__/schema-conventions.test.ts`](../backend/src/__tests__/schema-conventions.test.ts).
These tests run against every real entity and migration on each `npm test`, so
a violation fails CI.

## Ownership

- The backend owns the Postgres schema. Schema changes ship **only** as
  TypeORM migrations in `backend/src/migrations/`. `synchronize` is always
  `false`.
- Entities in `backend/src/entities/` describe the schema the migrations
  produce. Every entity must be listed in `ENTITIES` in
  `backend/src/services/database.ts`. A test fails if one is missing.
- Financial history (`transactions`, `ledger_blocks`, `audit_log`) is
  append-only. See [immutable-financial-events.md](./immutable-financial-events.md).

## Naming

| Object | Convention | Example |
|---|---|---|
| Table | `snake_case`, explicit in `@Entity("...")` | `ledger_blocks` |
| Index | `IDX_<table>_<columns>`, explicit in `@Index("...")` | `IDX_transactions_recipient_timestamp` |
| Unique index / constraint | `UQ_<table>_<columns>` | `UQ_notification_preferences_wallet_category` |
| Check constraint | `CHK_<table>_<meaning>` | `CHK_transactions_amount_valid` |
| Primary key | `PK_<table>[_<column>]` | `PK_ledger_blocks_id` |
| Foreign key | `FK_<table>_<column>` | — |

Always name objects explicitly. TypeORM's generated hash names never match a
hand-written migration, so `migration:generate` reports false drift and
`DROP INDEX` in `down()` cannot find the object. Column-level
`@Column({ unique: true })` is unnamed, so use a class-level
`@Unique("UQ_<table>_<column>", ["column"])` instead.

## Migration rules (enforced)

| Rule id | Requirement |
|---|---|
| `migration-filename` | File is `<13-digit-ms-timestamp>-<PascalCaseName>.ts`. |
| `migration-class-name` | Exports `class <Name><timestamp>`. |
| `migration-name-property` | `name = "<Name><timestamp>"` (TypeORM records this in the `migrations` table). |
| `migration-down` | Implements `down()` so the migration can be reverted. |
| `migration-timestamp-unique` | No two migrations share a timestamp, because ordering would be ambiguous. Three legacy timestamps (`…006`, `…007`, `…008`) are grandfathered, since renaming applied migrations would break existing databases. **Never add to that list.** |
| `migration-index-name` | Every `CREATE INDEX` is named `IDX_<table>_*` / `UQ_<table>_*` after the table in its `ON` clause. |
| `migration-constraint-name` | Named constraints start with `PK_`, `FK_`, `UQ_`, `CHK_`, `REL_` or `EXCL_`. |
| `migration-financial-rewrite` | No `DELETE FROM`, `UPDATE` or `TRUNCATE` on `transactions`, `ledger_blocks` or `audit_log`. Corrections are new rows. |

## Entity rules (enforced)

| Rule id | Requirement |
|---|---|
| `entity-table-name` | Explicit, `snake_case` table name. |
| `entity-index-name` | Explicit `IDX_<table>_*` / `UQ_<table>_*`. |
| `entity-index-unique-name` | An index name is declared on one table only. |
| `entity-index-migrated` | Every entity index name is created by some migration. |
| `entity-check-name` | `CHK_<table>_*`. |
| `entity-unique-name` | `UQ_<table>_*`. |

This change brought existing entities into line without any schema change. The
names now match what the migrations already create:
`AuditLog.action → IDX_audit_log_action`,
`ProjectEditHistory.projectId → IDX_project_edit_history_project_id`,
`User.walletAddress → UQ_users_walletAddress`,
`TransactionRecord.txHash → UQ_transactions_txHash`.

## Index expectations

- Index a column when a hot query filters or sorts by it. Record the query in
  [data_indexes.md](./data_indexes.md).
- Prefer composite indexes that match the `WHERE` + `ORDER BY` of the query
  (e.g. `(recipient, timestamp)`).
- On large existing tables, create indexes with `IF NOT EXISTS` and consider
  `CONCURRENTLY` in a dedicated migration with `transaction = false`.

## Review checklist

Before approving a migration PR:

- [ ] `npm test -- schema-conventions` passes.
- [ ] `up()` is idempotent where it can be (`IF NOT EXISTS`, `DO $$ … $$` guards)
      and `down()` reverses exactly what `up()` created.
- [ ] Adding a `NOT NULL` column to an existing table supplies a default or a
      backfill in the same migration.
- [ ] No rewrite of financial history. Amount columns keep their `CHK_*` constraint.
- [ ] Entity decorators use the same object names as the SQL.
- [ ] `npm run migration:dry-run` succeeds against a scratch database
      (environment-dependent: needs local Postgres. See
      [runbooks/local-postgres-migration-dry-run.md](./runbooks/local-postgres-migration-dry-run.md)).
- [ ] Locking impact on large tables is noted in the PR description.
