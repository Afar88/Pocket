import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CELO_RPC_DEFAULT } from "@pocket/core";

export type SignerConfig = {
  privateKey: Hex;
  rpcUrl: string;
  attributionTag: string;
};

// Registration and other one-off signing scripts only need the EOA key; the
// full AgentConfig also demands AGENT_ENC_PRIVATE_KEY and REGISTRY_ADDRESS,
// which are irrelevant off the payment loop.
export function readSignerConfig(env: NodeJS.ProcessEnv = process.env): SignerConfig {
  const privateKey = (env.AGENT_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("AGENT_PRIVATE_KEY must be a 32-byte 0x-prefixed private key.");
  }
  return {
    privateKey: privateKey as Hex,
    rpcUrl: (env.CELO_RPC ?? "").trim() || CELO_RPC_DEFAULT,
    attributionTag: env.ATTRIBUTION_TAG ?? ""
  };
}

export type AgentConfig = {
  /** Public address of the agent identity wallet (ERC-8004 owner). The payment loop never needs its private key. */
  agentAddress: Address;
  encPrivateKey: Hex;
  rpcUrl: string;
  attributionTag: string;
  registryAddress: Address;
};

// The payment loop only reports the agent's public identity. Prefer the public
// AGENT_ADDRESS so the scheduled workflow never handles the identity key; an
// AGENT_PRIVATE_KEY is still accepted (address derived, key discarded) for
// older setups.
function readAgentAddress(env: NodeJS.ProcessEnv): Address {
  const rawAddress = (env.AGENT_ADDRESS ?? "").trim();
  if (rawAddress) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(rawAddress)) throw new Error("AGENT_ADDRESS must be a 0x-prefixed 20-byte address.");
    return getAddress(rawAddress);
  }
  const privateKey = (env.AGENT_PRIVATE_KEY ?? "").trim();
  if (privateKey) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error("AGENT_PRIVATE_KEY must be a 32-byte 0x-prefixed private key.");
    }
    return privateKeyToAccount(privateKey as Hex).address;
  }
  throw new Error("AGENT_ADDRESS is required (the agent identity wallet's public address).");
}

export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const agentAddress = readAgentAddress(env);

  const encPrivateKey = (env.AGENT_ENC_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(encPrivateKey)) {
    throw new Error("AGENT_ENC_PRIVATE_KEY must be a 32-byte 0x-prefixed X25519 private key.");
  }

  const rawRegistry = (env.REGISTRY_ADDRESS ?? "").trim();
  if (!rawRegistry) throw new Error("REGISTRY_ADDRESS is required after PocketRegistry is deployed.");

  return {
    agentAddress,
    encPrivateKey: encPrivateKey as Hex,
    rpcUrl: (env.CELO_RPC ?? "").trim() || CELO_RPC_DEFAULT,
    // Preserve the exact value supplied by the deployment environment. Validation
    // rejects whitespace or invalid characters instead of silently changing the code.
    attributionTag: env.ATTRIBUTION_TAG ?? "",
    registryAddress: getAddress(rawRegistry)
  };
}

export function assertAttributionTag(tag: string): void {
  if (!tag) throw new Error("ATTRIBUTION_TAG is empty. Pocket will not submit transactions.");
  if (!/^[a-z0-9_]{1,32}$/.test(tag)) {
    throw new Error("ATTRIBUTION_TAG must be 1-32 lowercase letters, digits, or underscores.");
  }
}
