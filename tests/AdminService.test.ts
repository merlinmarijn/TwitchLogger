import { describe, expect, it } from "vitest";
import { totp, verifyTotp } from "../worker/AdminService";

describe("admin authenticator codes", () => {
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("generates the RFC 4226 counter-one value as a six-digit code", () => {
    expect(totp(rfcSecret, 1)).toBe("287082");
  });

  it("accepts a code inside the clock-skew window and rejects malformed codes", () => {
    expect(verifyTotp(rfcSecret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(rfcSecret, "28708", 59_000)).toBe(false);
    expect(verifyTotp(rfcSecret, "000000", 59_000)).toBe(false);
  });
});
