import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getMetadataArgsStorage } from "typeorm";
import { describe, expect, it } from "vitest";
import {
  GRANDFATHERED_DUPLICATE_TIMESTAMPS,
  checkEntityMetadata,
  checkMigrationSources,
  parseMigrationFileName,
  type EntityMetadataArgs,
  type MigrationSource,
} from "../lib/schema-conventions.js";
import { ENTITIES } from "../services/database.js";

const SRC = path.resolve(__dirname, "..");

function loadMigrations(): MigrationSource[] {
  const dir = path.join(SRC, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((fileName) => ({ fileName, source: readFileSync(path.join(dir, fileName), "utf8") }));
}

function migration(fileName: string, body: string): MigrationSource {
  const parsed = parseMigrationFileName(fileName);
  const className = parsed ? `${parsed.name}${parsed.timestamp}` : "Bad";
  return {
    fileName,
    source: `export class ${className} implements MigrationInterface {
  name = "${className}";
  public async up(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(\`${body}\`); }
  public async down(queryRunner: QueryRunner): Promise<void> {}
}`,
  };
}

function rules(violations: { rule: string }[]): string[] {
  return violations.map((v) => v.rule);
}

describe("repository schema follows conventions", () => {
  const migrations = loadMigrations();

  it("all migrations pass", () => {
    expect(checkMigrationSources(migrations)).toEqual([]);
  });

  it("all entities pass, and every entity index is created by a migration", () => {
    expect(
      checkEntityMetadata(getMetadataArgsStorage() as unknown as EntityMetadataArgs, migrations)
    ).toEqual([]);
  });

  it("every entity in src/entities is registered with the data source", async () => {
    const dir = path.join(SRC, "entities");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const tableTargets = new Set(getMetadataArgsStorage().tables.map((t) => t.target));

    for (const file of files) {
      const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<
        string,
        unknown
      >;
      const entityClasses = Object.values(mod).filter(
        (v) => typeof v === "function" && tableTargets.has(v)
      );
      expect(entityClasses.length, `${file} exports an @Entity`).toBeGreaterThan(0);
      for (const cls of entityClasses) {
        expect(ENTITIES, `${file} must be listed in ENTITIES`).toContain(cls);
      }
    }
  });

  it("the grandfathered duplicate list does not grow beyond the known legacy timestamps", () => {
    expect([...GRANDFATHERED_DUPLICATE_TIMESTAMPS].sort()).toEqual([
      "1760000000006",
      "1760000000007",
      "1760000000008",
    ]);
    const latest = Math.max(
      ...migrations.map((m) => Number(parseMigrationFileName(m.fileName)!.timestamp))
    );
    for (const ts of GRANDFATHERED_DUPLICATE_TIMESTAMPS) {
      expect(Number(ts)).toBeLessThan(latest);
    }
  });
});

describe("checkMigrationSources", () => {
  it("accepts a well-formed migration", () => {
    const ok = migration(
      "1770000000000-AddWidgets.ts",
      `CREATE TABLE "widgets" ("id" uuid NOT NULL, CONSTRAINT "PK_widgets_id" PRIMARY KEY ("id"));
       CREATE UNIQUE INDEX IF NOT EXISTS "UQ_widgets_id" ON "widgets" ("id");
       CREATE INDEX "IDX_widgets_id" ON "widgets" ("id")`
    );
    expect(checkMigrationSources([ok])).toEqual([]);
  });

  it.each([
    "add-widgets.ts",
    "1770000000000_AddWidgets.ts",
    "177000000000-AddWidgets.ts",
    "1770000000000-addWidgets.ts",
  ])("rejects bad file name %s", (fileName) => {
    expect(rules(checkMigrationSources([{ fileName, source: "" }]))).toEqual([
      "migration-filename",
    ]);
  });

  it("rejects mismatched class and name property", () => {
    const source = `export class Other1770000000000 { name = "Other1770000000000"; async down() {} }`;
    expect(
      rules(checkMigrationSources([{ fileName: "1770000000000-AddWidgets.ts", source }]))
    ).toEqual(["migration-class-name", "migration-name-property"]);
  });

  it("rejects a migration without down()", () => {
    const source = `export class AddWidgets1770000000000 { name = "AddWidgets1770000000000"; async up() {} }`;
    expect(
      rules(checkMigrationSources([{ fileName: "1770000000000-AddWidgets.ts", source }]))
    ).toEqual(["migration-down"]);
  });

  it.each([
    [`CREATE INDEX "widgets_idx" ON "widgets" ("id")`, "migration-index-name"],
    [`CREATE INDEX "IDX_gadgets_id" ON "widgets" ("id")`, "migration-index-name"],
    [`CREATE INDEX ON "widgets" ("id")`, "migration-index-name"],
    [
      `ALTER TABLE "widgets" ADD CONSTRAINT "widgets_pkey" PRIMARY KEY ("id")`,
      "migration-constraint-name",
    ],
  ])("rejects naming violation in %s", (sql, rule) => {
    expect(rules(checkMigrationSources([migration("1770000000000-AddWidgets.ts", sql)]))).toEqual([
      rule,
    ]);
  });

  it.each([
    `DELETE FROM "transactions" WHERE "status" = 'failed'`,
    `UPDATE transactions SET "amount" = '0'`,
    `TRUNCATE TABLE "audit_log"`,
    `delete from ledger_blocks`,
  ])("rejects rewriting financial history: %s", (sql) => {
    expect(rules(checkMigrationSources([migration("1770000000000-Cleanup.ts", sql)]))).toEqual([
      "migration-financial-rewrite",
    ]);
  });

  it("allows DML on non-financial tables and immutability triggers on financial ones", () => {
    const sql = `UPDATE "users" SET "sessionVersion" = 0;
      CREATE TRIGGER t BEFORE UPDATE OR DELETE ON "transactions" FOR EACH ROW EXECUTE FUNCTION f()`;
    expect(checkMigrationSources([migration("1770000000000-Backfill.ts", sql)])).toEqual([]);
  });

  it("rejects new duplicate timestamps but tolerates grandfathered ones", () => {
    const fresh = [migration("1770000000000-A.ts", ""), migration("1770000000000-B.ts", "")];
    expect(rules(checkMigrationSources(fresh))).toEqual(["migration-timestamp-unique"]);

    const legacy = [migration("1760000000007-A.ts", ""), migration("1760000000007-B.ts", "")];
    expect(checkMigrationSources(legacy)).toEqual([]);
  });
});

describe("checkEntityMetadata", () => {
  class Widget {}
  class Gadget {}

  function storage(overrides: Partial<EntityMetadataArgs>): EntityMetadataArgs {
    return {
      tables: [
        { target: Widget, name: "widgets" },
        { target: Gadget, name: "gadgets" },
      ],
      indices: [],
      checks: [],
      uniques: [],
      ...overrides,
    };
  }

  it("accepts conventional names", () => {
    const meta = storage({
      indices: [
        { target: Widget, name: "IDX_widgets_owner" },
        { target: Gadget, name: "UQ_gadgets_code" },
      ],
      checks: [{ target: Widget, name: "CHK_widgets_amount_valid" }],
      uniques: [{ target: Gadget, name: "UQ_gadgets_serial" }],
    });
    expect(checkEntityMetadata(meta)).toEqual([]);
  });

  it.each([
    [{ tables: [{ target: Widget, name: "Widgets" }] }, "entity-table-name"],
    [{ tables: [{ target: Widget }] }, "entity-table-name"],
    [{ indices: [{ target: Widget }] }, "entity-index-name"],
    [{ indices: [{ target: Widget, name: "IDX_gadgets_owner" }] }, "entity-index-name"],
    [{ checks: [{ target: Widget, name: "amount_positive" }] }, "entity-check-name"],
    [{ checks: [{ target: Widget }] }, "entity-check-name"],
    [{ uniques: [{ target: Widget, name: "UQ_gadgets_x" }] }, "entity-unique-name"],
  ] as Array<[Partial<EntityMetadataArgs>, string]>)("flags %j as %s", (overrides, rule) => {
    expect(rules(checkEntityMetadata(storage(overrides)))).toContain(rule);
  });

  it("flags an index name reused across tables", () => {
    const meta = storage({
      tables: [
        { target: Widget, name: "items" },
        { target: Gadget, name: "items_archive" },
      ],
      indices: [
        { target: Widget, name: "IDX_items_archive_x" },
        { target: Gadget, name: "IDX_items_archive_x" },
      ],
    });
    expect(rules(checkEntityMetadata(meta))).toContain("entity-index-unique-name");
  });

  it("flags an entity index that no migration creates", () => {
    const meta = storage({ indices: [{ target: Widget, name: "IDX_widgets_owner" }] });
    const migrations = [migration("1770000000000-AddWidgets.ts", `CREATE TABLE "widgets" ()`)];
    expect(rules(checkEntityMetadata(meta, migrations))).toEqual(["entity-index-migrated"]);
  });

  it("ignores metadata for classes that are not entities", () => {
    class NotAnEntity {}
    const meta = storage({ indices: [{ target: NotAnEntity, name: "whatever" }] });
    expect(checkEntityMetadata(meta)).toEqual([]);
  });
});
