import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TwitchTokens } from "../types";

interface StoredEnvelope {
  version: 1;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface TwitchTokenStore {
  load(): Promise<TwitchTokens | null>;
  save(tokens: TwitchTokens): Promise<void>;
  clear(): Promise<void>;
}

export class EncryptedTokenStore implements TwitchTokenStore {
  constructor(
    private readonly path: string,
    private readonly key: Buffer,
  ) {}

  async load(): Promise<TwitchTokens | null> {
    let serialized: string;
    try {
      serialized = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    const envelope = JSON.parse(serialized) as StoredEnvelope;
    if (envelope.version !== 1) throw new Error("Unsupported Twitch token store version");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as TwitchTokens;
  }

  async save(tokens: TwitchTokens): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(tokens), "utf8"),
      cipher.final(),
    ]);
    const envelope: StoredEnvelope = {
      version: 1,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };

    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(envelope), { mode: 0o600 });
    await rename(temporaryPath, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}
