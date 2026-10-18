import { describe, expect, it } from "vitest";
import {
  FINALITY_POLICIES,
  FINALITY_STATES,
  FinalityPolicyError,
  STELLAR_NETWORK_PASSPHRASES,
  canTransitionFinality,
  evaluateFinality,
  getFinalityPolicy,
  isTerminalFinalityState,
  toTransactionStatus,
  type FinalityState,
} from "../services/ledger-finality.js";

const mainnet = FINALITY_POLICIES.mainnet;
const testnet = FINALITY_POLICIES.testnet;

function expectPolicyError(fn: () => unknown, code: FinalityPolicyError["code"]): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FinalityPolicyError);
    expect((error as FinalityPolicyError).code).toBe(code);
    return;
  }
  throw new Error(`expected FinalityPolicyError(${code})`);
}

describe("getFinalityPolicy", () => {
  it.each(Object.entries(STELLAR_NETWORK_PASSPHRASES))(
    "resolves %s by exact passphrase",
    (network, passphrase) => {
      expect(getFinalityPolicy(passphrase).network).toBe(network);
    }
  );

  it("tolerates surrounding whitespace from env files", () => {
    expect(getFinalityPolicy(`  ${STELLAR_NETWORK_PASSPHRASES.mainnet}\n`)).toBe(mainnet);
  });

  it.each([
    "",
    "mainnet",
    "Public Global Stellar Network",
    "test sdf network ; september 2015",
    "Private Net",
  ])("fails closed for unrecognised passphrase %j", (passphrase) => {
    expectPolicyError(() => getFinalityPolicy(passphrase), "unknown_network");
  });

  it("is stricter on mainnet than on resettable networks", () => {
    expect(mainnet.resetsPossible).toBe(false);
    expect(mainnet.confirmationDepth).toBeGreaterThanOrEqual(1);
    for (const policy of [
      FINALITY_POLICIES.testnet,
      FINALITY_POLICIES.futurenet,
      FINALITY_POLICIES.standalone,
    ]) {
      expect(policy.resetsPossible).toBe(true);
      expect(policy.confirmationDepth).toBeLessThanOrEqual(mainnet.confirmationDepth);
    }
  });

  it("policies are frozen so callers cannot weaken them at runtime", () => {
    expect(Object.isFrozen(FINALITY_POLICIES)).toBe(true);
  });
});

describe("finality state machine", () => {
  it("terminal states only transition to themselves", () => {
    for (const from of FINALITY_STATES.filter(isTerminalFinalityState)) {
      for (const to of FINALITY_STATES) {
        expect(canTransitionFinality(from, to)).toBe(from === to);
      }
    }
  });

  it("only `final` maps to a completed transaction", () => {
    const completed = FINALITY_STATES.filter((s) => toTransactionStatus(s) === "completed");
    expect(completed).toEqual(["final"]);
    expect(toTransactionStatus("expired")).toBe("failed");
    expect(toTransactionStatus("included")).toBe("pending");
  });
});

describe("evaluateFinality", () => {
  const base = { submittedAtLedger: 1000 };

  describe("success paths", () => {
    it("mainnet: included at depth 0, final once one more ledger closes", () => {
      const included = evaluateFinality({
        ...base,
        policy: mainnet,
        observation: { status: "SUCCESS", ledger: 1005 },
        latestLedger: 1005,
      });
      expect(included).toMatchObject({ state: "included", transactionStatus: "pending", depth: 0 });

      const final = evaluateFinality({
        ...base,
        policy: mainnet,
        previous: included.state,
        observation: { status: "SUCCESS", ledger: 1005 },
        latestLedger: 1006,
      });
      expect(final).toMatchObject({ state: "final", transactionStatus: "completed", depth: 1 });
    });

    it("testnet: final as soon as the inclusion ledger closes", () => {
      const result = evaluateFinality({
        ...base,
        policy: testnet,
        observation: { status: "SUCCESS", ledger: 1001 },
        latestLedger: 1001,
      });
      expect(result).toMatchObject({ state: "final", transactionStatus: "completed", depth: 0 });
    });

    it("stays submitted while within the timeout window", () => {
      const result = evaluateFinality({
        ...base,
        policy: mainnet,
        observation: { status: "NOT_FOUND" },
        latestLedger: 1000 + mainnet.submissionTimeoutLedgers,
      });
      expect(result).toMatchObject({
        state: "submitted",
        transactionStatus: "pending",
        depth: null,
      });
    });
  });

  describe("failure paths", () => {
    it("records an on-ledger failure as terminal failed", () => {
      const result = evaluateFinality({
        ...base,
        policy: mainnet,
        observation: { status: "FAILED", ledger: 1002 },
        latestLedger: 1002,
      });
      expect(result).toMatchObject({ state: "failed", transactionStatus: "failed" });
    });

    it("expires a transaction not seen past the policy timeout", () => {
      const result = evaluateFinality({
        ...base,
        policy: mainnet,
        observation: { status: "NOT_FOUND" },
        latestLedger: 1000 + mainnet.submissionTimeoutLedgers + 1,
      });
      expect(result).toMatchObject({ state: "expired", transactionStatus: "failed" });
    });

    it("throws finality_conflict when a final transaction is later reported failed", () => {
      expectPolicyError(
        () =>
          evaluateFinality({
            ...base,
            policy: mainnet,
            previous: "final",
            observation: { status: "FAILED", ledger: 1002 },
            latestLedger: 1010,
          }),
        "finality_conflict"
      );
    });

    it("throws finality_conflict when an expired transaction later lands", () => {
      expectPolicyError(
        () =>
          evaluateFinality({
            ...base,
            policy: mainnet,
            previous: "expired",
            observation: { status: "SUCCESS", ledger: 1200 },
            latestLedger: 1300,
          }),
        "finality_conflict"
      );
    });

    it("throws finality_conflict when an included success is later reported failed", () => {
      expectPolicyError(
        () =>
          evaluateFinality({
            ...base,
            policy: mainnet,
            previous: "included",
            observation: { status: "FAILED", ledger: 1002 },
            latestLedger: 1002,
          }),
        "finality_conflict"
      );
    });

    it.each([
      [{ status: "SUCCESS" as const }, 1005],
      [{ status: "FAILED" as const, ledger: 0 }, 1005],
      [{ status: "SUCCESS" as const, ledger: 1.5 }, 1005],
      [{ status: "SUCCESS" as const, ledger: 1001 }, -1],
      [{ status: "NOT_FOUND" as const }, Number.NaN],
    ])("rejects malformed observation %j at latest ledger %s", (observation, latestLedger) => {
      expectPolicyError(
        () => evaluateFinality({ ...base, policy: mainnet, observation, latestLedger }),
        "invalid_observation"
      );
    });
  });

  describe("boundaries", () => {
    it("timeout boundary: exactly submissionTimeoutLedgers is still pending, one more expires", () => {
      const at = (latestLedger: number) =>
        evaluateFinality({
          ...base,
          policy: testnet,
          observation: { status: "NOT_FOUND" },
          latestLedger,
        }).state;
      expect(at(1000 + testnet.submissionTimeoutLedgers)).toBe("submitted");
      expect(at(1000 + testnet.submissionTimeoutLedgers + 1)).toBe("expired");
    });

    it("validUntilLedger overrides the default timeout in both directions", () => {
      const at = (latestLedger: number, validUntilLedger: number) =>
        evaluateFinality({
          ...base,
          policy: mainnet,
          observation: { status: "NOT_FOUND" },
          latestLedger,
          validUntilLedger,
        }).state;
      // Bound still open even though the default window has passed.
      expect(at(1500, 1500)).toBe("submitted");
      // Bound closed well before the default window.
      expect(at(1011, 1010)).toBe("expired");
    });

    it("an RPC node behind the inclusion ledger never counts negative or positive depth", () => {
      const result = evaluateFinality({
        ...base,
        policy: mainnet,
        observation: { status: "SUCCESS", ledger: 1010 },
        latestLedger: 1008,
      });
      expect(result).toMatchObject({ state: "included", depth: 0 });
    });

    it.each<[FinalityState, "NOT_FOUND" | "SUCCESS"]>([
      ["included", "NOT_FOUND"],
      ["final", "NOT_FOUND"],
      ["expired", "NOT_FOUND"],
    ])("ignores a lagging read that would move %s back via %s", (previous, status) => {
      const result = evaluateFinality({
        ...base,
        policy: mainnet,
        previous,
        observation: { status },
        latestLedger: 1001,
      });
      expect(result.state).toBe(previous);
      expect(result.regressionIgnored).toBe(true);
    });

    it("ignores a lagging node that sees a final transaction at depth 0", () => {
      const result = evaluateFinality({
        ...base,
        policy: mainnet,
        previous: "final",
        observation: { status: "SUCCESS", ledger: 1005 },
        latestLedger: 1005,
      });
      expect(result).toMatchObject({
        state: "final",
        transactionStatus: "completed",
        regressionIgnored: true,
      });
    });
  });
});
