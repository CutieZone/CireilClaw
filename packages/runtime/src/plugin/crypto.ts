/* oxlint-disable typescript/promise-function-async, typescript/require-await
   -- host capability wrappers preserve the async SDK ABI around synchronous primitives and
      normalize synchronous authentication failures into rejected promises */

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes as randomBytesSync,
  sign as signData,
  verify as verifyData,
} from "node:crypto";
import type { KeyObject } from "node:crypto";

import type {
  CryptoKeyPairBytes,
  PluginCryptoApi,
  PluginIdsApi,
  XChaCha20Poly1305,
} from "@cireilclaw/sdk";
import { xchacha20poly1305 as createXChaCha20Poly1305 } from "@noble/ciphers/chacha.js";
import { ulid as createUlid } from "ulid";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function requireBytes(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a byte array`);
  }
  return value;
}

function requireLength(value: Uint8Array, length: number, name: string): Uint8Array {
  const bytes = requireBytes(value, name);
  if (bytes.length !== length) {
    throw new RangeError(`${name} must be ${length} bytes`);
  }
  return bytes;
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function publicKeyFromRaw(rawKey: Uint8Array, algorithm: "ed25519" | "x25519"): KeyObject {
  const prefix = algorithm === "ed25519" ? ED25519_SPKI_PREFIX : X25519_SPKI_PREFIX;
  return createPublicKey({
    format: "der",
    key: Buffer.concat([prefix, Buffer.from(requireLength(rawKey, 32, "publicKey"))]),
    type: "spki",
  });
}

function privateKeyFromPkcs8(privateKeyPkcs8: Uint8Array): KeyObject {
  return createPrivateKey({
    format: "der",
    key: Buffer.from(requireBytes(privateKeyPkcs8, "privateKeyPkcs8")),
    type: "pkcs8",
  });
}

function generateKeyPair(algorithm: "ed25519" | "x25519"): CryptoKeyPairBytes {
  const { privateKey, publicKey } =
    algorithm === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("x25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKeyPkcs8: new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" })),
    publicKey: new Uint8Array(publicDer.subarray(-32)),
  };
}

function randomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytesSync(requireNonNegativeSafeInteger(length, "length")));
}

function xchacha20poly1305(
  key: Uint8Array,
  nonce: Uint8Array,
  aad?: Uint8Array,
): XChaCha20Poly1305 {
  const cipher = createXChaCha20Poly1305(
    requireLength(key, 32, "key"),
    requireLength(nonce, 24, "nonce"),
    aad === undefined ? undefined : requireBytes(aad, "aad"),
  );
  return {
    decrypt: async (ciphertext): Promise<Uint8Array> =>
      cipher.decrypt(requireBytes(ciphertext, "ciphertext")),
    encrypt: async (plaintext): Promise<Uint8Array> =>
      cipher.encrypt(requireBytes(plaintext, "plaintext")),
  };
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      "sha256",
      Buffer.from(requireBytes(ikm, "ikm")),
      Buffer.from(requireBytes(salt, "salt")),
      Buffer.from(requireBytes(info, "info")),
      requireNonNegativeSafeInteger(length, "length"),
    ),
  );
}

const hostCrypto = {
  ed25519: {
    generateKeyPair: (): Promise<CryptoKeyPairBytes> => Promise.resolve(generateKeyPair("ed25519")),
    sign: (privateKeyPkcs8: Uint8Array, data: Uint8Array): Promise<Uint8Array> =>
      Promise.resolve(
        new Uint8Array(
          signData(
            // oxlint-disable-next-line unicorn/no-null -- Ed25519 has no digest algorithm.
            null,
            Buffer.from(requireBytes(data, "data")),
            privateKeyFromPkcs8(privateKeyPkcs8),
          ),
        ),
      ),
    verify: (publicKey: Uint8Array, signature: Uint8Array, data: Uint8Array): Promise<boolean> =>
      Promise.resolve(
        verifyData(
          // oxlint-disable-next-line unicorn/no-null -- Ed25519 has no digest algorithm.
          null,
          Buffer.from(requireBytes(data, "data")),
          publicKeyFromRaw(publicKey, "ed25519"),
          Buffer.from(requireBytes(signature, "signature")),
        ),
      ),
  },
  hkdf: (
    ikm: Uint8Array,
    salt: Uint8Array,
    info: Uint8Array,
    length: number,
  ): Promise<Uint8Array> => Promise.resolve(hkdf(ikm, salt, info, length)),
  randomBytes: (length: number): Promise<Uint8Array> => Promise.resolve(randomBytes(length)),
  x25519: {
    derive: (privateKeyPkcs8: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> =>
      Promise.resolve(
        new Uint8Array(
          diffieHellman({
            privateKey: privateKeyFromPkcs8(privateKeyPkcs8),
            publicKey: publicKeyFromRaw(publicKey, "x25519"),
          }),
        ),
      ),
    generateKeyPair: (): Promise<CryptoKeyPairBytes> => Promise.resolve(generateKeyPair("x25519")),
  },
  xchacha20poly1305: (key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array): XChaCha20Poly1305 =>
    xchacha20poly1305(key, nonce, aad),
} satisfies Omit<PluginCryptoApi, "loadNormalizedKey">;

const hostIds = {
  ulid: (): Promise<string> => Promise.resolve(createUlid()),
} satisfies PluginIdsApi;

export { hostCrypto, hostIds };
