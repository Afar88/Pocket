import { describe, expect, it } from "vitest";
import {
  deserializeSession,
  serializeSession,
  signerFromPrivateKey,
  type Session
} from "@altananetwork/sdk";
import { agentEncKeypair, openSealed, sealToAgent } from "@pocket/core";
import { createPocketSession } from "../src/altana.js";
import type { AgentConfig } from "../src/config.js";
import type { PocketRecord } from "../src/types.js";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

const wallet = "0x1111111111111111111111111111111111111111" as Address;

function grantedSession(): { session: Session; secret: `0x${string}` } {
  // Mirrors the web grant flow: a fresh key, signerFromPrivateKey, and a
  // session object shaped like the grantSession result.
  const secret = generatePrivateKey();
  const signer = signerFromPrivateKey(secret);
  return {
    secret,
    session: {
      walletAddress: wallet,
      signer,
      publicKey: privateKeyToAccount(secret).publicKey,
      permissions: {
        calls: [{ to: wallet, signature: "transfer(address,uint256)" }],
        spend: [{ token: wallet, limit: 5_000_000n, period: "day" }]
      },
      expiry: Math.floor(Date.now() / 1000) + 86_400
    }
  };
}

describe("sealed session key hand-off", () => {
  it("round-trips a session key sealed in the web app and opened by the agent", () => {
    const agent = agentEncKeypair();
    const { session, secret } = grantedSession();

    // Web side: seal the key and persist serializeSession output.
    const sealed = sealToAgent(agent.publicKey, secret);
    const storedSession = JSON.stringify(serializeSession(session));

    // Agent side: open the ciphertext, rebuild signer and session.
    const openedKey = openSealed(agent.privateKey, sealed);
    expect(openedKey).toBe(secret);
    const restored = deserializeSession(
      JSON.parse(storedSession),
      signerFromPrivateKey(openedKey)
    );
    expect(restored.publicKey).toBe(session.publicKey);
    expect(restored.walletAddress).toBe(wallet);
    expect(restored.expiry).toBe(session.expiry);
  });

  it("keeps a still-live Altana key usable for an expiry skip after the Pocket payment cutoff", async () => {
    const agentKeys = agentEncKeypair();
    const { session, secret } = grantedSession();
    const now = Math.floor(Date.now() / 1000);
    const pocket = {
      id: 1n,
      owner: wallet,
      recipient: wallet,
      amountUsdt: 1_000_000n,
      payoutToken: wallet,
      period: 86_400n,
      nextDue: BigInt(now - 60),
      label: "Test",
      note: "",
      paused: false,
      closed: false,
      deleted: false,
      agent: wallet,
      sessionKeyId: keccak256(session.publicKey),
      sessionExpiry: BigInt(now - 1),
      usdtDailyCap: 5_000_000n,
      payoutDailyCap: 1_000_000n,
      minOutPerUsdt: 0n,
      lastSkippedDue: 0n,
      lastSkippedReason: 0,
      encryptedSessionKey: sealToAgent(agentKeys.publicKey, secret),
      serializedSession: JSON.stringify(serializeSession(session))
    } as PocketRecord;
    const config = { encPrivateKey: agentKeys.privateKey } as AgentConfig;
    const publicClient = {
      readContract: async () => true
    };
    const restored = await createPocketSession(config, publicClient, pocket);
    expect(restored.expiry).toBe(session.expiry);
  });

  it("fails to open a key sealed for a different agent", () => {
    const agent = agentEncKeypair();
    const other = agentEncKeypair();
    const { secret } = grantedSession();
    const sealed = sealToAgent(agent.publicKey, secret);
    expect(() => openSealed(other.privateKey, sealed)).toThrow(/AGENT_ENC_PRIVATE_KEY/);
  });

  it("refuses a stored session whose signer does not match the decrypted key", () => {
    const agent = agentEncKeypair();
    const { session, secret } = grantedSession();
    const storedSession = JSON.stringify(serializeSession(session));
    const openedKey = openSealed(agent.privateKey, sealToAgent(agent.publicKey, secret));
    expect(openedKey).toBe(secret);
    const wrongSigner = signerFromPrivateKey(generatePrivateKey());
    expect(() => deserializeSession(JSON.parse(storedSession), wrongSigner)).toThrow();
  });
});
