import { getAddress, type Address, type Hex } from "viem";
import { CELO_RPC_DEFAULT } from "@pocket/core";

export type AgentConfig = {
  privateKey: Hex;
  rpcUrl: string;
  attributionTag: string;
  registryAddress: Address;
};

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const privateKey = (env.AGENT_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("AGENT_PRIVATE_KEY must be a 32-byte 0x-prefixed private key.");
  }

  const rawRegistry = (env.REGISTRY_ADDRESS ?? "").trim();
  if (!rawRegistry) throw new Error("REGISTRY_ADDRESS is required after PocketRegistry is deployed.");

  return {
    privateKey: privateKey as Hex,
    rpcUrl: (env.CELO_RPC ?? "").trim() || CELO_RPC_DEFAULT,
    attributionTag: (env.ATTRIBUTION_TAG ?? "").trim(),
    registryAddress: getAddress(rawRegistry)
  };
}

export function assertAttributionTag(tag: string): void {
  if (!tag) throw new Error("ATTRIBUTION_TAG is empty. Pocket will not submit transactions.");
  if (!/^[a-z0-9_]{1,32}$/.test(tag)) {
    throw new Error("ATTRIBUTION_TAG must be 1-32 lowercase letters, digits, or underscores.");
  }
}
