/**
 * Transaction finality policy by Stellar network (Issue #1478).
 *
 * Stellar closes ledgers with SCP, which gives deterministic finality: once a
 * ledger containing a transaction has closed, that transaction's result can
 * never be reorganised away. There are no probabilistic "N confirmations" as on
 * proof-of-work chains. What still varies per network is:
 *
 *  - how long we keep waiting for a submitted transaction before treating it as
 *    expired, and
 *  - how many ledgers must close *after* the inclusion ledger before the
 *    backend books the transaction as final. On mainnet we require one, so the
 *    load-balanced RPC we read from and the event listener have both moved past
 *    the inclusion ledger before money is reported as settled.
 *  - whether the network is periodically reset (testnet, futurenet, local
 *    standalone), which means "final" only holds until the next reset.
 *
 * The state machine is monotonic: a lagging RPC node that suddenly reports
 * `NOT_FOUND` for an already-included transaction cannot move it backwards, and
 * an observation that contradicts a terminal state is raised as an invariant
 * violation rather than silently rewriting a financial record.
 *
 * See docs/ledger-transaction-finality.md.
 */

import type { TransactionStatus } from "../entities/Transaction.js";

export const STELLAR_NETWORK_PASSPHRASES = {
  mainnet: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
} as const;

export type FinalityNetwork = keyof typeof STELLAR_NETWORK_PASSPHRASES;

export interface NetworkFinalityPolicy {
  network: FinalityNetwork;
  /** Ledgers that must close after the inclusion ledger before it is final. */
  confirmationDepth: number;
  /**
   * Ledgers to wait for a transaction with no known validity bound before it
   * is treated as expired. ~5–6s per ledger.
   */
  submissionTimeoutLedgers: number;
  /** The network may be wiped, invalidating previously final transactions. */
  resetsPossible: boolean;
}

export const FINALITY_POLICIES: Readonly<Record<FinalityNetwork, NetworkFinalityPolicy>> =
  Object.freeze({
    mainnet: {
      network: "mainnet",
      confirmationDepth: 1,
      submissionTimeoutLedgers: 120,
      resetsPossible: false,
    },
    testnet: {
      network: "testnet",
      confirmationDepth: 0,
      submissionTimeoutLedgers: 120,
      resetsPossible: true,
    },
    futurenet: {
      network: "futurenet",
      confirmationDepth: 0,
      submissionTimeoutLedgers: 120,
      resetsPossible: true,
    },
    standalone: {
      network: "standalone",
      confirmationDepth: 0,
      submissionTimeoutLedgers: 60,
      resetsPossible: true,
    },
  });

export const FINALITY_STATES = ["submitted", "included", "final", "failed", "expired"] as const;
export type FinalityState = (typeof FINALITY_STATES)[number];

const TERMINAL_STATES: ReadonlySet<FinalityState> = new Set(["final", "failed", "expired"]);

const ALLOWED_TRANSITIONS: Readonly<Record<FinalityState, readonly FinalityState[]>> = {
  submitted: ["submitted", "included", "final", "failed", "expired"],
  included: ["included", "final"],
  final: ["final"],
  failed: ["failed"],
  expired: ["expired"],
};

export class FinalityPolicyError extends Error {
  constructor(
    readonly code: "unknown_network" | "invalid_observation" | "finality_conflict",
    message: string
  ) {
    super(message);
    this.name = "FinalityPolicyError";
  }
}

/**
 * Resolves the finality policy for a configured network passphrase.
 *
 * Matches the passphrase exactly and fails closed: a typo or an unrecognised
 * private network must not silently inherit testnet's lax settings.
 */
export function getFinalityPolicy(networkPassphrase: string): NetworkFinalityPolicy {
  const trimmed = typeof networkPassphrase === "string" ? networkPassphrase.trim() : "";
  for (const [network, passphrase] of Object.entries(STELLAR_NETWORK_PASSPHRASES)) {
    if (passphrase === trimmed) {
      return FINALITY_POLICIES[network as FinalityNetwork];
    }
  }
  throw new FinalityPolicyError(
    "unknown_network",
    "No finality policy for the configured network passphrase."
  );
}

export function isTerminalFinalityState(state: FinalityState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionFinality(from: FinalityState, to: FinalityState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Maps a finality state onto the persisted transaction status. */
export function toTransactionStatus(state: FinalityState): TransactionStatus {
  switch (state) {
    case "final":
      return "completed";
    case "failed":
    case "expired":
      return "failed";
    default:
      return "pending";
  }
}

export interface FinalityObservation {
  /** Result of a `getTransaction`-style lookup. */
  status: "NOT_FOUND" | "SUCCESS" | "FAILED";
  /** Inclusion ledger; required when status is SUCCESS or FAILED. */
  ledger?: number;
}

export interface EvaluateFinalityInput {
  policy: NetworkFinalityPolicy;
  /** State recorded so far; defaults to `submitted`. */
  previous?: FinalityState;
  observation: FinalityObservation;
  /** Latest ledger the RPC node reports as closed. */
  latestLedger: number;
  /** Ledger that was current when the transaction was submitted. */
  submittedAtLedger: number;
  /**
   * Last ledger the transaction may land in (its ledger bound / time bound),
   * when known. After it closes the transaction can never be applied.
   */
  validUntilLedger?: number;
}

export interface FinalityEvaluation {
  state: FinalityState;
  transactionStatus: TransactionStatus;
  /** Ledgers closed after the inclusion ledger, when included. */
  depth: number | null;
  /** True when the observation would have moved the state backwards. */
  regressionIgnored: boolean;
}

function assertLedger(value: number | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new FinalityPolicyError(
      "invalid_observation",
      `${field} must be a positive integer ledger sequence.`
    );
  }
  return value;
}

function observedState(input: EvaluateFinalityInput): {
  state: FinalityState;
  depth: number | null;
} {
  const { policy, observation, latestLedger, submittedAtLedger, validUntilLedger } = input;

  if (observation.status === "NOT_FOUND") {
    const expired =
      validUntilLedger !== undefined
        ? latestLedger > validUntilLedger
        : latestLedger - submittedAtLedger > policy.submissionTimeoutLedgers;
    return { state: expired ? "expired" : "submitted", depth: null };
  }

  const ledger = assertLedger(observation.ledger, "observation.ledger");
  if (observation.status === "FAILED") {
    return { state: "failed", depth: Math.max(0, latestLedger - ledger) };
  }

  // A node behind the inclusion ledger is inconsistent; never count that as
  // depth, so it cannot fast-track finality.
  const depth = Math.max(0, latestLedger - ledger);
  return { state: depth >= policy.confirmationDepth ? "final" : "included", depth };
}

/**
 * Computes the next finality state from a fresh network observation.
 *
 * - Backwards observations (e.g. `NOT_FOUND` after `included`) keep the
 *   previous state and set `regressionIgnored`.
 * - Observations contradicting a terminal state (a `final` transaction now
 *   reported `FAILED`, or an `expired` one now landing) throw
 *   `finality_conflict` so the record is escalated instead of rewritten.
 */
export function evaluateFinality(input: EvaluateFinalityInput): FinalityEvaluation {
  assertLedger(input.latestLedger, "latestLedger");
  assertLedger(input.submittedAtLedger, "submittedAtLedger");
  if (input.validUntilLedger !== undefined) {
    assertLedger(input.validUntilLedger, "validUntilLedger");
  }

  const previous = input.previous ?? "submitted";
  const next = observedState(input);

  if (canTransitionFinality(previous, next.state)) {
    return {
      state: next.state,
      transactionStatus: toTransactionStatus(next.state),
      depth: next.depth,
      regressionIgnored: false,
    };
  }

  // `included` -> `submitted` is a lagging read; `final` -> `included` and
  // `expired` -> `submitted` are the same thing seen through a node that is
  // behind. All are safe to ignore.
  const isLaggingRead =
    (previous === "included" && next.state === "submitted") ||
    (previous === "final" && (next.state === "included" || next.state === "submitted")) ||
    (previous === "expired" && next.state === "submitted");

  if (isLaggingRead) {
    return {
      state: previous,
      transactionStatus: toTransactionStatus(previous),
      depth: next.depth,
      regressionIgnored: true,
    };
  }

  throw new FinalityPolicyError(
    "finality_conflict",
    `Observed ${next.state} contradicts recorded ${previous}; manual reconciliation required.`
  );
}
