import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, keccak256, toHex, type Hex } from "viem";
import type { RunnerDeps } from "../src/runner.js";
import { runDuePockets } from "../src/runner.js";
import type { FirmQuote, PocketRecord } from "../src/types.js";
import { CELO_USDT, ERC20_ABI, POCKET_REGISTRY_ABI, POCKET_CURRENCIES, TEXTILE_REACTOR } from "@pocket/core";

const address = "0x1111111111111111111111111111111111111111" as const;
const registry = "0x3333333333333333333333333333333333333333" as const;
const hash = ("0x" + "a".repeat(64)) as const;
const executeSelector = keccak256(toHex("execute((bytes,bytes))")).slice(0, 10);
const wBRL = POCKET_CURRENCIES.find((currency) => currency.symbol === "wBRL")!;

function pocket(overrides: Partial<PocketRecord> = {}): PocketRecord {
  return {
    id: 1n, owner: address, recipient: "0x2222222222222222222222222222222222222222",
    amountUsdt: 1_000_000n, payoutToken: POCKET_CURRENCIES[1]!.address,
    period: 86_400n, nextDue: 1n, label: "Test", note: "", paused: false, closed: false, deleted: false,
    agent: address, sessionKeyId: ("0x" + "b".repeat(64)) as Hex, sessionExpiry: 2_000_000_000n,
    usdtDailyCap: 5_000_000n, payoutDailyCap: 5_000_000_000_000_000_000n,
    minOutPerUsdt: 0n, lastSkippedDue: 0n, lastSkippedReason: 0,
    encryptedSessionKey: ("0x" + "c".repeat(96)) as Hex, serializedSession: "{}", ...overrides
  };
}

function quote(overrides: Partial<FirmQuote> = {}): FirmQuote {
  return {
    rfqId: "rfq_mock", claimToken: "rfqc_mock", taker: address, reactor: TEXTILE_REACTOR,
    takerPays: 1_000_000n, buyAmount: 4_000_000_000_000_000_000n,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    swap: { to: TEXTILE_REACTOR, data: (executeSelector + "00") as Hex, value: "0", chainId: 42220 },
    ...overrides
  };
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    now: () => Date.now(), registryAddress: registry, maxUsdtDailyCap: 5_000_000n,
    listPockets: async () => [pocket()], isSessionValid: async () => true,
    getQuote: async () => quote(), allowance: async () => 0n,
    execute: async () => ({ status: "CONFIRMED", transactionHash: hash }),
    verifyAttribution: vi.fn(async () => true), submitQuote: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, ...overrides
  };
}

describe("Pocket v2 agent runner", () => {
  it("pays a USDT pocket with a direct transfer and never calls Textile", async () => {
    const state = pocket({ payoutToken: CELO_USDT, amountUsdt: 1_000_000n, payoutDailyCap: 2_000_000n, period: 0n });
    const getQuote = vi.fn(async () => quote());
    const execute = vi.fn(async (_p: PocketRecord, calls: readonly { to: string; data: Hex }[]) => {
      expect(calls).toHaveLength(2);
      expect(calls[0]?.to).toBe(CELO_USDT);
      expect(decodeFunctionData({ abi: POCKET_REGISTRY_ABI, data: calls[1]!.data }).functionName).toBe("markPaid");
      state.closed = true;
      state.nextDue = 0n;
      return { status: "CONFIRMED" as const, transactionHash: hash };
    });
    await runDuePockets(deps({ listPockets: async () => [state], getQuote, execute }), "celo_pocket");
    expect(getQuote).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("requests a wBRL Textile quote with buyToken equal to the pocket payout token", async () => {
    const state = pocket({ payoutToken: wBRL.address });
    const getQuote = vi.fn(async (p: PocketRecord) => {
      expect(p.payoutToken).toBe(wBRL.address);
      return quote();
    });
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({ listPockets: async () => [state], getQuote, execute }), "celo_pocket");
    expect(getQuote).toHaveBeenCalledTimes(1);
    const calls = execute.mock.calls[0]?.[1];
    expect(calls?.some((call) => call.to.toLowerCase() === wBRL.address.toLowerCase())).toBe(true);
  });

  it("records a rate_below_floor skip and sends no payout or swap", async () => {
    const state = pocket({ payoutToken: wBRL.address, minOutPerUsdt: 5_000_000_000_000_000_000n });
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ listPockets: async () => [state], getQuote: async () => quote(), execute });
    await runDuePockets(d, "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
    const calls = execute.mock.calls[0]?.[1]!;
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: POCKET_REGISTRY_ABI, data: calls[0]!.data })).toMatchObject({
      functionName: "skipPocket", args: [1n, 1]
    });
    expect(calls.some((call) => call.to.toLowerCase() === wBRL.address.toLowerCase())).toBe(false);
    expect(calls.some((call) => call.to.toLowerCase() === TEXTILE_REACTOR.toLowerCase())).toBe(false);
  });

  it("never attempts a one-off pocket a second time after markPaid closes it", async () => {
    const state = pocket({ payoutToken: CELO_USDT, period: 0n, payoutDailyCap: 2_000_000n });
    const execute = vi.fn(async () => {
      state.closed = true;
      state.nextDue = 0n;
      return { status: "CONFIRMED" as const, transactionHash: hash };
    });
    const d = deps({ listPockets: async () => [state], execute });
    await runDuePockets(d, "celo_pocket");
    await runDuePockets(d, "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("pays a late due pocket once and advances exactly one period", async () => {
    const current = Math.floor(Date.now() / 1000);
    const state = pocket({ payoutToken: CELO_USDT, period: 86_400n, nextDue: BigInt(current - 4 * 86_400), payoutDailyCap: 2_000_000n });
    const execute = vi.fn(async () => {
      state.nextDue += state.period;
      return { status: "CONFIRMED" as const, transactionHash: hash };
    });
    await runDuePockets(deps({ listPockets: async () => [state], execute }), "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(state.nextDue).toBe(BigInt(current - 3 * 86_400));
  });

  it("does not execute when a token is not in the currency allowlist", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({ listPockets: async () => [pocket({ payoutToken: "0x4444444444444444444444444444444444444444" })], execute }), "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute an empty batch or an expired quote", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({
      listPockets: async () => [pocket()],
      getQuote: async () => quote({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      execute
    }), "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });
  it("keeps the PR #9 exact USDT approval and swap/payout/mark order", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({ listPockets: async () => [pocket({ payoutToken: wBRL.address })], execute, allowance: async () => 0n });
    await runDuePockets(d, "celo_pocket");
    const calls = execute.mock.calls[0]?.[1]!;
    expect(calls).toHaveLength(4);
    expect(calls[0]?.to).toBe(CELO_USDT);
    const approval = decodeFunctionData({ abi: ERC20_ABI, data: calls[0]!.data });
    expect(approval.functionName).toBe("approve");
    expect(approval.args).toEqual([TEXTILE_REACTOR, 1_000_000n]);
    expect(calls.map((item) => item.to)).toEqual([CELO_USDT, TEXTILE_REACTOR, wBRL.address, registry]);
    const mark = decodeFunctionData({ abi: POCKET_REGISTRY_ABI, data: calls[3]!.data });
    expect(mark.functionName).toBe("markPaid");
    expect(mark.args[4]).toBe(1n);
  });

  it("omits the exact approval when allowance already covers the quote", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({ listPockets: async () => [pocket({ payoutToken: wBRL.address })], execute, allowance: async () => 1_000_000n }), "celo_pocket");
    const calls = execute.mock.calls[0]?.[1]!;
    expect(calls).toHaveLength(3);
    expect(calls.some((item) => item.to.toLowerCase() === CELO_USDT.toLowerCase())).toBe(false);
  });

  it("refuses any swap selector outside the two PR #9 reactor entrypoints", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({
      listPockets: async () => [pocket({ payoutToken: wBRL.address })],
      execute,
      getQuote: async () => quote({ swap: { ...quote().swap, data: "0xdeadbeef00" as Hex } })
    });
    await runDuePockets(d, "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });

  it("re-checks quote expiry after allowance reads and refuses an expired batch", async () => {
    const q = quote();
    let now = Date.now();
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    const d = deps({
      now: () => now,
      listPockets: async () => [pocket({ payoutToken: wBRL.address })],
      getQuote: async () => q,
      allowance: async () => { now = Date.parse(q.expiresAt); return 0n; },
      execute
    });
    await runDuePockets(d, "celo_pocket");
    expect(execute).not.toHaveBeenCalled();
  });

  it("records over-cap output and never sends a payout or swap", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({
      listPockets: async () => [pocket({ payoutToken: wBRL.address, payoutDailyCap: 1n })],
      getQuote: async () => quote(),
      execute
    }), "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
    const calls = execute.mock.calls[0]?.[1]!;
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: POCKET_REGISTRY_ABI, data: calls[0]!.data }).functionName).toBe("skipPocket");
  });

  it("refuses a Textile sell amount above the USDT session cap", async () => {
    const execute = vi.fn(async () => ({ status: "CONFIRMED" as const, transactionHash: hash }));
    await runDuePockets(deps({
      listPockets: async () => [pocket({ payoutToken: wBRL.address })],
      getQuote: async () => quote({ takerPays: 6_000_000n }),
      execute
    }), "celo_pocket");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(decodeFunctionData({ abi: POCKET_REGISTRY_ABI, data: execute.mock.calls[0]![1][0]!.data }).functionName).toBe("skipPocket");
  });

});
