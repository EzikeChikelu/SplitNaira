/**
 * Schema ownership and migration conventions (Issue #1472).
 *
 * Pure checks over entity decorator metadata and migration source text, so
 * they run in unit tests without a database. The rules are documented in
 * docs/database-schema-conventions.md; keep the two in sync.
 */

export interface SchemaViolation {
  rule: string;
  subject: string;
  message: string;
}

export interface MigrationSource {
  fileName: string;
  source: string;
}

/** Shape of the parts of TypeORM's `getMetadataArgsStorage()` we inspect. */
export interface EntityMetadataArgs {
  tables: Array<{ target: unknown; name?: string }>;
  indices: Array<{ target: unknown; name?: string }>;
  checks: Array<{ target: unknown; name?: string }>;
  uniques: Array<{ target: unknown; name?: string }>;
}

/**
 * Timestamps shared by more than one migration before these conventions
 * existed. Renaming an applied migration changes its recorded name, so they
 * are grandfathered; never add to this list.
 */
export const GRANDFATHERED_DUPLICATE_TIMESTAMPS: ReadonlySet<string> = new Set([
  "1760000000006",
  "1760000000007",
  "1760000000008",
]);

/** Tables holding financial history: migrations may never rewrite their rows. */
export const PROTECTED_FINANCIAL_TABLES = ["transactions", "ledger_blocks", "audit_log"] as const;

const MIGRATION_FILE_PATTERN = /^(\d{13})-([A-Z][A-Za-z0-9]*)\.ts$/;
const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CONSTRAINT_PREFIXES = ["PK_", "FK_", "UQ_", "CHK_", "REL_", "EXCL_"];

function violation(rule: string, subject: string, message: string): SchemaViolation {
  return { rule, subject, message };
}

export function parseMigrationFileName(
  fileName: string
): { timestamp: string; name: string } | null {
  const match = MIGRATION_FILE_PATTERN.exec(fileName);
  return match ? { timestamp: match[1], name: match[2] } : null;
}

function hasIndexPrefixFor(indexName: string, table: string): boolean {
  return indexName.startsWith(`IDX_${table}_`) || indexName.startsWith(`UQ_${table}_`);
}

export function checkMigrationSources(
  migrations: MigrationSource[],
  grandfathered: ReadonlySet<string> = GRANDFATHERED_DUPLICATE_TIMESTAMPS
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const byTimestamp = new Map<string, string[]>();

  for (const { fileName, source } of migrations) {
    const parsed = parseMigrationFileName(fileName);
    if (!parsed) {
      violations.push(
        violation(
          "migration-filename",
          fileName,
          "Migration files must be named <13-digit-timestamp>-<PascalCaseName>.ts."
        )
      );
      continue;
    }

    const { timestamp, name } = parsed;
    byTimestamp.set(timestamp, [...(byTimestamp.get(timestamp) ?? []), fileName]);
    const className = `${name}${timestamp}`;

    if (!new RegExp(`export class ${className}\\b`).test(source)) {
      violations.push(
        violation("migration-class-name", fileName, `Expected exported class ${className}.`)
      );
    }
    if (!new RegExp(`name\\s*=\\s*["'\`]${className}["'\`]`).test(source)) {
      violations.push(
        violation("migration-name-property", fileName, `Expected name = "${className}".`)
      );
    }
    if (!/async\s+down\s*\(/.test(source)) {
      violations.push(
        violation("migration-down", fileName, "Every migration must implement down() for rollback.")
      );
    }

    for (const match of source.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:"?([A-Za-z0-9_]+)"?\s+)?ON\s+"?([a-z0-9_]+)"?/gi
    )) {
      const [, indexName, table] = match;
      if (!indexName) {
        violations.push(
          violation("migration-index-name", fileName, `Index on ${table} must be explicitly named.`)
        );
      } else if (!hasIndexPrefixFor(indexName, table)) {
        violations.push(
          violation(
            "migration-index-name",
            fileName,
            `Index ${indexName} must be named IDX_${table}_* or UQ_${table}_*.`
          )
        );
      }
    }

    for (const match of source.matchAll(/CONSTRAINT\s+"([A-Za-z0-9_]+)"/g)) {
      const constraintName = match[1];
      if (!CONSTRAINT_PREFIXES.some((prefix) => constraintName.startsWith(prefix))) {
        violations.push(
          violation(
            "migration-constraint-name",
            fileName,
            `Constraint ${constraintName} must start with one of ${CONSTRAINT_PREFIXES.join(", ")}.`
          )
        );
      }
    }

    const protectedTables = PROTECTED_FINANCIAL_TABLES.join("|");
    const rewrite = new RegExp(
      `\\b(DELETE\\s+FROM|TRUNCATE(?:\\s+TABLE)?|UPDATE)\\s+"?(${protectedTables})"?\\b`,
      "i"
    );
    const rewriteMatch = rewrite.exec(source);
    if (rewriteMatch) {
      violations.push(
        violation(
          "migration-financial-rewrite",
          fileName,
          `Migrations must not ${rewriteMatch[1].toUpperCase()} rows of ${rewriteMatch[2]}; financial history is append-only.`
        )
      );
    }
  }

  for (const [timestamp, files] of byTimestamp) {
    if (files.length > 1 && !grandfathered.has(timestamp)) {
      violations.push(
        violation(
          "migration-timestamp-unique",
          timestamp,
          `Timestamp shared by ${files.join(", ")}; ordering is ambiguous.`
        )
      );
    }
  }

  return violations;
}

export function checkEntityMetadata(
  storage: EntityMetadataArgs,
  migrations: MigrationSource[] = []
): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  const tableByTarget = new Map(storage.tables.map((t) => [t.target, t.name]));
  const seenIndexNames = new Map<string, string>();
  const migrationText = migrations.map((m) => m.source).join("\n");

  for (const { name } of storage.tables) {
    if (!name) {
      violations.push(
        violation(
          "entity-table-name",
          "<unnamed>",
          "Entities must pass an explicit table name to @Entity()."
        )
      );
    } else if (!SNAKE_CASE_PATTERN.test(name)) {
      violations.push(violation("entity-table-name", name, "Table names must be snake_case."));
    }
  }

  for (const index of storage.indices) {
    const table = tableByTarget.get(index.target);
    if (!table) continue;
    if (!index.name) {
      violations.push(
        violation(
          "entity-index-name",
          table,
          "Indexes must be explicitly named so entity and migration names cannot drift."
        )
      );
      continue;
    }
    if (!hasIndexPrefixFor(index.name, table)) {
      violations.push(
        violation("entity-index-name", index.name, `Expected IDX_${table}_* or UQ_${table}_*.`)
      );
    }
    const owner = seenIndexNames.get(index.name);
    if (owner && owner !== table) {
      violations.push(
        violation("entity-index-unique-name", index.name, `Also declared on ${owner}.`)
      );
    }
    seenIndexNames.set(index.name, table);
    if (migrations.length > 0 && !migrationText.includes(`"${index.name}"`)) {
      violations.push(
        violation("entity-index-migrated", index.name, "No migration creates this index.")
      );
    }
  }

  for (const check of storage.checks) {
    const table = tableByTarget.get(check.target);
    if (!table) continue;
    if (!check.name || !check.name.startsWith(`CHK_${table}_`)) {
      violations.push(
        violation(
          "entity-check-name",
          check.name ?? table,
          `Check constraints must be named CHK_${table}_*.`
        )
      );
    }
  }

  for (const unique of storage.uniques) {
    const table = tableByTarget.get(unique.target);
    if (!table) continue;
    if (!unique.name || !unique.name.startsWith(`UQ_${table}_`)) {
      violations.push(
        violation(
          "entity-unique-name",
          unique.name ?? table,
          `Unique constraints must be named UQ_${table}_*.`
        )
      );
    }
  }

  return violations;
}
