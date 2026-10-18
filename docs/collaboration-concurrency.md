# Collaboration Changes: Concurrency and Isolation

Issue #1467. Code: [`backend/src/services/collaboration/membership-changes.ts`](../backend/src/services/collaboration/membership-changes.ts).
Tests: [`backend/src/services/collaboration/__tests__/membership-isolation.test.ts`](../backend/src/services/collaboration/__tests__/membership-isolation.test.ts).

## Invariant

> A membership or role change is authorized against the same record version it
> is written on top of.

Without this, two requests that interleave under Postgres's default
`READ COMMITTED` isolation produce a lost update with a privilege escalation:

1. Admin A reads the collaborator record (A is `admin`) and begins adding X.
2. The owner demotes A to `viewer` and commits.
3. A writes its change based on the record from step 1. This silently restores
   A to `admin` and grants X access.

The test suite includes a control case. It runs this interleaving against a
last-write-wins store and asserts that the escalation *does* happen there, which
shows that the version check is what blocks it.

## How it is enforced

`applyCollaborationChange(store, { projectId, actorAddress, change, expectedVersion? })`:

1. Reads the record (with its `version`).
2. Runs `planCollaborationChange`, a pure function that re-resolves the
   actor's role from **that** record and validates the change.
3. Calls `store.compareAndSet(projectId, version, next)`. If another change
   committed in between, the CAS fails, and the loop goes back to step 1. The
   change is re-authorized from scratch and never replayed against the old
   snapshot.
4. After `MAX_CHANGE_ATTEMPTS` (5) lost races it returns
   `409 collaboration_change_conflict`. Clients retry.

If the client sends `expectedVersion` (the version it displayed to the user), a
mismatch returns `409 stale_collaboration_state` immediately, with no silent
retry, because the user's decision was based on stale data.

## Authorization rules

| Rule | Error |
|---|---|
| Actor needs `project:update_collaborators` (owner or admin) on the current record | `403 permission_denied` |
| Non-owners may only modify members ranked strictly below them and grant roles strictly below them (admins cannot create, demote or remove admins, including themselves) | `403 permission_denied` |
| The owner's membership is changed only through ownership transfer | `409 owner_immutable` |
| `owner` is never assignable | `400 role_not_assignable` |
| Duplicate add (addresses compared after trimming) | `409 collaborator_exists` |
| Remove or re-role a non-member | `404 collaborator_not_found` |
| Unknown project | `404 project_not_found` |

## Requirements for a persistent store

`createInMemoryCollaborationStore` is atomic within one Node process. A
Postgres-backed `CollaborationStore` must provide the same compare-and-set
across processes. Either of these works:

```sql
-- Optimistic (preferred): a single conditional UPDATE; 0 rows = lost race.
UPDATE project_collaborators_state
   SET collaborators = $3, version = version + 1
 WHERE project_id = $1 AND version = $2;
```

```sql
-- Pessimistic: inside withTransaction(), lock the row before reading.
SELECT collaborators, version FROM project_collaborators_state
 WHERE project_id = $1 FOR UPDATE;
```

Do **not** implement `read` and `compareAndSet` as a plain `SELECT` followed by
an unconditional `UPDATE` in separate statements. Under `READ COMMITTED` that is
exactly the last-write-wins store from the control test. If the store runs at
`SERIALIZABLE` instead, map serialization failures (`40001`) to a `false` CAS
result so the retry loop re-authorizes.

## Validation

```bash
cd backend
npm test -- membership-isolation   # deterministic interleavings; no Postgres required
```
