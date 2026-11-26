import type { Address } from "viem";
import { CELO_USDT, POCKET_CURRENCIES, TEXTILE_REACTOR } from "./constants.js";

export type PocketSessionPolicy = {
  calls: readonly { to: Address; signature?: string }[];
  spend: readonly { token: Address; limit: bigint; period: "day" }[];
};

/** Build narrow transfer permissions for the corridor tokens currently used by this wallet. */
export function buildPocketSessionPolicy(input: {
  registryAddress: Address;
  usdtDailyCap: bigint;
  payoutTokens: readonly Address[];
  payoutDailyCaps: Readonly<Record<string, bigint>>;
}): PocketSessionPolicy {
  if (input.usdtDailyCap <= 0n) throw new Error("The USDT daily cap must be greater than zero.");
  const allowed = new Map(POCKET_CURRENCIES.map((currency) => [currency.address.toLowerCase(), currency.address]));
  const tokens = [...new Set(input.payoutTokens.map((token) => token.toLowerCase()))];
  if (tokens.length === 0) throw new Error("At least one payout currency is required.");
  for (const token of tokens) {
    if (!allowed.has(token)) throw new Error("A payout token is not in the Pocket currency list.");
    if ((input.payoutDailyCaps[token] ?? 0n) <= 0n) throw new Error("Each payout token needs a positive daily cap.");
  }

  const nonUsdt = tokens.some((token) => token !== CELO_USDT.toLowerCase());
  const calls: { to: Address; signature?: string }[] = tokens.map((token) => ({ to: allowed.get(token)!, signature: "transfer(address,uint256)" }));
  if (nonUsdt) calls.unshift(
    { to: TEXTILE_REACTOR, signature: "execute((bytes,bytes))" },
    { to: TEXTILE_REACTOR, signature: "executeBatch((bytes,bytes)[])" },
    { to: CELO_USDT, signature: "approve(address,uint256)" }
  );
  calls.push(
    { to: input.registryAddress, signature: "markPaid(uint256,address,uint256,uint256,uint64,bytes32)" },
    { to: input.registryAddress, signature: "skipPocket(uint256,uint8)" }
  );

  const limits = new Map<string, bigint>([[CELO_USDT.toLowerCase(), input.usdtDailyCap]]);
  for (const token of tokens) {
    const key = token.toLowerCase(), cap = input.payoutDailyCaps[key]!;
    const previous = limits.get(key) ?? 0n;
    if (key === CELO_USDT.toLowerCase()) {
      // Direct-USDT payouts are sender spend too; use the stricter of both caps.
      if (cap < previous) limits.set(key, cap);
    } else if (cap > previous) {
      limits.set(key, cap);
    }
  }
  return {
    calls,
    spend: [...limits.entries()].map(([token, limit]) => ({ token: token as Address, limit, period: "day" as const }))
  };
}
