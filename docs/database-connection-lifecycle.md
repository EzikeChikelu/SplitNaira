# Database Connection Lifecycle and Leak Regression Tests

Issue #1471. Code: [`backend/src/services/database.ts`](../backend/src/services/database.ts).
Tests: [`backend/src/__tests__/database-connection-leak.test.ts`](../backend/src/__tests__/database-connection-leak.test.ts).

## Guarantees

`withTransaction` checks one connection (`QueryRunner`) out of the pg pool per
attempt and **always** releases it, exactly once, on every path:

| Path | Outcome | Connection |
|---|---|---|
| Callback succeeds | commit, return result | released |
| Callback throws (request failure) | rollback, rethrow callback error | released |
| `connect()` / `startTransaction()` fails | rethrow | released |
| `commitTransaction()` fails | rollback, rethrow | released |
| `rollbackTransaction()` fails | log, rethrow **callback's** error | released; Postgres aborts the open transaction when the session is reset |
| `release()` fails | log, never thrown (a committed result is still returned) | release attempted once |
| Deadlock (`40P01`) retry | each attempt rolls back | each attempt's runner released (3 max) |
| Nested `withTransaction` | independent transactions | one connection per level, all released |

`closeDatabase` (called from the `SIGTERM`/`SIGINT` handler in `src/index.ts`):

1. waits for any in-flight `initDatabase()`;
2. **unregisters the data source before destroying it**, so a request arriving
   mid-shutdown fails fast with `Database not initialized` instead of checking
   a connection out of a pool being torn down;
3. destroys the pool. If `destroy()` rejects, the error propagates, but module
   state is already cleared: a second shutdown signal is a no-op and a later
   `initDatabase()` builds a fresh pool.

Before this change, a failed `destroy()` left the stale data source registered,
and transactions started during shutdown could still check out connections.
Two regression tests cover this. Both fail against the old implementation.

## How the tests detect leaks

The suite installs a fake pool via `setDataSourceForTests`. It counts
checked-out connections and open transactions, and records how many times each
runner was released. After each scenario it asserts:

- `checkedOut === 0` and `openTransactions === 0`;
- every runner created was released **exactly once**.

The scenarios cover each failure point in the table above, 50 concurrent mixed
success/failure transactions, an Express route that fails mid-transaction
(repeated 10 times, then a success), and the shutdown paths.

## Validation

```bash
cd backend
npm test -- database-connection-leak   # no Postgres required
npm run test:shutdown                    # real process + Postgres; CI only (CI=true, DATABASE_URL set)
```

## Pool settings

`DATABASE_POOL_MAX` (default 10), `DATABASE_POOL_IDLE_MS` (30000) and
`DATABASE_POOL_CONN_TIMEOUT_MS` (2000) are described in
[backend-env-vars.md](./backend-env-vars.md). A leaked connection shows up first
as pool-exhaustion timeouts (`timeout exceeded when trying to connect`). If you
see those in production, check for code that calls `createQueryRunner()`
directly instead of using `withTransaction`.
