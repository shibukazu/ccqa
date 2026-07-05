import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * At-rest encryption for session state and variable values. Encryption
 * happens here, one layer above `HubStorage` — the storage backend only
 * ever sees the resulting opaque bytes, so a future backend (SQLite, a
 * remote DB) never needs to know secrets exist, let alone how they're
 * protected.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class InvalidEncryptionKeyError extends Error {
  constructor(reason: string) {
    super(`CCQA_HUB_ENCRYPTION_KEY is invalid: ${reason} (expected a 64-character hex string, i.e. 32 bytes)`);
    this.name = "InvalidEncryptionKeyError";
  }
}

/** Parse and validate the encryption key from its hex env-var form. */
export function parseEncryptionKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new InvalidEncryptionKeyError("not a hex string");
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new InvalidEncryptionKeyError(`decoded to ${key.length} bytes, expected ${KEY_BYTES}`);
  }
  return key;
}

const EncryptedBlobSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
});
export type EncryptedBlob = z.infer<typeof EncryptedBlobSchema>;

/** Encrypt `plaintext` with AES-256-GCM. A fresh random IV is generated per call. */
export function encrypt(plaintext: Uint8Array, key: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("base64"), tag: tag.toString("base64"), data: data.toString("base64") };
}

/**
 * Decrypt a blob produced by `encrypt`. Throws (via GCM's built-in
 * authentication) if `key` is wrong or the ciphertext/tag was tampered with
 * — decryption failure and integrity failure are indistinguishable by
 * design, so callers can't be tricked into accepting corrupted data.
 */
export function decrypt(blob: EncryptedBlob, key: Buffer): Uint8Array {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]);
  return new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
}

/** Serialize an `EncryptedBlob` to the bytes a `SecretStore` persists. */
export function encodeEncryptedBlob(blob: EncryptedBlob): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(blob));
}

/** Inverse of `encodeEncryptedBlob`. Throws on bytes that aren't a valid blob (including non-JSON). */
export function decodeEncryptedBlob(bytes: Uint8Array): EncryptedBlob {
  const parsed = EncryptedBlobSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success) throw new Error("stored secret is not a valid encrypted blob");
  return parsed.data;
}
