import { describe, expect, it, vi } from "vitest";
import type { RunnerDeps } from "../src/runner.js";
import { runDuePockets } from "../src/runner.js";
import type { FirmQuote, PocketRecord } from "../src/types.js";
import { CELO_USDT, TEXTILE_REACTOR } from "@pocket/core";

const address = "0x1111111111111111111111111111111111111111" as const;
const registry = "0x3333333333333333333333333333333333333333" as const;
const hash = ("0x" + "a".repeat(64)) as const;

function pocket(): PocketRecord {
  return {
    id: 1n,
    owner: address,
    recipient: "0x2222222222222222222222222222222222222222",
    amountUsdt: 1_000_000n,
    period: 86_400n,
    nextDue: 1n,
    label: "Test",
    paused: false,
    deleted: false,
    agent: address,
    sessionKeyId: ("0x" + "b".repeat(64)) as const,
    sessionExpiry: 2_000_000_000n,
    usdtDailyCap: 5_000_000n,
    cngnDailyCap: 5_000_000_000n
  };
}

function quote(): FirmQuote {
  const tx = {
    to: TEXTILE_REACTOR,
    data: "0x1234" as const,
    value: "0",
    chainId: 42220
  };
  return {
    rfqId: "rfq_mock",
    claimToken: "rfqc_mock",
    taker: address,
    reactor: TEXTILE_REACTOR,
    takerPays: 1_000_000n,
    buyAmount: 1_000_000_000n,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approval: { ...tx, to: CELO_USDT },
    swap: tx
  };
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => Date.now(),
    registryAddress: registry,
    maxUsdtDailyCap: 5_000_000n,
    listPockets: async () => [pocket()],
    isSessionValid: async () => true,
    getQuote: async () => quote(),
    allowance: async () => 0n,
    execute: async () => ({ status: "CONFIRMED", transactionHash: hash }),
    verifyAttribution: async () => true,
    submitQuote: async () => undefined,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides
  };
}

describe("Pocket agent runner", () => {
  it("does not execute anything when ATTRIBUTION_TAG is empty", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ execute });
    await runDuePockets(d, "");
    expect(execute).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("does not execute when the Altana session is invalid", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({ isSessionValid: async () => false, execute }), "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes approval and one atomic settlement batch through Altana", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ execute });
    await runDuePockets(d, "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[1]).toHaveLength(4);
    expect(d.verifyAttribution).toHaveBeenCalledTimes(1);
    expect(d.verifyAttribution).toHaveBeenCalledWith(hash);
    expect(d.submitQuote).toHaveBeenCalledTimes(1);
    expect(d.logger.info).toHaveBeenCalled();
  });

  it("does not send the swap after approval if the quote has expired", async () => {
    let time = Date.now();
    const execute = vi.fn(async () => {
      time += 120_000;
      return { status: "CONFIRMED" as const, transactionHash: hash };
    });
    const d = deps({ now: () => time, execute });
    await runDuePockets(d, "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(d.submitQuote).not.toHaveBeenCalled();
  });

  it("does not execute when the cNGN output exceeds its cap", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({
      execute,
      getQuote: async () => ({ ...quote(), buyAmount: 9_000_000_000n })
    });
    await runDuePockets(d, "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute when the USDt session cap exceeds the 5 USDt safety ceiling", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ maxUsdtDailyCap: 4_000_000n, execute });
    await runDuePockets(d, "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });
});
