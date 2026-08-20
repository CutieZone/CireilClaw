import { describe, expect, it } from "vitest";

import { hostCrypto, hostIds } from "#plugin/crypto.js";

function bytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

describe("plugin host crypto", () => {
  it("generates random bytes with the requested length", async () => {
    const result = await hostCrypto.randomBytes(32);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result).toHaveLength(32);
  });

  it("signs and verifies Ed25519 data", async () => {
    const keyPair = await hostCrypto.ed25519.generateKeyPair();
    const message = new TextEncoder().encode("host-mediated signing");
    const signature = await hostCrypto.ed25519.sign(keyPair.privateKeyPkcs8, message);

    expect(keyPair.publicKey).toHaveLength(32);
    expect(signature).toHaveLength(64);
    await expect(hostCrypto.ed25519.verify(keyPair.publicKey, signature, message)).resolves.toBe(
      true,
    );
    await expect(
      hostCrypto.ed25519.verify(
        keyPair.publicKey,
        signature,
        new TextEncoder().encode("different message"),
      ),
    ).resolves.toBe(false);
  });

  it("derives the same X25519 secret from both sides", async () => {
    const alice = await hostCrypto.x25519.generateKeyPair();
    const bob = await hostCrypto.x25519.generateKeyPair();

    const aliceSecret = await hostCrypto.x25519.derive(alice.privateKeyPkcs8, bob.publicKey);
    const bobSecret = await hostCrypto.x25519.derive(bob.privateKeyPkcs8, alice.publicKey);

    expect(alice.publicKey).toHaveLength(32);
    expect(aliceSecret).toEqual(bobSecret);
  });

  it("matches the RFC 5869 HKDF-SHA-256 test vector", async () => {
    const result = await hostCrypto.hkdf(
      bytes("0b".repeat(22)),
      bytes("000102030405060708090a0b0c"),
      bytes("f0f1f2f3f4f5f6f7f8f9"),
      42,
    );

    expect(Buffer.from(result).toString("hex")).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  it("encrypts and decrypts XChaCha20-Poly1305 data", async () => {
    const key = bytes("00".repeat(32));
    const nonce = bytes("01".repeat(24));
    const aad = new TextEncoder().encode("associated data");
    const plaintext = new TextEncoder().encode("secret message");
    const cipher = hostCrypto.xchacha20poly1305(key, nonce, aad);
    const ciphertext = await cipher.encrypt(plaintext);

    expect(ciphertext).not.toEqual(plaintext);
    await expect(cipher.decrypt(ciphertext)).resolves.toEqual(plaintext);
    await expect(
      hostCrypto
        .xchacha20poly1305(key, nonce, new TextEncoder().encode("wrong aad"))
        .decrypt(ciphertext),
    ).rejects.toThrow();
  });
});

describe("plugin host ids", () => {
  it("generates canonical ULIDs", async () => {
    const first = await hostIds.ulid();
    const second = await hostIds.ulid();

    expect(first).toMatch(/^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/u);
    expect(second).toMatch(/^[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/u);
    expect(second).not.toBe(first);
  });
});
