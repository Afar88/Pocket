import type { Address } from "viem";
import { CELO_USDT, CNGN, TEXTILE_REACTOR } from "./constants.js";

export type PocketSessionPolicy = {
  /**
   * Altana supports method-level call permissions. Never allow the registry
   * address without a selector: the smart account is the msg.sender, so doing
   * so would let the agent exercise owner-only registry methods.
   */
  calls: readonly { to: Address; signature?: string }[];
  spend: readonly {
    token: Address;
    limit: bigint;
    period: "day";
  }[];
};

/**
 * Shared by the passkey UI when granting a key and by the worker when
 * reconstructing its session. Keep ordering and signatures identical.
 *
 * The reactor is limited to UniswapX order execution entry points. Before the
 * first live payment, compare the selector in Textile's returned swap calldata
 * with these signatures. An unknown selector must be reviewed, not added
 * blindly.
 */
export function buildPocketSessionPolicy(input: {
  registryAddress: Address;
  usdtDailyCap: bigint;
  cngnDailyCap: bigint;
}): PocketSessionPolicy {
  if (input.usdtDailyCap <= 0n || input.cngnDailyCap <= 0n) {
    throw new Error("Both daily token caps must be greater than zero.");
  }

  return {
    calls: [
      { to: TEXTILE_REACTOR, signature: "execute((bytes,bytes))" },
      { to: TEXTILE_REACTOR, signature: "executeBatch((bytes,bytes)[])" },
      { to: CELO_USDT, signature: "approve(address,uint256)" },
      { to: CNGN, signature: "transfer(address,uint256)" },
      { to: input.registryAddress, signature: "recordSwap(uint256,bytes32)" },
      { to: input.registryAddress, signature: "markPaid(uint256,bytes32)" }
    ],
    spend: [
      { token: CELO_USDT, limit: input.usdtDailyCap, period: "day" },
      { token: CNGN, limit: input.cngnDailyCap, period: "day" }
    ]
  };
}
