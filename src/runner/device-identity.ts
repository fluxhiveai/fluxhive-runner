/**
 * Device identity management for OpenClaw gateway authentication.
 *
 * Each machine gets a persistent ED25519 keypair stored at ~/.flux/device.json.
 * The device ID is derived from the SHA-256 hash of the raw public key.
 * This identity is used to authenticate with the OpenClaw gateway via
 * challenge/response signing.
 *
 * Also provides:
 *   - Gateway token auto-detection from ~/.openclaw/openclaw.json
 *   - Device token storage/retrieval at ~/.flux/device-tokens.json
 *     (tokens issued by the gateway, persisted across connections)
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** The fixed DER prefix for ED25519 SPKI encoding (used to extract raw 32-byte public key). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Encodes a buffer as URL-safe base64 (no padding). */
function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

/** Extracts the raw 32-byte ED25519 public key from PEM format. */
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

/** Derives the device ID as SHA-256 hex of the raw public key bytes. */
function deriveDeviceId(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return createHash("sha256").update(raw).digest("hex");
}

function getIdentityPath(): string {
  return join(homedir(), ".flux", "device.json");
}

/**
 * Loads the device identity from ~/.flux/device.json, or generates a new
 * ED25519 keypair and persists it. The file is created with mode 0600.
 */
export function loadOrCreateDeviceIdentity(): DeviceIdentity {
  const path = getIdentityPath();
  if (existsSync(path)) {
    const data = JSON.parse(readFileSync(path, "utf8")) as {
      publicKeyPem: string;
      privateKeyPem: string;
    };
    const deviceId = deriveDeviceId(data.publicKeyPem);
    return { deviceId, publicKeyPem: data.publicKeyPem, privateKeyPem: data.privateKeyPem };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  const dir = join(homedir(), ".flux");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify({ publicKeyPem, privateKeyPem }, null, 2), { mode: 0o600 });

  const deviceId = deriveDeviceId(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

/** Returns the raw public key as URL-safe base64 (for gateway auth payloads). */
export function publicKeyBase64Url(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return base64UrlEncode(raw);
}

/** Signs a payload string with the device's private key, returning URL-safe base64. */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = createPrivateKey(privateKeyPem);
  const sig = sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

/**
 * Builds the pipe-delimited auth payload string for gateway connect signing.
 * Format: v1|deviceId|clientId|clientMode|role|scopes|signedAtMs|token
 * (v2 adds |nonce at the end when challenge-response is used)
 */
export function buildDeviceAuthPayload(opts: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string;
  nonce?: string;
}): string {
  const scopesStr = opts.scopes.join(",");
  if (opts.nonce) {
    return `v2|${opts.deviceId}|${opts.clientId}|${opts.clientMode}|${opts.role}|${scopesStr}|${opts.signedAtMs}|${opts.token}|${opts.nonce}`;
  }
  return `v1|${opts.deviceId}|${opts.clientId}|${opts.clientMode}|${opts.role}|${scopesStr}|${opts.signedAtMs}|${opts.token}`;
}

// ---------------------------------------------------------------------------
// Gateway token auto-detection
// ---------------------------------------------------------------------------

/** Auto-detects the gateway token from ~/.openclaw/openclaw.json if configured. */
export function loadGatewayToken(): string | null {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(configPath)) return null;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const gateway = config.gateway as Record<string, unknown> | undefined;
    const auth = gateway?.auth as Record<string, unknown> | undefined;
    if (auth?.mode === "token" && typeof auth.token === "string") {
      return auth.token;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Device token storage (persisted across connections)
// ---------------------------------------------------------------------------

type StoredDeviceTokens = Record<string, { token: string; role: string; scopes: string[]; updatedAtMs: number }>;

function getDeviceTokensPath(): string {
  return join(homedir(), ".flux", "device-tokens.json");
}

function loadDeviceTokensFile(): StoredDeviceTokens {
  try {
    const p = getDeviceTokensPath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf8")) as StoredDeviceTokens;
  } catch {
    return {};
  }
}

function saveDeviceTokensFile(tokens: StoredDeviceTokens): void {
  const dir = join(homedir(), ".flux");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getDeviceTokensPath(), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

/** Loads a previously stored device token for the given device+role combination. */
export function loadDeviceToken(deviceId: string, role: string): string | null {
  const tokens = loadDeviceTokensFile();
  const key = `${deviceId}:${role}`;
  return tokens[key]?.token ?? null;
}

/** Persists a device token received from the gateway for future connections. */
export function storeDeviceToken(deviceId: string, role: string, token: string, scopes: string[]): void {
  const tokens = loadDeviceTokensFile();
  const key = `${deviceId}:${role}`;
  tokens[key] = { token, role, scopes, updatedAtMs: Date.now() };
  saveDeviceTokensFile(tokens);
}

/** Removes a stored device token (used when the gateway reports a mismatch). */
export function clearDeviceToken(deviceId: string, role: string): void {
  const tokens = loadDeviceTokensFile();
  const key = `${deviceId}:${role}`;
  delete tokens[key];
  saveDeviceTokensFile(tokens);
}
