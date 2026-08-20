/** A key normalized for Web Crypto import. */
interface WebCryptoFormat {
  format: "pkcs8" | "spki";
  data: string;
}

/** Raw public key plus PKCS#8 private key material for an asymmetric keypair. */
interface CryptoKeyPairBytes {
  privateKeyPkcs8: Uint8Array;
  publicKey: Uint8Array;
}

interface XChaCha20Poly1305 {
  encrypt(this: void, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(this: void, ciphertext: Uint8Array): Promise<Uint8Array>;
}

interface Ed25519Api {
  generateKeyPair(this: void): Promise<CryptoKeyPairBytes>;
  sign(this: void, privateKeyPkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
  verify(
    this: void,
    publicKey: Uint8Array,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

interface X25519Api {
  generateKeyPair(this: void): Promise<CryptoKeyPairBytes>;
  derive(this: void, privateKeyPkcs8: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array>;
}

interface PluginCryptoApi {
  /** Generate cryptographically secure random bytes on the runtime host. */
  randomBytes(this: void, length: number): Promise<Uint8Array>;
  /** Create an XChaCha20-Poly1305 operation with optional associated data. */
  xchacha20poly1305(
    this: void,
    key: Uint8Array,
    nonce: Uint8Array,
    aad?: Uint8Array,
  ): XChaCha20Poly1305;
  /** HKDF-SHA-256. */
  hkdf(
    this: void,
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array>;
  ed25519: Ed25519Api;
  x25519: X25519Api;
  /** Normalize a PEM/DER key to a Web-Crypto-compatible format. */
  loadNormalizedKey(
    this: void,
    opts: { path: string; kind?: "sandbox" | "host" } | { data: string },
  ): Promise<WebCryptoFormat>;
}

interface PluginIdsApi {
  ulid(this: void): Promise<string>;
}

export type {
  CryptoKeyPairBytes,
  Ed25519Api,
  PluginCryptoApi,
  PluginIdsApi,
  WebCryptoFormat,
  X25519Api,
  XChaCha20Poly1305,
};
