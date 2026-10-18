/**
 * Concurrency-safe collaborator membership and role changes (Issue #1467).
 *
 * Every change is authorized against the *same* record version it is written
 * on top of. The store must expose an atomic compare-and-set on a per-project
 * version, which is how the classic interleaving is blocked:
 *
 *   1. admin A reads the record (A is admin) and starts adding a new admin;
 *   2. the owner demotes A to viewer and commits;
 *   3. A's write is based on a version that no longer exists, so the CAS
 *      fails, A's change is re-read and re-authorized against the new record,
 *      and is denied because A is now a viewer.
 *
 * Without the version check, step 3 would be a lost update that let a
 * just-demoted collaborator grant admin rights. See
 * docs/collaboration-concurrency.md for the Postgres isolation requirements a
 * persistent store must meet.
 */

import { assertProjectPermission, type CollaboratorRole } from "./permissions.js";

export interface CollaboratorEntry {
  address: string;
  role: Exclude<CollaboratorRole, "owner">;
}

export interface CollaborationRecord {
  projectId: string;
  owner: string;
  collaborators: CollaboratorEntry[];
  /** Incremented on every committed change. */
  version: number;
}

export type CollaborationChange =
  | { type: "add"; address: string; role: CollaboratorEntry["role"] }
  | { type: "remove"; address: string }
  | { type: "set_role"; address: string; role: CollaboratorEntry["role"] };

export interface CollaborationStore {
  read(projectId: string): Promise<CollaborationRecord | null>;
  /**
   * Atomically replace the record if its version still equals
   * `expectedVersion`. Returns false (writing nothing) otherwise.
   */
  compareAndSet(
    projectId: string,
    expectedVersion: number,
    next: CollaborationRecord
  ): Promise<boolean>;
}

export const MAX_CHANGE_ATTEMPTS = 5;

const ROLE_RANK: Record<CollaboratorRole, number> = { owner: 3, admin: 2, editor: 1, viewer: 0 };
const ASSIGNABLE_ROLES: ReadonlySet<string> = new Set(["admin", "editor", "viewer"]);

function changeError(code: string, status: number, message: string): Error {
  return Object.assign(new Error(message), { code, status });
}

function normalize(address: string): string {
  return typeof address === "string" ? address.trim() : "";
}

/**
 * Validate a change against a record and return the next record. Pure: it
 * neither reads nor writes the store, so it can run inside any transaction.
 */
export function planCollaborationChange(
  record: CollaborationRecord,
  actorAddress: string,
  change: CollaborationChange
): CollaborationRecord {
  const actorRole = assertProjectPermission(record, actorAddress, "project:update_collaborators");
  const target = normalize(change.address);

  if (!target) {
    throw changeError("invalid_collaborator", 400, "Collaborator address is required.");
  }
  if (target === normalize(record.owner)) {
    throw changeError(
      "owner_immutable",
      409,
      "The owner's membership changes only through ownership transfer."
    );
  }
  if ("role" in change && !ASSIGNABLE_ROLES.has(change.role)) {
    throw changeError(
      "role_not_assignable",
      400,
      `Role ${String(change.role)} cannot be assigned.`
    );
  }

  const existing = record.collaborators.find((c) => normalize(c.address) === target);
  if (change.type === "add" && existing) {
    throw changeError("collaborator_exists", 409, "Address is already a collaborator.");
  }

  // Non-owners may only act on, and grant, roles strictly below their own, so
  // an admin can neither mint another admin nor remove a peer admin.
  const outranks = (role: CollaboratorRole) =>
    actorRole === "owner" || ROLE_RANK[actorRole] > ROLE_RANK[role];
  if (existing && !outranks(existing.role)) {
    throw changeError("permission_denied", 403, `${actorRole} cannot modify a ${existing.role}.`);
  }
  if ("role" in change && !outranks(change.role)) {
    throw changeError("permission_denied", 403, `${actorRole} cannot grant ${change.role}.`);
  }

  let collaborators: CollaboratorEntry[];
  switch (change.type) {
    case "add":
      collaborators = [...record.collaborators, { address: target, role: change.role }];
      break;
    case "remove":
      if (!existing)
        throw changeError("collaborator_not_found", 404, "Address is not a collaborator.");
      collaborators = record.collaborators.filter((c) => c !== existing);
      break;
    case "set_role":
      if (!existing)
        throw changeError("collaborator_not_found", 404, "Address is not a collaborator.");
      collaborators = record.collaborators.map((c) =>
        c === existing ? { ...c, role: change.role } : c
      );
      break;
    default:
      throw changeError("invalid_change", 400, "Unknown collaboration change.");
  }

  return { ...record, collaborators, version: record.version + 1 };
}

export interface ApplyCollaborationChangeInput {
  projectId: string;
  actorAddress: string;
  change: CollaborationChange;
  /**
   * Version the client based its decision on. When supplied, a mismatch is a
   * 409 rather than a silent retry, because the caller decided on stale data.
   */
  expectedVersion?: number;
}

/**
 * Apply a change with optimistic concurrency control. On a lost race the
 * record is re-read and the change is re-authorized from scratch; it is never
 * replayed against the record the caller first saw.
 */
export async function applyCollaborationChange(
  store: CollaborationStore,
  input: ApplyCollaborationChangeInput
): Promise<CollaborationRecord> {
  for (let attempt = 0; attempt < MAX_CHANGE_ATTEMPTS; attempt++) {
    const record = await store.read(input.projectId);
    if (!record) {
      throw changeError("project_not_found", 404, "Project collaboration record not found.");
    }
    if (input.expectedVersion !== undefined && record.version !== input.expectedVersion) {
      throw changeError(
        "stale_collaboration_state",
        409,
        "Collaborators changed since this request was prepared."
      );
    }

    const next = planCollaborationChange(record, input.actorAddress, input.change);
    if (await store.compareAndSet(input.projectId, record.version, next)) {
      return next;
    }
  }

  throw changeError(
    "collaboration_change_conflict",
    409,
    `Collaborators were modified concurrently ${MAX_CHANGE_ATTEMPTS} times; retry the request.`
  );
}

/** In-process store with an atomic compare-and-set; used in tests and local dev. */
export function createInMemoryCollaborationStore(
  initial: CollaborationRecord[] = []
): CollaborationStore & {
  snapshot(projectId: string): CollaborationRecord | undefined;
} {
  const records = new Map<string, CollaborationRecord>();
  const clone = (r: CollaborationRecord): CollaborationRecord => ({
    ...r,
    collaborators: r.collaborators.map((c) => ({ ...c })),
  });
  for (const record of initial) records.set(record.projectId, clone(record));

  return {
    async read(projectId) {
      const record = records.get(projectId);
      return record ? clone(record) : null;
    },
    async compareAndSet(projectId, expectedVersion, next) {
      const current = records.get(projectId);
      if (!current || current.version !== expectedVersion) return false;
      records.set(projectId, clone(next));
      return true;
    },
    snapshot(projectId) {
      const record = records.get(projectId);
      return record ? clone(record) : undefined;
    },
  };
}
