import {
  CELO,
  createClient,
  deserializeSession,
  signerFromPrivateKey,
  type SerializedSession,
  type Session
} from "@altananetwork/sdk";
import {
  ALTANA_KEYSTORE,
  CELO_CHAIN_ID,
  ALTANA_KEYSTORE_ABI,
  openSealed
} from "@pocket/core";
import {
  getAddress,
  keccak256,
  type Address,
  type Hex
} from "viem";
import { assertAttributionTag, type AgentConfig } from "./config.js";
import type { PocketRecord, ExecuteResult } from "./types.js";

export type AgentSession = Session;

export function createAltana(config: AgentConfig) {
  // Pass through the exact ATTRIBUTION_TAG value used by the worker. Never
  // construct an Altana client capable of sending untagged transactions.
  assertAttributionTag(config.attributionTag);
  const client = createClient({ chains: [CELO], appCode: config.attributionTag });
  return { client };
}

/**
 * Rebuilds the owner's granted session for one pocket. The session private key
 * is stored on PocketRegistry sealed to the agent's X25519 key; the public
 * serializeSession half sits next to it. A revoke, a wrong ciphertext, or a
 * storage mismatch throws, and the runner skips just this pocket.
 */
export async function createPocketSession(
  config: AgentConfig,
  publicClient: unknown,
  pocket: PocketRecord
): Promise<AgentSession> {
  if (pocket.encryptedSessionKey === "0x" || !pocket.serializedSession) {
    throw new Error("Pocket has no stored session material; grant a session first.");
  }
  const sessionKey = openSealed(config.encPrivateKey, pocket.encryptedSessionKey);
  const signer = signerFromPrivateKey(sessionKey);
  const stored = JSON.parse(pocket.serializedSession) as SerializedSession;
  // deserializeSession refuses a signer that does not match the stored key.
  const session = deserializeSession(stored, signer);

  if (session.walletAddress.toLowerCase() !== pocket.agent.toLowerCase()) {
    // A pocket owner cannot point the worker at another wallet's sealed grant:
    // the Keystore checks the key, not which pocket may spend it.
    throw new Error("Stored session belongs to a different wallet than this pocket's approved agent.");
  }
  const derivedKeyId = keccak256(session.publicKey);
  if (derivedKeyId.toLowerCase() !== pocket.sessionKeyId.toLowerCase()) {
    throw new Error("Stored session key does not match the session key approved for this pocket.");
  }
  if (session.expiry <= Math.floor(Date.now() / 1000)) {
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

  session.walletAddress = getAddress(pocket.agent);
  return session;
}

export async function executeSessionCalls(
  client: ReturnType<typeof createAltana>["client"],
  session: AgentSession,
  calls: readonly { to: Address; data: Hex; value: bigint }[]
): Promise<ExecuteResult> {
  if (calls.length === 0) throw new Error("Refusing to submit an empty Altana session batch.");
  // Keep all settlement calls in this one SDK execution. Splitting the array
  // into multiple execute calls would break approval + payment atomicity.
  const result = await client.execute({
    session,
    calls: calls.map(({ to, data, value }) => ({ to, data, value })),
    chainId: CELO_CHAIN_ID
  });
  return {
    status: result.status,
    transactionHash: result.transactionHash
  };
}
