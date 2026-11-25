declare module "tweetnacl" {
  const nacl: {
    box: {
      keyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
      (message: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
      open(box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
    };
    randomBytes(n: number): Uint8Array;
  };
  export default nacl;
}
