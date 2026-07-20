import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import QRCode from "qrcode";

const PASSWORD_COST = 16_384;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const ENROLLMENT_LIFETIME_MS = 10 * 60 * 1_000;

type AuthState =
  | { configured: false; totpEnabled: false; authRevision: 0 }
  | {
      configured: true;
      passwordHash: string;
      passwordSalt: string;
      passwordCost: number;
      totpEnabled: boolean;
      totpSecretEncrypted?: string;
      authRevision: number;
    };

type SessionPayload = { type: "session"; revision: number; expiresAt: number };
type EnrollmentPayload = {
  type: "enrollment";
  secret: string;
  revision: number;
  expiresAt: number;
};

const authStateRef = makeFunctionReference<"query", { ingestionSecret: string }, AuthState>(
  "admin:authState",
);
const initializeAuthRef = makeFunctionReference<
  "mutation",
  { ingestionSecret: string; passwordHash: string; passwordSalt: string; passwordCost: number },
  { authRevision: number }
>("admin:initializeAuth");
const changePasswordRef = makeFunctionReference<
  "mutation",
  { ingestionSecret: string; passwordHash: string; passwordSalt: string; passwordCost: number },
  { authRevision: number }
>("admin:changePassword");
const enableTotpRef = makeFunctionReference<
  "mutation",
  { ingestionSecret: string; encryptedSecret: string },
  { authRevision: number }
>("admin:enableTotp");
const dashboardRef = makeFunctionReference<"query", { ingestionSecret: string }, unknown>(
  "admin:dashboard",
);
const startJobRef = makeFunctionReference<
  "mutation",
  { ingestionSecret: string; kind: AdminJobKind; requestedBy: string },
  string
>("admin:startJob");
const cancelJobRef = makeFunctionReference<
  "mutation",
  { ingestionSecret: string; jobId: string; requestedBy: string },
  null
>("admin:cancelJob");
const recordMetricRef = makeFunctionReference<
  "mutation",
  { ingestionSecret: string; durationMs: number; failed: boolean; cache?: "hit" | "miss" },
  null
>("admin:recordMetric");

export type AdminJobKind =
  | "image_reindex"
  | "view_reindex"
  | "integrity_scan"
  | "database_measurement";

export class AdminService {
  private readonly client: ConvexHttpClient;
  private readonly signingKey: Buffer;

  constructor(
    convexUrl: string,
    private readonly ingestionSecret: string,
    private readonly encryptionKey: Buffer,
  ) {
    this.client = new ConvexHttpClient(convexUrl, { skipConvexDeploymentUrlCheck: true });
    this.signingKey = createHmac("sha256", encryptionKey)
      .update("twitch-logger/admin/session/v1")
      .digest();
  }

  async status(sessionToken?: string) {
    const state = await this.authState();
    return {
      configured: state.configured,
      totpEnabled: state.totpEnabled,
      authenticated: state.configured && this.sessionMatches(sessionToken, state.authRevision),
    };
  }

  async setup(password: string, setupKey: string) {
    validatePassword(password);
    const state = await this.authState();
    if (state.configured) throw new AdminAuthError("The super admin is already configured", 409);
    if (!secretMatches(setupKey, this.ingestionSecret)) {
      throw new AdminAuthError("The setup key is incorrect", 401);
    }
    const credentials = await hashPassword(password);
    const result = await this.client.mutation(initializeAuthRef as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      ...credentials,
    }) as { authRevision: number };
    return this.createSession(result.authRevision);
  }

  async loginWithPassword(password: string) {
    const state = await this.authState();
    if (!state.configured) throw new AdminAuthError("Complete super admin setup first", 409);
    const valid = await verifyPassword(password, state);
    if (!valid) throw new AdminAuthError("The password or authenticator code is incorrect", 401);
    return this.createSession(state.authRevision);
  }

  async loginWithTotp(code: string) {
    const state = await this.authState();
    if (!state.configured || !state.totpEnabled || !state.totpSecretEncrypted) {
      throw new AdminAuthError("Authenticator sign-in is not enabled", 409);
    }
    const secret = this.decrypt(state.totpSecretEncrypted);
    if (!verifyTotp(secret, code)) {
      throw new AdminAuthError("The password or authenticator code is incorrect", 401);
    }
    return this.createSession(state.authRevision);
  }

  async requireSession(sessionToken?: string) {
    const state = await this.authState();
    if (!state.configured || !this.sessionMatches(sessionToken, state.authRevision)) {
      throw new AdminAuthError("Your admin session has expired", 401);
    }
    return state;
  }

  async beginTotp(sessionToken?: string) {
    const state = await this.requireSession(sessionToken);
    const secret = base32Encode(randomBytes(20));
    const enrollmentToken = this.sign({
      type: "enrollment",
      secret,
      revision: state.authRevision,
      expiresAt: Date.now() + ENROLLMENT_LIFETIME_MS,
    } satisfies EnrollmentPayload);
    const issuer = "Twitch Logger";
    const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:super-admin`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    const qrCode = await QRCode.toDataURL(uri, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
      color: { dark: "#17201d", light: "#f4f0e6" },
    });
    return { enrollmentToken, qrCode, secret, expiresInSeconds: ENROLLMENT_LIFETIME_MS / 1_000 };
  }

  async confirmTotp(sessionToken: string | undefined, enrollmentToken: string, code: string) {
    const state = await this.requireSession(sessionToken);
    const payload = this.verifySigned<EnrollmentPayload>(enrollmentToken);
    if (
      !payload ||
      payload.type !== "enrollment" ||
      payload.expiresAt < Date.now() ||
      payload.revision !== state.authRevision
    ) {
      throw new AdminAuthError("This QR code has expired; generate a new one", 400);
    }
    if (!verifyTotp(payload.secret, code)) {
      throw new AdminAuthError("That code does not match the QR code", 400);
    }
    const result = await this.client.mutation(enableTotpRef as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      encryptedSecret: this.encrypt(payload.secret),
    }) as { authRevision: number };
    return this.createSession(result.authRevision);
  }

  async changePassword(sessionToken: string | undefined, currentPassword: string, newPassword: string) {
    const state = await this.requireSession(sessionToken);
    if (!(await verifyPassword(currentPassword, state))) {
      throw new AdminAuthError("The current password is incorrect", 401);
    }
    validatePassword(newPassword);
    const credentials = await hashPassword(newPassword);
    const result = await this.client.mutation(changePasswordRef as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      ...credentials,
    }) as { authRevision: number };
    return this.createSession(result.authRevision);
  }

  async dashboard(sessionToken?: string) {
    await this.requireSession(sessionToken);
    return this.client.query(dashboardRef as FunctionReference<"query">, {
      ingestionSecret: this.ingestionSecret,
    });
  }

  async startJob(sessionToken: string | undefined, kind: AdminJobKind) {
    await this.requireSession(sessionToken);
    return this.client.mutation(startJobRef as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      kind,
      requestedBy: "super-admin",
    });
  }

  async cancelJob(sessionToken: string | undefined, jobId: string) {
    await this.requireSession(sessionToken);
    return this.client.mutation(cancelJobRef as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      jobId,
      requestedBy: "super-admin",
    });
  }

  async recordMetric(durationMs: number, failed: boolean, cache?: "hit" | "miss") {
    await this.client.mutation(recordMetricRef as FunctionReference<"mutation">, {
      ingestionSecret: this.ingestionSecret,
      durationMs,
      failed,
      ...(cache ? { cache } : {}),
    });
  }

  private authState() {
    return this.client.query(authStateRef as FunctionReference<"query">, {
      ingestionSecret: this.ingestionSecret,
    }) as Promise<AuthState>;
  }

  private createSession(revision: number) {
    return this.sign({
      type: "session",
      revision,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    } satisfies SessionPayload);
  }

  private sessionMatches(token: string | undefined, revision: number) {
    if (!token) return false;
    const payload = this.verifySigned<SessionPayload>(token);
    return Boolean(
      payload &&
      payload.type === "session" &&
      payload.revision === revision &&
      payload.expiresAt >= Date.now(),
    );
  }

  private sign(payload: SessionPayload | EnrollmentPayload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.signingKey).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private verifySigned<T>(token: string): T | undefined {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return undefined;
    const expected = createHmac("sha256", this.signingKey).update(body).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      return undefined;
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    try {
      return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    } catch {
      return undefined;
    }
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  private decrypt(envelope: string) {
    const [version, iv, tag, ciphertext] = envelope.split(".");
    if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid TOTP envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

function secretMatches(supplied: string, expected: string) {
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

export class AdminAuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function validatePassword(password: string) {
  if (password.length < 12 || password.length > 128) {
    throw new AdminAuthError("Use a password between 12 and 128 characters", 400);
  }
}

async function hashPassword(password: string) {
  const passwordSalt = randomBytes(16).toString("base64url");
  const derived = await derivePassword(password, passwordSalt, PASSWORD_COST);
  return {
    passwordHash: derived.toString("base64url"),
    passwordSalt,
    passwordCost: PASSWORD_COST,
  };
}

async function verifyPassword(
  password: string,
  credentials: { passwordHash: string; passwordSalt: string; passwordCost: number },
) {
  const expected = Buffer.from(credentials.passwordHash, "base64url");
  const actual = await derivePassword(password, credentials.passwordSalt, credentials.passwordCost);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function derivePassword(password: string, salt: string, cost: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: Math.max(16_384, Math.min(cost, 131_072)), r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
      (error, derived) => error ? reject(error) : resolve(derived),
    );
  });
}

export function verifyTotp(secret: string, candidate: string, now = Date.now()) {
  if (!/^\d{6}$/.test(candidate)) return false;
  const expected = Buffer.from(candidate);
  for (let offset = -1; offset <= 1; offset += 1) {
    const code = Buffer.from(totp(secret, Math.floor(now / 30_000) + offset));
    if (timingSafeEqual(code, expected)) return true;
  }
  return false;
}

export function totp(secret: string, counter: number) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

function base32Encode(value: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
