import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash, generateKeyPairSync, createPublicKey } from "node:crypto";

// ---------------------------------------------------------------------------
// We mock the homedir() call and filesystem so tests don't touch real ~/.flux
// ---------------------------------------------------------------------------

let tempDir: string;

vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tempDir,
    },
    homedir: () => tempDir,
  };
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "flux-device-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Import after mock so the module picks up the mocked homedir
const {
  loadOrCreateDeviceIdentity,
  publicKeyBase64Url,
  signDevicePayload,
  buildDeviceAuthPayload,
  loadGatewayToken,
  loadDeviceToken,
  storeDeviceToken,
  clearDeviceToken,
} = await import("../../src/runner/device-identity.ts");

// ---------------------------------------------------------------------------
// loadOrCreateDeviceIdentity
// ---------------------------------------------------------------------------

describe("loadOrCreateDeviceIdentity", () => {
  it("creates a new identity when none exists", () => {
    const identity = loadOrCreateDeviceIdentity();

    expect(identity.deviceId).toBeTruthy();
    expect(typeof identity.deviceId).toBe("string");
    expect(identity.deviceId.length).toBe(64); // SHA-256 hex
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
    expect(identity.privateKeyPem).toContain("BEGIN PRIVATE KEY");

    // File should be persisted
    const filePath = path.join(tempDir, ".flux", "device.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("loads existing identity on subsequent calls", () => {
    const first = loadOrCreateDeviceIdentity();
    const second = loadOrCreateDeviceIdentity();

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
  });

  it("derives deviceId consistently from the same public key", () => {
    const identity = loadOrCreateDeviceIdentity();

    // Manually derive what the device ID should be from the public key
    const key = createPublicKey(identity.publicKeyPem);
    const spki = key.export({ type: "spki", format: "der" });

    const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
    let rawKey: Buffer;
    if (
      spki.length === ED25519_SPKI_PREFIX.length + 32 &&
      spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
      rawKey = spki.subarray(ED25519_SPKI_PREFIX.length);
    } else {
      rawKey = Buffer.from(spki);
    }

    const expectedId = createHash("sha256").update(rawKey).digest("hex");
    expect(identity.deviceId).toBe(expectedId);
  });

  it("creates .flux directory if it doesn't exist", () => {
    loadOrCreateDeviceIdentity();
    expect(fs.existsSync(path.join(tempDir, ".flux"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// publicKeyBase64Url
// ---------------------------------------------------------------------------

describe("publicKeyBase64Url", () => {
  it("encodes public key as base64url", () => {
    const identity = loadOrCreateDeviceIdentity();
    const encoded = publicKeyBase64Url(identity.publicKeyPem);

    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    // base64url should not contain + / =
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("produces consistent output for the same key", () => {
    const identity = loadOrCreateDeviceIdentity();
    expect(publicKeyBase64Url(identity.publicKeyPem)).toBe(
      publicKeyBase64Url(identity.publicKeyPem),
    );
  });
});

// ---------------------------------------------------------------------------
// signDevicePayload
// ---------------------------------------------------------------------------

describe("signDevicePayload", () => {
  it("produces a base64url-encoded signature", () => {
    const identity = loadOrCreateDeviceIdentity();
    const signature = signDevicePayload(identity.privateKeyPem, "test-payload");

    expect(typeof signature).toBe("string");
    expect(signature.length).toBeGreaterThan(0);
    // base64url chars
    expect(signature).not.toContain("+");
    expect(signature).not.toContain("/");
    expect(signature).not.toContain("=");
  });

  it("produces different signatures for different payloads", () => {
    const identity = loadOrCreateDeviceIdentity();
    const sig1 = signDevicePayload(identity.privateKeyPem, "payload-a");
    const sig2 = signDevicePayload(identity.privateKeyPem, "payload-b");
    expect(sig1).not.toBe(sig2);
  });

  it("produces deterministic signatures for the same payload", () => {
    const identity = loadOrCreateDeviceIdentity();
    const sig1 = signDevicePayload(identity.privateKeyPem, "same-payload");
    const sig2 = signDevicePayload(identity.privateKeyPem, "same-payload");
    expect(sig1).toBe(sig2);
  });
});

// ---------------------------------------------------------------------------
// buildDeviceAuthPayload
// ---------------------------------------------------------------------------

describe("buildDeviceAuthPayload", () => {
  it("builds v1 payload without nonce", () => {
    const result = buildDeviceAuthPayload({
      deviceId: "dev-123",
      clientId: "client-1",
      clientMode: "backend",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      signedAtMs: 1700000000000,
      token: "tok-abc",
    });

    expect(result).toBe(
      "v1|dev-123|client-1|backend|operator|operator.read,operator.write|1700000000000|tok-abc",
    );
  });

  it("builds v2 payload with nonce", () => {
    const result = buildDeviceAuthPayload({
      deviceId: "dev-123",
      clientId: "client-1",
      clientMode: "backend",
      role: "operator",
      scopes: ["operator.read"],
      signedAtMs: 1700000000000,
      token: "tok-xyz",
      nonce: "nonce-abc",
    });

    expect(result).toBe(
      "v2|dev-123|client-1|backend|operator|operator.read|1700000000000|tok-xyz|nonce-abc",
    );
  });

  it("includes all fields in correct order", () => {
    const result = buildDeviceAuthPayload({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["s1", "s2", "s3"],
      signedAtMs: 42,
      token: "t",
    });

    const parts = result.split("|");
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("d");
    expect(parts[2]).toBe("c");
    expect(parts[3]).toBe("m");
    expect(parts[4]).toBe("r");
    expect(parts[5]).toBe("s1,s2,s3");
    expect(parts[6]).toBe("42");
    expect(parts[7]).toBe("t");
    expect(parts).toHaveLength(8);
  });

  it("includes nonce as 9th field in v2", () => {
    const result = buildDeviceAuthPayload({
      deviceId: "d",
      clientId: "c",
      clientMode: "m",
      role: "r",
      scopes: ["s"],
      signedAtMs: 1,
      token: "t",
      nonce: "n",
    });

    const parts = result.split("|");
    expect(parts).toHaveLength(9);
    expect(parts[8]).toBe("n");
  });
});

// ---------------------------------------------------------------------------
// loadGatewayToken
// ---------------------------------------------------------------------------

describe("loadGatewayToken", () => {
  it("returns null when config file is missing", () => {
    expect(loadGatewayToken()).toBeNull();
  });

  it("returns null when gateway auth mode is not token", () => {
    const configDir = path.join(tempDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({
        gateway: {
          auth: { mode: "password", password: "secret" },
        },
      }),
    );

    expect(loadGatewayToken()).toBeNull();
  });

  it("returns token when auth mode is token", () => {
    const configDir = path.join(tempDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({
        gateway: {
          auth: { mode: "token", token: "gateway-tok-123" },
        },
      }),
    );

    expect(loadGatewayToken()).toBe("gateway-tok-123");
  });

  it("returns null when config file is malformed JSON", () => {
    const configDir = path.join(tempDir, ".openclaw");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "openclaw.json"), "not-json{{{");

    expect(loadGatewayToken()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// storeDeviceToken / loadDeviceToken / clearDeviceToken
// ---------------------------------------------------------------------------

describe("device token storage", () => {
  it("storeDeviceToken + loadDeviceToken roundtrip", () => {
    storeDeviceToken("dev-1", "operator", "stored-tok-abc", ["operator.read", "operator.write"]);

    const token = loadDeviceToken("dev-1", "operator");
    expect(token).toBe("stored-tok-abc");
  });

  it("loadDeviceToken returns null when no token stored", () => {
    expect(loadDeviceToken("nonexistent-device", "operator")).toBeNull();
  });

  it("loadDeviceToken returns null when file doesn't exist", () => {
    expect(loadDeviceToken("dev-1", "admin")).toBeNull();
  });

  it("clearDeviceToken removes stored token", () => {
    storeDeviceToken("dev-1", "operator", "tok-to-clear", ["operator.read"]);
    expect(loadDeviceToken("dev-1", "operator")).toBe("tok-to-clear");

    clearDeviceToken("dev-1", "operator");
    expect(loadDeviceToken("dev-1", "operator")).toBeNull();
  });

  it("multiple tokens can coexist for different device/role combos", () => {
    storeDeviceToken("dev-1", "operator", "tok-1", ["operator.read"]);
    storeDeviceToken("dev-1", "admin", "tok-2", ["admin.read"]);
    storeDeviceToken("dev-2", "operator", "tok-3", ["operator.read"]);

    expect(loadDeviceToken("dev-1", "operator")).toBe("tok-1");
    expect(loadDeviceToken("dev-1", "admin")).toBe("tok-2");
    expect(loadDeviceToken("dev-2", "operator")).toBe("tok-3");
  });

  it("storeDeviceToken overwrites previous token for same key", () => {
    storeDeviceToken("dev-1", "operator", "tok-old", ["scope-a"]);
    storeDeviceToken("dev-1", "operator", "tok-new", ["scope-b"]);

    expect(loadDeviceToken("dev-1", "operator")).toBe("tok-new");
  });

  it("clearDeviceToken is safe to call when token doesn't exist", () => {
    // Should not throw
    expect(() => clearDeviceToken("nonexistent", "role")).not.toThrow();
  });

  it("creates .flux directory if it doesn't exist", () => {
    storeDeviceToken("dev-1", "operator", "tok", ["scope"]);
    expect(fs.existsSync(path.join(tempDir, ".flux"))).toBe(true);
  });

  it("persists tokens to device-tokens.json file", () => {
    storeDeviceToken("dev-1", "operator", "persisted-tok", ["s1"]);

    const filePath = path.join(tempDir, ".flux", "device-tokens.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const contents = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const key = "dev-1:operator";
    expect(contents[key]).toBeDefined();
    expect(contents[key].token).toBe("persisted-tok");
    expect(contents[key].role).toBe("operator");
    expect(contents[key].scopes).toEqual(["s1"]);
    expect(typeof contents[key].updatedAtMs).toBe("number");
  });
});
