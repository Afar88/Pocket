import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import type { RunnerDeps } from "../src/runner.js";
import { runDuePockets } from "../src/runner.js";
import type { FirmQuote, PocketRecord } from "../src/types.js";
import { CELO_USDT, CNGN, ERC20_ABI, TEXTILE_REACTOR } from "@pocket/core";

const address = "0x1111111111111111111111111111111111111111" as const;
const registry = "0x3333333333333333333333333333333333333333" as const;
const hash = ("0x" + "a".repeat(64)) as const;
const executeSelector = keccak256(toHex("execute((bytes,bytes))")).slice(0, 10);

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
    cngnDailyCap: 5_000_000_000n,
    encryptedSessionKey: ("0x" + "c".repeat(96)) as const,
    serializedSession: "{}"
  };
}

function quote(): FirmQuote {
  const tx = {
    to: TEXTILE_REACTOR,
    data: (executeSelector + "00") as Hex,
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
    verifyAttribution: vi.fn(async () => true),
    submitQuote: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides
  };
}

describe("Pocket agent runner", () => {
  it("pays a pocket whose owner has a valid session while another owner's revoked key only fails its own pocket", async () => {
    const revoked = { ...pocket(), id: 1n, owner: "0x4444444444444444444444444444444444444444" as const };
    const active = { ...pocket(), id: 2n, owner: "0x5555555555555555555555555555555555555555" as const };
    const executedFor: bigint[] = [];
    const execute = vi.fn(async (p: PocketRecord) => {
      executedFor.push(p.id);
      return { status: "CONFIRMED" as const, transactionHash: hash };
    });
    const d = deps({
      listPockets: async () => [revoked, active],
      isSessionValid: async (p) => p.id === 2n,
      execute
    });
    await runDuePockets(d, "celo_pocket");
    expect(executedFor).toEqual([2n]);
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("does not pay a pocket twice when a run repeats", async () => {
    const state = { ...pocket(), period: 30_000_000_000n };
    const execute = vi.fn(async (_p: PocketRecord, calls: readonly { to: string }[]) => {
      // The one atomic Altana batch contains approval plus settlement when needed.
      if (calls.length === 5) state.nextDue += state.period;
      return { status: "CONFIRMED" as const, transactionHash: hash };
    });
    const d = deps({ listPockets: async () => [state], execute });
    await runDuePockets(d, "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
    await runDuePockets(d, "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not execute anything when ATTRIBUTION_TAG is empty", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ execute });
    await runDuePockets(d, "  ");
    expect(execute).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalled();
  });

  it("does not execute when the Altana session is invalid", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({ isSessionValid: async () => false, execute }), "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });

  it("puts an exact Textile-reactor approval in the same batch when allowance is too low", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ execute, allowance: async () => 999_999n });
    await runDuePockets(d, "celo_pocket");

    expect(execute).toHaveBeenCalledTimes(1);
    const calls = execute.mock.calls[0]?.[1];
    expect(calls).toHaveLength(5);
    expect(calls?.[0]?.to).toBe(CELO_USDT);
    const approval = decodeFunctionData({ abi: ERC20_ABI, data: calls![0]!.data });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([TEXTILE_REACTOR, 1_000_000n]);
    expect(calls?.slice(1).map((item) => item.to)).toEqual([
      TEXTILE_REACTOR,
      CNGN,
      registry,
      registry
    ]);
  });

  it("omits approval when the current allowance already covers the quote", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ execute, allowance: async () => 1_000_000n });
    await runDuePockets(d, "celo_pocket");

    expect(execute).toHaveBeenCalledTimes(1);
    const calls = execute.mock.calls[0]?.[1];
    expect(calls).toHaveLength(4);
    expect(calls?.some((item) => item.to.toLowerCase() === CELO_USDT.toLowerCase())).toBe(false);
  });

  it("refuses a swap selector outside the two supported Altana reactor entrypoints", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({
      execute,
      getQuote: async () => ({ ...quote(), swap: { ...quote().swap, data: "0xdeadbeef00" as Hex } })
    });
    await runDuePockets(d, "celo_pocket");

    expect(execute).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining("0xdeadbeef") })
    );
  });

  it("refuses an expired quote before executing any part of settlement", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({
      execute,
      getQuote: async () => ({ ...quote(), expiresAt: new Date(Date.now() - 1_000).toISOString() })
    });
    await runDuePockets(d, "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
    expect(d.logger.error).toHaveBeenCalled();
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
