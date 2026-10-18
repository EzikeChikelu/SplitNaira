/**
 * Transaction isolation tests for collaboration changes (#1467).
 *
 * The gated store below pauses a chosen read so a test can deterministically
 * interleave two changes, the way two requests interleave under READ
 * COMMITTED. The invariant under test: a change is authorized against the
 * record version it commits on top of, never against an earlier snapshot.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_CHANGE_ATTEMPTS,
  applyCollaborationChange,
  createInMemoryCollaborationStore,
  planCollaborationChange,
  type CollaborationChange,
  type CollaborationRecord,
  type CollaborationStore,
} from "../membership-changes.js";

const PROJECT = "project-1";
const OWNER = "GOWNER000000000000000000000000000000000000000000000000";
const ADMIN = "GADMIN000000000000000000000000000000000000000000000000";
const ADMIN2 = "GADMIN200000000000000000000000000000000000000000000000";
const EDITOR = "GEDITOR00000000000000000000000000000000000000000000000";
const VIEWER = "GVIEWER00000000000000000000000000000000000000000000000";
const NEWBIE = "GNEWBIE00000000000000000000000000000000000000000000000";
const STRANGER = "GSTRANGER00000000000000000000000000000000000000000000";

function baseRecord(): CollaborationRecord {
  return {
    projectId: PROJECT,
    owner: OWNER,
    collaborators: [
      { address: ADMIN, role: "admin" },
      { address: ADMIN2, role: "admin" },
      { address: EDITOR, role: "editor" },
      { address: VIEWER, role: "viewer" },
    ],
    version: 1,
  };
}

/** Wraps a store so the next read can be held open until the test releases it. */
function gated(inner: CollaborationStore) {
  let pending: { reached: () => void; gate: Promise<void> } | null = null;
  let reads = 0;
  let casCalls = 0;

  const store: CollaborationStore = {
    async read(projectId) {
      reads++;
      const record = await inner.read(projectId);
      const hold = pending;
      if (hold) {
        pending = null;
        hold.reached();
        await hold.gate;
      }
      return record;
    },
    async compareAndSet(projectId, expectedVersion, next) {
      casCalls++;
      return inner.compareAndSet(projectId, expectedVersion, next);
    },
  };

  return {
    store,
    get reads() {
      return reads;
    },
    get casCalls() {
      return casCalls;
    },
    /** Hold the next read after it has loaded; resolves once that read is reached. */
    holdNextRead() {
      let release: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const reachedP = new Promise<void>((r) => (reached = r));
      pending = { reached, gate };
      return { reached: reachedP, release };
    },
  };
}

/** A store that ignores versions, i.e. what a plain read-then-UPDATE does. */
function lastWriteWinsStore(
  initial: CollaborationRecord
): CollaborationStore & { current(): CollaborationRecord } {
  let record = structuredClone(initial);
  return {
    async read() {
      return structuredClone(record);
    },
    async compareAndSet(_projectId, _expected, next) {
      record = structuredClone(next);
      return true;
    },
    current: () => record,
  };
}

function roleOf(record: CollaborationRecord | undefined, address: string) {
  return record?.collaborators.find((c) => c.address === address)?.role;
}

async function rejectionCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error("expected rejection");
}

/**
 * Run `slow` with its first read held open, run `fast` to completion in the
 * gap, then let `slow` continue.
 */
async function interleave<T>(
  g: ReturnType<typeof gated>,
  slow: () => Promise<T>,
  fast: () => Promise<unknown>
): Promise<PromiseSettledResult<T>> {
  const hold = g.holdNextRead();
  const slowResult = slow().then(
    (value) => ({ status: "fulfilled", value }) as const,
    (reason) => ({ status: "rejected", reason }) as const
  );
  await hold.reached;
  await fast();
  hold.release();
  return slowResult;
}

describe("concurrent collaboration changes preserve authorization invariants", () => {
  it("a demoted admin cannot complete a change it started while still admin", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const g = gated(inner);

    const result = await interleave(
      g,
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: ADMIN,
          change: { type: "add", address: NEWBIE, role: "editor" },
        }),
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "set_role", address: ADMIN, role: "viewer" },
        })
    );

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason.code).toBe("permission_denied");
    const final = inner.snapshot(PROJECT);
    expect(roleOf(final, ADMIN)).toBe("viewer");
    expect(roleOf(final, NEWBIE)).toBeUndefined();
    expect(final?.version).toBe(2);
    // First CAS lost the race, so the change was re-read and re-authorized.
    expect(g.reads).toBe(3);
  });

  it("control: without compare-and-set the same race lets the demoted admin through", async () => {
    const naive = lastWriteWinsStore(baseRecord());
    const g = gated(naive);

    const result = await interleave(
      g,
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: ADMIN,
          change: { type: "add", address: NEWBIE, role: "editor" },
        }),
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "set_role", address: ADMIN, role: "viewer" },
        })
    );

    // Lost update: the demotion is overwritten and the stale grant lands.
    expect(result.status).toBe("fulfilled");
    expect(roleOf(naive.current(), ADMIN)).toBe("admin");
    expect(roleOf(naive.current(), NEWBIE)).toBe("editor");
  });

  it("a removed admin cannot complete an in-flight change", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const g = gated(inner);

    const result = await interleave(
      g,
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: ADMIN,
          change: { type: "set_role", address: EDITOR, role: "viewer" },
        }),
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "remove", address: ADMIN },
        })
    );

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason).toMatchObject({
      code: "permission_denied",
      reason: "project_role_unknown",
    });
    expect(roleOf(inner.snapshot(PROJECT), EDITOR)).toBe("editor");
  });

  it("an admin cannot demote a member the owner promoted to admin concurrently", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const g = gated(inner);

    const result = await interleave(
      g,
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: ADMIN,
          change: { type: "set_role", address: EDITOR, role: "viewer" },
        }),
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "set_role", address: EDITOR, role: "admin" },
        })
    );

    expect(result.status).toBe("rejected");
    expect((result as PromiseRejectedResult).reason.code).toBe("permission_denied");
    expect(roleOf(inner.snapshot(PROJECT), EDITOR)).toBe("admin");
  });

  it("concurrent adds of different members both land (no lost update)", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const g = gated(inner);

    const result = await interleave(
      g,
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: ADMIN,
          change: { type: "add", address: NEWBIE, role: "viewer" },
        }),
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "add", address: STRANGER, role: "editor" },
        })
    );

    expect(result.status).toBe("fulfilled");
    const final = inner.snapshot(PROJECT);
    expect(roleOf(final, NEWBIE)).toBe("viewer");
    expect(roleOf(final, STRANGER)).toBe("editor");
    expect(final?.version).toBe(3);
  });

  it("concurrent adds of the same address: exactly one wins", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const g = gated(inner);

    const result = await interleave(
      g,
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: ADMIN,
          change: { type: "add", address: NEWBIE, role: "viewer" },
        }),
      () =>
        applyCollaborationChange(g.store, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "add", address: NEWBIE, role: "admin" },
        })
    );

    expect((result as PromiseRejectedResult).reason.code).toBe("collaborator_exists");
    const final = inner.snapshot(PROJECT);
    expect(final?.collaborators.filter((c) => c.address === NEWBIE)).toEqual([
      { address: NEWBIE, role: "admin" },
    ]);
  });

  it("many parallel changes serialize into a consistent record", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const N = 20;
    const addresses = Array.from(
      { length: N },
      (_, i) => `GPARALLEL${String(i).padStart(46, "0")}`
    );

    // Parallel callers race on the same version; retries are bounded, so some
    // may legitimately give up with a conflict, but none may corrupt state.
    const results = await Promise.allSettled(
      addresses.map((address) =>
        applyCollaborationChange(inner, {
          projectId: PROJECT,
          actorAddress: OWNER,
          change: { type: "add", address, role: "viewer" },
        })
      )
    );

    const final = inner.snapshot(PROJECT)!;
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason.code).toBe("collaboration_change_conflict");
    }
    expect(final.version).toBe(1 + succeeded);
    expect(final.collaborators).toHaveLength(baseRecord().collaborators.length + succeeded);
    expect(new Set(final.collaborators.map((c) => c.address)).size).toBe(
      final.collaborators.length
    );
    expect(succeeded).toBeGreaterThanOrEqual(MAX_CHANGE_ATTEMPTS);
  });

  it("serial changes from one caller all succeed with monotonically increasing versions", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const versions: number[] = [];
    for (let i = 0; i < 10; i++) {
      const next = await applyCollaborationChange(inner, {
        projectId: PROJECT,
        actorAddress: OWNER,
        change: { type: "add", address: `GSERIAL${i}`, role: "viewer" },
      });
      versions.push(next.version);
    }
    expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("rejects a change prepared against a stale version without writing", async () => {
    const inner = createInMemoryCollaborationStore([{ ...baseRecord(), version: 7 }]);
    const code = await rejectionCode(
      applyCollaborationChange(inner, {
        projectId: PROJECT,
        actorAddress: OWNER,
        change: { type: "remove", address: VIEWER },
        expectedVersion: 6,
      })
    );
    expect(code).toBe("stale_collaboration_state");
    expect(inner.snapshot(PROJECT)?.version).toBe(7);
    expect(roleOf(inner.snapshot(PROJECT), VIEWER)).toBe("viewer");
  });

  it("accepts a change whose expected version is current", async () => {
    const inner = createInMemoryCollaborationStore([{ ...baseRecord(), version: 7 }]);
    const next = await applyCollaborationChange(inner, {
      projectId: PROJECT,
      actorAddress: OWNER,
      change: { type: "remove", address: VIEWER },
      expectedVersion: 7,
    });
    expect(next.version).toBe(8);
  });

  it("gives up with a conflict after MAX_CHANGE_ATTEMPTS lost races", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    let reads = 0;
    const alwaysLoses: CollaborationStore = {
      read: (id) => {
        reads++;
        return inner.read(id);
      },
      compareAndSet: async () => false,
    };
    const code = await rejectionCode(
      applyCollaborationChange(alwaysLoses, {
        projectId: PROJECT,
        actorAddress: OWNER,
        change: { type: "add", address: NEWBIE, role: "viewer" },
      })
    );
    expect(code).toBe("collaboration_change_conflict");
    expect(reads).toBe(MAX_CHANGE_ATTEMPTS);
    expect(inner.snapshot(PROJECT)).toEqual(baseRecord());
  });

  it("returns 404 for an unknown project", async () => {
    const inner = createInMemoryCollaborationStore([]);
    const code = await rejectionCode(
      applyCollaborationChange(inner, {
        projectId: "missing",
        actorAddress: OWNER,
        change: { type: "add", address: NEWBIE, role: "viewer" },
      })
    );
    expect(code).toBe("project_not_found");
  });

  it("records handed out by the store cannot be mutated in place", async () => {
    const inner = createInMemoryCollaborationStore([baseRecord()]);
    const record = await inner.read(PROJECT);
    record!.collaborators.push({ address: STRANGER, role: "admin" });
    record!.version = 99;
    expect(inner.snapshot(PROJECT)).toEqual(baseRecord());
  });
});

describe("planCollaborationChange authorization boundaries", () => {
  const plan = (actor: string, change: CollaborationChange) =>
    planCollaborationChange(baseRecord(), actor, change);
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "ok";
  };

  it.each<[string, string, CollaborationChange, string]>([
    ["owner promotes to admin", OWNER, { type: "set_role", address: EDITOR, role: "admin" }, "ok"],
    ["owner removes an admin", OWNER, { type: "remove", address: ADMIN }, "ok"],
    ["admin adds an editor", ADMIN, { type: "add", address: NEWBIE, role: "editor" }, "ok"],
    ["admin demotes an editor", ADMIN, { type: "set_role", address: EDITOR, role: "viewer" }, "ok"],
    ["admin removes a viewer", ADMIN, { type: "remove", address: VIEWER }, "ok"],
    [
      "admin grants admin",
      ADMIN,
      { type: "add", address: NEWBIE, role: "admin" },
      "permission_denied",
    ],
    [
      "admin promotes editor to admin",
      ADMIN,
      { type: "set_role", address: EDITOR, role: "admin" },
      "permission_denied",
    ],
    ["admin removes a peer admin", ADMIN, { type: "remove", address: ADMIN2 }, "permission_denied"],
    [
      "admin demotes itself",
      ADMIN,
      { type: "set_role", address: ADMIN, role: "viewer" },
      "permission_denied",
    ],
    [
      "editor adds a viewer",
      EDITOR,
      { type: "add", address: NEWBIE, role: "viewer" },
      "permission_denied",
    ],
    ["viewer removes an editor", VIEWER, { type: "remove", address: EDITOR }, "permission_denied"],
    [
      "stranger adds itself",
      STRANGER,
      { type: "add", address: STRANGER, role: "admin" },
      "permission_denied",
    ],
    ["owner removes the owner", OWNER, { type: "remove", address: OWNER }, "owner_immutable"],
    [
      "owner re-roles the owner",
      OWNER,
      { type: "set_role", address: ` ${OWNER} `, role: "viewer" },
      "owner_immutable",
    ],
    [
      "admin adds the owner",
      ADMIN,
      { type: "add", address: OWNER, role: "viewer" },
      "owner_immutable",
    ],
    [
      "owner grants owner role",
      OWNER,
      { type: "add", address: NEWBIE, role: "owner" as "admin" },
      "role_not_assignable",
    ],
    [
      "duplicate add with whitespace",
      OWNER,
      { type: "add", address: ` ${VIEWER}`, role: "editor" },
      "collaborator_exists",
    ],
    ["remove a non-member", OWNER, { type: "remove", address: NEWBIE }, "collaborator_not_found"],
    [
      "set_role on a non-member",
      OWNER,
      { type: "set_role", address: NEWBIE, role: "viewer" },
      "collaborator_not_found",
    ],
    [
      "empty address",
      OWNER,
      { type: "add", address: "   ", role: "viewer" },
      "invalid_collaborator",
    ],
  ])("%s -> %s", (_label, actor, change, expected) => {
    expect(codeOf(() => plan(actor, change))).toBe(expected);
  });

  it("does not mutate the input record", () => {
    const record = baseRecord();
    planCollaborationChange(record, OWNER, { type: "remove", address: VIEWER });
    expect(record).toEqual(baseRecord());
  });
});
