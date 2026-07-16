import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedTokenStore } from "../worker/twitch/EncryptedTokenStore";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("EncryptedTokenStore", () => {
  it("round-trips tokens without writing them in plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twitch-token-test-"));
    directories.push(directory);
    const path = join(directory, "tokens.enc");
    const store = new EncryptedTokenStore(path, randomBytes(32));
    const tokens = {
      accessToken: "access-token-that-must-not-leak",
      refreshToken: "refresh-token-that-must-not-leak",
      expiresAt: Date.now() + 60_000,
      scopes: ["user:read:chat"],
    };

    await store.save(tokens);
    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain(tokens.accessToken);
    expect(stored).not.toContain(tokens.refreshToken);
    await expect(store.load()).resolves.toEqual(tokens);
  });
});
