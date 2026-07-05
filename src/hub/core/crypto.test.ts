import { randomBytes } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  decodeEncryptedBlob,
  decrypt,
  encodeEncryptedBlob,
  encrypt,
  InvalidEncryptionKeyError,
  parseEncryptionKey,
} from "./crypto.ts";

const KEY_HEX = "a".repeat(64); // 32 bytes

describe("parseEncryptionKey", () => {
  test("accepts a 64-char hex string", () => {
    const key = parseEncryptionKey(KEY_HEX);
    expect(key.length).toBe(32);
  });

  test("rejects a non-hex string", () => {
    expect(() => parseEncryptionKey("not-hex-at-all!!")).toThrow(InvalidEncryptionKeyError);
  });

  test("rejects a hex string of the wrong length", () => {
    expect(() => parseEncryptionKey("abcd")).toThrow(InvalidEncryptionKeyError);
  });
});

describe("encrypt / decrypt round-trip", () => {
  test("decrypts back to the original plaintext", () => {
    const key = parseEncryptionKey(KEY_HEX);
    const plaintext = new TextEncoder().encode("cookie=abc123; localStorage={}");
    const blob = encrypt(plaintext, key);
    const decrypted = decrypt(blob, key);
    expect(new TextDecoder().decode(decrypted)).toBe("cookie=abc123; localStorage={}");
  });

  test("uses a fresh IV each call, so identical plaintexts produce different ciphertext", () => {
    const key = parseEncryptionKey(KEY_HEX);
    const plaintext = new TextEncoder().encode("same value");
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.data).not.toBe(b.data);
  });

  test("fails to decrypt with the wrong key", () => {
    const key = parseEncryptionKey(KEY_HEX);
    const wrongKey = parseEncryptionKey(randomBytes(32).toString("hex"));
    const blob = encrypt(new TextEncoder().encode("secret"), key);
    expect(() => decrypt(blob, wrongKey)).toThrow();
  });

  test("fails to decrypt tampered ciphertext (GCM auth tag catches it)", () => {
    const key = parseEncryptionKey(KEY_HEX);
    const blob = encrypt(new TextEncoder().encode("secret"), key);
    const tamperedData = Buffer.from(blob.data, "base64");
    tamperedData[0] = (tamperedData[0]! + 1) % 256;
    const tampered = { ...blob, data: tamperedData.toString("base64") };
    expect(() => decrypt(tampered, key)).toThrow();
  });
});

describe("encodeEncryptedBlob / decodeEncryptedBlob", () => {
  test("round-trips through bytes", () => {
    const key = parseEncryptionKey(KEY_HEX);
    const blob = encrypt(new TextEncoder().encode("payload"), key);
    const bytes = encodeEncryptedBlob(blob);
    const decoded = decodeEncryptedBlob(bytes);
    expect(decoded).toEqual(blob);
    expect(new TextDecoder().decode(decrypt(decoded, key))).toBe("payload");
  });

  test("rejects bytes that aren't a valid encrypted blob", () => {
    expect(() => decodeEncryptedBlob(new TextEncoder().encode('{"not":"a blob"}'))).toThrow();
    expect(() => decodeEncryptedBlob(new TextEncoder().encode("not json"))).toThrow();
  });
});
