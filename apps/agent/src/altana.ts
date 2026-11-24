import {
  CELO,
  createClient,
  signerFromPrivateKey,
  type Session
} from "@altananetwork/sdk";
import {
  ALTANA_KEYSTORE,
  ALTANA_KEYSTORE_ABI,
  buildPocketSessionPolicy
} from "@pocket/core";
import {
  getAddress,
  keccak256,
  type Address,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentConfig } from "./config.js";
import type { PocketRecord, ExecuteResult } from "./types.js";

export type AgentSession = Session;

export function createAltana(config: AgentConfig) {
  // Altana's appCode adds the app attribution code to every relayed wallet call.
  const client = createClient({ chains: [CELO], appCode: config.attributionTag });
  return { client };
}

export async function createPocketSession(
  config: AgentConfig,
  publicClient: unknown,
  pocket: PocketRecord
): Promise<AgentSession> {
  const signer = signerFromPrivateKey(config.privateKey);
  const publicKey = privateKeyToAccount(config.privateKey).publicKey;

  const derivedKeyId = keccak256(publicKey);
  if (derivedKeyId.toLowerCase() !== pocket.sessionKeyId.toLowerCase()) {
    throw new Error("AGENT_PRIVATE_KEY does not match the session key approved for this pocket.");
  }
  if (pocket.sessionExpiry <= BigInt(Math.floor(Date.now() / 1000))) {
    throw new Error("Altana session expiry has passed.");
  }

  const keyStoreReader = publicClient as {
    readContract: (request: {
      address: Address;
      abi: typeof ALTANA_KEYSTORE_ABI;
      functionName: "isValidKey";
      args: readonly [Address, Hex];
    }) => Promise<boolean>;
  };
  const valid = await keyStoreReader.readContract({
    address: ALTANA_KEYSTORE,
    abi: ALTANA_KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [pocket.agent, pocket.sessionKeyId]
  });
  if (!valid) throw new Error("Altana Keystore says this session is revoked or invalid.");

  const permissions = buildPocketSessionPolicy({
    registryAddress: config.registryAddress,
    usdtDailyCap: pocket.usdtDailyCap,
    cngnDailyCap: pocket.cngnDailyCap
  });

  return {
    walletAddress: getAddress(pocket.agent),
    signer,
    publicKey,
    permissions,
    expiry: Number(pocket.sessionExpiry)
  };
}

export async function executeSessionCalls(
  client: ReturnType<typeof createAltana>["client"],
  session: AgentSession,
  calls: readonly { to: Address; data: Hex; value: bigint }[]
): Promise<ExecuteResult> {
  const result = await client.execute({ session, calls: [...calls], chainId: 42220 });
  return {
    status: result.status,
    transactionHash: result.transactionHash
  };
}
