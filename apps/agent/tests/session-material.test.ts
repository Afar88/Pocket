import { describe, expect, it } from "vitest";
import {
  deserializeSession,
  serializeSession,
  signerFromPrivateKey,
  type Session
} from "@altananetwork/sdk";
import { agentEncKeypair, openSealed, sealToAgent } from "@pocket/core";
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
