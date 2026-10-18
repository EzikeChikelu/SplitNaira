/**
 * Connection leak regression tests (Issue #1471).
 *
 * Every path through `withTransaction` and `closeDatabase` — success, request
 * failure, infrastructure failure, deadlock retry, and shutdown — must hand
 * its connection back to the pool and leave no transaction open. The fake pool
 * below counts checked-out connections and open transactions so a leak shows
 * up as a non-zero count, not as a flaky timeout under load.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DataSource, QueryRunner } from "typeorm";
import {
  closeDatabase,
  getDataSource,
  setDataSourceForTests,
  withTransaction,
} from "../services/database.js";

type FailurePoint = "connect" | "startTransaction" | "commit" | "rollback" | "release";

interface FakeRunner {
  id: number;
  connected: boolean;
  inTransaction: boolean;
  releaseCalls: number;
}

class FakePool {
  readonly runners: FakeRunner[] = [];
  readonly failures = new Set<FailurePoint>();
  checkedOut = 0;
  openTransactions = 0;
  peakCheckedOut = 0;
  /** Runners released while a transaction was still open on them. */
  releasedMidTransaction = 0;
  destroyed = false;
  destroyError: Error | null = null;
  destroyGate: Promise<void> | null = null;

  asDataSource(): DataSource {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pool = this;
    return {
      get isInitialized() {
        return !pool.destroyed;
      },
      createQueryRunner: () => pool.createRunner(),
      destroy: async () => {
        if (pool.destroyGate) await pool.destroyGate;
        if (pool.destroyError) throw pool.destroyError;
        pool.destroyed = true;
      },
    } as unknown as DataSource;
  }

  private fail(point: FailurePoint): void {
    if (this.failures.has(point)) {
      throw new Error(`simulated ${point} failure`);
    }
  }

  private createRunner(): QueryRunner {
    const state: FakeRunner = {
      id: this.runners.length + 1,
      connected: false,
      inTransaction: false,
      releaseCalls: 0,
    };
    this.runners.push(state);

    return {
      manager: {},
      connect: async () => {
        this.fail("connect");
        state.connected = true;
        this.checkedOut++;
        this.peakCheckedOut = Math.max(this.peakCheckedOut, this.checkedOut);
      },
      startTransaction: async () => {
        this.fail("startTransaction");
        state.inTransaction = true;
        this.openTransactions++;
      },
      commitTransaction: async () => {
        this.fail("commit");
        state.inTransaction = false;
        this.openTransactions--;
      },
      rollbackTransaction: async () => {
        this.fail("rollback");
        if (state.inTransaction) {
          state.inTransaction = false;
          this.openTransactions--;
        }
      },
      release: async () => {
        state.releaseCalls++;
        // pg returns the client either way; a release error is reported after.
        if (state.connected) {
          state.connected = false;
          this.checkedOut--;
          if (state.inTransaction) {
            // Postgres aborts the transaction when the session is reset.
            state.inTransaction = false;
            this.openTransactions--;
            this.releasedMidTransaction++;
          }
        }
        this.fail("release");
      },
    } as unknown as QueryRunner;
  }
}

let pool: FakePool;

function expectNoLeaks(): void {
  expect(pool.checkedOut).toBe(0);
  expect(pool.openTransactions).toBe(0);
  for (const runner of pool.runners) {
    expect(runner.releaseCalls, `runner ${runner.id} release count`).toBe(1);
  }
}

beforeEach(() => {
  pool = new FakePool();
  setDataSourceForTests(pool.asDataSource());
});

afterEach(() => {
  setDataSourceForTests(null);
});

describe("withTransaction releases connections", () => {
  it("on success", async () => {
    await expect(withTransaction(async () => "ok")).resolves.toBe("ok");
    expect(pool.runners).toHaveLength(1);
    expectNoLeaks();
  });

  it("when the callback throws", async () => {
    await expect(
      withTransaction(async () => {
        throw new Error("constraint violation");
      })
    ).rejects.toThrow("constraint violation");
    expectNoLeaks();
    expect(pool.releasedMidTransaction).toBe(0);
  });

  it.each<[FailurePoint, string]>([
    ["connect", "simulated connect failure"],
    ["startTransaction", "simulated startTransaction failure"],
    ["commit", "simulated commit failure"],
  ])("when %s fails", async (point, message) => {
    pool.failures.add(point);
    await expect(withTransaction(async () => "ok")).rejects.toThrow(message);
    expectNoLeaks();
  });

  it("when rollback fails, surfacing the callback's error", async () => {
    pool.failures.add("rollback");
    await expect(
      withTransaction(async () => {
        throw new Error("business rule failed");
      })
    ).rejects.toThrow("business rule failed");
    expectNoLeaks();
    // The open transaction is aborted by the release, not left on the session.
    expect(pool.releasedMidTransaction).toBe(1);
  });

  it("when release itself fails, without replacing a committed result", async () => {
    pool.failures.add("release");
    await expect(withTransaction(async () => "committed")).resolves.toBe("committed");
    expectNoLeaks();
  });

  it("for every attempt of a deadlock retry", async () => {
    let attempts = 0;
    const result = await withTransaction(async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(pool.runners).toHaveLength(3);
    expectNoLeaks();
  });

  it("when deadlock retries are exhausted", async () => {
    await expect(
      withTransaction(async () => {
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      })
    ).rejects.toThrow("deadlock detected");
    expect(pool.runners).toHaveLength(3);
    expectNoLeaks();
  });

  it("holds one connection per nesting level and releases both", async () => {
    await withTransaction(async () => {
      await withTransaction(async () => {
        expect(pool.checkedOut).toBe(2);
      });
      expect(pool.checkedOut).toBe(1);
    });
    expectNoLeaks();
  });

  it("under concurrent mixed success and failure", async () => {
    const N = 50;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        withTransaction(async () => {
          await new Promise((r) => setTimeout(r, i % 5));
          if (i % 3 === 0) throw new Error(`fail ${i}`);
          return i;
        })
      )
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(Math.ceil(N / 3));
    expect(pool.peakCheckedOut).toBeGreaterThan(1);
    expect(pool.peakCheckedOut).toBeLessThanOrEqual(N);
    expectNoLeaks();
  });

  it("boundary: does not create a runner once the database is uninitialized", async () => {
    setDataSourceForTests(null);
    await expect(withTransaction(async () => "ok")).rejects.toThrow("Database not initialized");
    expect(pool.runners).toHaveLength(0);
  });
});

describe("HTTP request failures release connections", () => {
  function buildApp() {
    const app = express();
    app.get("/ok", async (_req, res, next) => {
      try {
        res.json({ value: await withTransaction(async () => "ok") });
      } catch (error) {
        next(error);
      }
    });
    app.get("/fail", async (_req, res, next) => {
      try {
        await withTransaction(async () => {
          throw new Error("handler failed mid-transaction");
        });
        res.json({});
      } catch (error) {
        next(error);
      }
    });
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: "internal_error" });
    });
    return app;
  }

  it("returns 500 and leaks nothing across repeated failing requests", async () => {
    const app = buildApp();
    for (let i = 0; i < 10; i++) {
      await request(app).get("/fail").expect(500);
    }
    await request(app).get("/ok").expect(200, { value: "ok" });
    expect(pool.runners).toHaveLength(11);
    expectNoLeaks();
  });
});

describe("shutdown releases the pool", () => {
  it("destroys the pool and refuses new transactions afterwards", async () => {
    await withTransaction(async () => "warm");
    await closeDatabase();

    expect(pool.destroyed).toBe(true);
    await expect(withTransaction(async () => "late")).rejects.toThrow("Database not initialized");
    expect(pool.runners).toHaveLength(1);
    expectNoLeaks();
  });

  it("rejects transactions that start while destroy is in progress", async () => {
    let finishDestroy: () => void = () => undefined;
    pool.destroyGate = new Promise((resolve) => {
      finishDestroy = resolve;
    });

    const closing = closeDatabase();
    await expect(withTransaction(async () => "during shutdown")).rejects.toThrow(
      "Database not initialized"
    );
    finishDestroy();
    await closing;

    expect(pool.runners).toHaveLength(0);
    expect(pool.destroyed).toBe(true);
  });

  it("clears module state even when destroy fails, so a restart is clean", async () => {
    pool.destroyError = new Error("pool end failed");
    await expect(closeDatabase()).rejects.toThrow("pool end failed");

    expect(() => getDataSource()).toThrow("Database not initialized");
    // A second shutdown signal must not re-run the failed destroy.
    await expect(closeDatabase()).resolves.toBeUndefined();
  });

  it("is idempotent when called twice", async () => {
    await closeDatabase();
    await expect(closeDatabase()).resolves.toBeUndefined();
    expect(pool.destroyed).toBe(true);
  });
});
