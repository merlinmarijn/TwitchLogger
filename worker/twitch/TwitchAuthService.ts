import { randomBytes } from "node:crypto";
import type { Logger } from "../logger";
import type {
  TwitchAuthorization,
  TwitchOptions,
  TwitchTokens,
} from "../types";
import { TwitchAuthError } from "../types";
import type { TwitchTokenStore } from "./EncryptedTokenStore";

const REQUIRED_SCOPES = ["user:read:chat"] as const;
const STATE_TTL_MS = 10 * 60 * 1000;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
}

interface ValidationResponse {
  client_id: string;
  login: string;
  user_id: string;
  scopes: string[];
  expires_in: number;
}

export class TwitchAuthService {
  private tokens: TwitchTokens | null = null;
  private authorization: TwitchAuthorization = { authenticated: false, scopes: [] };
  private readonly states = new Map<string, number>();
  private readonly listeners = new Set<(status: TwitchAuthorization) => void>();
  private refreshPromise: Promise<string> | null = null;
  private validationTimer?: NodeJS.Timeout;

  constructor(
    private readonly options: TwitchOptions,
    private readonly tokenStore: TwitchTokenStore,
    private readonly logger: Logger,
  ) {}

  async initialize(signal: AbortSignal): Promise<TwitchAuthorization> {
    this.tokens = await this.tokenStore.load();
    if (!this.tokens && this.options.initialAccessToken && this.options.initialRefreshToken) {
      this.tokens = {
        accessToken: this.options.initialAccessToken,
        refreshToken: this.options.initialRefreshToken,
        scopes: [...REQUIRED_SCOPES],
        expiresAt: 0,
      };
      await this.tokenStore.save(this.tokens);
      this.logger.info("Bootstrapped Twitch tokens from environment into encrypted storage");
    }

    if (this.tokens) {
      try {
        await this.validateOrRefresh();
      } catch (error) {
        this.logger.warn({ err: error }, "Stored Twitch authorization is not usable");
      }
    } else {
      this.logger.info("Twitch authorization is required");
    }

    this.validationTimer = setInterval(() => {
      void this.validateOrRefresh().catch((error) =>
        this.logger.warn({ err: error }, "Hourly Twitch token validation failed"),
      );
    }, 60 * 60 * 1000);
    this.validationTimer.unref();
    signal.addEventListener("abort", () => clearInterval(this.validationTimer), {
      once: true,
    });
    return this.authorization;
  }

  onAuthorizationChanged(listener: (status: TwitchAuthorization) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getStatus(): TwitchAuthorization {
    return { ...this.authorization, scopes: [...this.authorization.scopes] };
  }

  createAuthorizationUrl(): string {
    const state = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.states.set(state, now + STATE_TTL_MS);
    for (const [candidate, expiresAt] of this.states) {
      if (expiresAt < now) this.states.delete(candidate);
    }

    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.options.clientId);
    url.searchParams.set("redirect_uri", this.options.redirectUri);
    url.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeAuthorizationCode(code: string, state: string): Promise<void> {
    const expiresAt = this.states.get(state);
    this.states.delete(state);
    if (!expiresAt || expiresAt < Date.now()) {
      throw new TwitchAuthError("Invalid or expired OAuth state");
    }

    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: this.options.redirectUri,
      }),
    });
    const body = (await response.json()) as TokenResponse | { message?: string };
    if (!response.ok || !("access_token" in body)) {
      throw new TwitchAuthError(
        `Twitch authorization exchange failed: ${"message" in body ? body.message : response.status}`,
      );
    }
    await this.acceptTokens(body);
    await this.validateCurrentToken();
    this.logger.info({ login: this.authorization.login }, "Twitch authorization completed");
  }

  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new TwitchAuthError("Twitch authorization is required", true);
    if (this.tokens.expiresAt > 0 && this.tokens.expiresAt <= Date.now() + 30_000) {
      return this.refreshAccessToken();
    }
    return this.tokens.accessToken;
  }

  async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async revalidate(): Promise<TwitchAuthorization> {
    await this.validateOrRefresh();
    return this.getStatus();
  }

  private async performRefresh(): Promise<string> {
    if (!this.tokens?.refreshToken) {
      await this.markAuthorizationLost("Twitch authorization must be renewed");
      throw new TwitchAuthError("No Twitch refresh token is available", true);
    }
    this.logger.info("Refreshing Twitch OAuth token");
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: "refresh_token",
        refresh_token: this.tokens.refreshToken,
      }),
    });
    const body = (await response.json()) as TokenResponse | { message?: string };
    if (!response.ok || !("access_token" in body)) {
      await this.markAuthorizationLost("Twitch authorization was revoked or expired");
      throw new TwitchAuthError("Twitch token refresh failed; authorization is required", true);
    }
    await this.acceptTokens(body);
    this.logger.info("Twitch OAuth token refreshed");
    return this.tokens!.accessToken;
  }

  private async validateOrRefresh() {
    if (!this.tokens) return;
    try {
      await this.validateCurrentToken();
    } catch (error) {
      if (error instanceof TwitchAuthError && error.authorizationRevoked) throw error;
      await this.refreshAccessToken();
      await this.validateCurrentToken();
    }
  }

  private async validateCurrentToken() {
    if (!this.tokens) throw new TwitchAuthError("Twitch authorization is required", true);
    const response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `Bearer ${this.tokens.accessToken}` },
    });
    if (response.status === 401) throw new TwitchAuthError("Twitch token is invalid");
    if (!response.ok) throw new TwitchAuthError(`Twitch token validation failed (${response.status})`);

    const validation = (await response.json()) as ValidationResponse;
    if (validation.client_id !== this.options.clientId) {
      await this.markAuthorizationLost("Token belongs to a different Twitch application");
      throw new TwitchAuthError("Twitch token client ID mismatch", true);
    }
    const missingScopes = REQUIRED_SCOPES.filter(
      (scope) => !validation.scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      await this.markAuthorizationLost(`Missing OAuth scope: ${missingScopes.join(", ")}`);
      throw new TwitchAuthError("Twitch authorization has insufficient scopes", true);
    }

    this.tokens.expiresAt = Date.now() + validation.expires_in * 1000;
    this.tokens.scopes = validation.scopes;
    await this.tokenStore.save(this.tokens);
    this.setAuthorization({
      authenticated: true,
      userId: validation.user_id,
      login: validation.login,
      scopes: validation.scopes,
      expiresAt: this.tokens.expiresAt,
    });
    this.logger.info(
      { login: validation.login, scopes: validation.scopes },
      "Twitch OAuth token validated",
    );
  }

  private async acceptTokens(response: TokenResponse) {
    this.tokens = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAt: Date.now() + response.expires_in * 1000,
      scopes: response.scope,
    };
    await this.tokenStore.save(this.tokens);
  }

  private async markAuthorizationLost(reason: string) {
    this.tokens = null;
    await this.tokenStore.clear();
    this.setAuthorization({ authenticated: false, scopes: [], reason });
    this.logger.error({ reason }, "Twitch authorization is no longer valid");
  }

  private setAuthorization(status: TwitchAuthorization) {
    this.authorization = status;
    for (const listener of this.listeners) listener(this.getStatus());
  }
}
