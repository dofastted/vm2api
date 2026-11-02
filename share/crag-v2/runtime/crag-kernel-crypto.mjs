import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";

const MAGIC = Buffer.from("CRAGK1");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function parseKernelKey(value) {
	const raw = String(value || "").trim();
	if (!/^[0-9a-f]{64}$/i.test(raw))
		throw new Error("CRAG kernel key must be 64 hexadecimal characters");
	return Buffer.from(raw, "hex");
}

export function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

export function encryptKernel(plaintext, key) {
	if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES)
		throw new Error("kernel encryption key must be 32 bytes");
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([MAGIC, nonce, tag, ciphertext]);
}

export function decryptKernel(payload, key) {
	if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES)
		throw new Error("kernel encryption key must be 32 bytes");
	if (payload.length < MAGIC.length + NONCE_BYTES + TAG_BYTES)
		throw new Error("encrypted kernel payload is truncated");
	if (!payload.subarray(0, MAGIC.length).equals(MAGIC))
		throw new Error("encrypted kernel payload has an invalid header");
	const nonceStart = MAGIC.length;
	const tagStart = nonceStart + NONCE_BYTES;
	const dataStart = tagStart + TAG_BYTES;
	const nonce = payload.subarray(nonceStart, tagStart);
	const tag = payload.subarray(tagStart, dataStart);
	const ciphertext = payload.subarray(dataStart);
	const decipher = createDecipheriv("aes-256-gcm", key, nonce);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
