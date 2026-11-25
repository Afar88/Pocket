import nacl from "tweetnacl";
import { bytesToHex, hexToBytes, type Hex } from "viem";

const EPHEMERAL_KEY_LENGTH = 32;
const NONCE_LENGTH = 24;
const BOX_OVERHEAD = 16;

export const AGENT_ENC_KEY_LENGTH = 32;

/**
 * The Pocket worker's X25519 encryption keypair. The public half is shipped in
 * the web config (AGENT_ENC_PUBLIC_KEY); the private half only ever lives in
 * the worker's secret store (AGENT_ENC_PRIVATE_KEY).
 */
export function agentEncKeypair(): { publicKey: Hex; privateKey: Hex } {
  const keypair = nacl.box.keyPair();
  return {
    publicKey: bytesToHex(keypair.publicKey),
    privateKey: bytesToHex(keypair.secretKey)
  };
}

/**
 * Sealed box for the worker: the browser encrypts a fresh Altana session key so
 * that only the agent's private key can open it. Layout:
 * ephemeral public key (32) || nonce (24) || box.
 */
export function sealToAgent(agentPublicKey: Hex, message: Hex): Hex {
  const publicKey = hexToBytes(agentPublicKey);
  if (publicKey.length !== AGENT_ENC_KEY_LENGTH) {
    throw new Error("AGENT_ENC_PUBLIC_KEY must be a 32-byte public key.");
  }
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const boxed = nacl.box(hexToBytes(message), nonce, publicKey, ephemeral.secretKey);
  const sealed = new Uint8Array(EPHEMERAL_KEY_LENGTH + NONCE_LENGTH + boxed.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(nonce, EPHEMERAL_KEY_LENGTH);
  sealed.set(boxed, EPHEMERAL_KEY_LENGTH + NONCE_LENGTH);
  return bytesToHex(sealed);
}

/**
 * Worker side of sealToAgent. Throws when the ciphertext is malformed or was
 * sealed for a different key, so a corrupt record is skipped like a revoked one.
 */
export function openSealed(agentPrivateKey: Hex, sealed: Hex): Hex {
  const bytes = hexToBytes(sealed);
  if (bytes.length < EPHEMERAL_KEY_LENGTH + NONCE_LENGTH + BOX_OVERHEAD) {
    throw new Error("Encrypted session key is too short.");
  }
  const opened = nacl.box.open(
    bytes.slice(EPHEMERAL_KEY_LENGTH + NONCE_LENGTH),
    bytes.slice(EPHEMERAL_KEY_LENGTH, EPHEMERAL_KEY_LENGTH + NONCE_LENGTH),
    bytes.slice(0, EPHEMERAL_KEY_LENGTH),
    hexToBytes(agentPrivateKey)
  );
  if (!opened) {
    throw new Error("Encrypted session key does not open with AGENT_ENC_PRIVATE_KEY.");
  }
  return bytesToHex(opened);
}
