import { AppConfig, TokenSet, loadConfig, loadTokens, saveTokens } from "./config.js";
import { exchangeToken, tokensFromResponse } from "./auth.js";

const MINOR_VERSION = "75";

const BASE_URLS = {
  production: "https://quickbooks.api.intuit.com",
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
} as const;

export class QboError extends Error {}

export class QboClient {
  private config: AppConfig;
  private tokens: TokenSet;

  private constructor(config: AppConfig, tokens: TokenSet) {
    this.config = config;
    this.tokens = tokens;
  }

  static load(): QboClient {
    const config = loadConfig();
    if (!config) {
      throw new QboError(
        "QuickBooks app credentials are not configured. Open a terminal in the project's mcp " +
          "folder and run `node dist/index.js auth` first.",
      );
    }
    const tokens = loadTokens();
    if (!tokens) {
      throw new QboError(
        "No QuickBooks company is connected. Open a terminal in the project's mcp folder and " +
          "run `node dist/index.js auth` to authorize one.",
      );
    }
    return new QboClient(config, tokens);
  }

  get realmId(): string {
    return this.tokens.realmId;
  }

  get environment(): string {
    return this.config.environment;
  }

  get tokenInfo(): { accessTokenExpiresAt: number; refreshTokenExpiresAt: number } {
    return {
      accessTokenExpiresAt: this.tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: this.tokens.refreshTokenExpiresAt,
    };
  }

  private async refresh(): Promise<void> {
    if (Date.now() > this.tokens.refreshTokenExpiresAt) {
      throw new QboError(
        "The QuickBooks refresh token has expired. Open a terminal in the project's mcp folder " +
          "and run `node dist/index.js auth` to reconnect.",
      );
    }
    const response = await exchangeToken(this.config, {
      grant_type: "refresh_token",
      refresh_token: this.tokens.refreshToken,
    });
    this.tokens = tokensFromResponse(this.tokens.realmId, response);
    saveTokens(this.tokens);
  }

  private async ensureAccessToken(): Promise<void> {
    if (Date.now() > this.tokens.accessTokenExpiresAt - 60_000) {
      await this.refresh();
    }
  }

  async request(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<unknown> {
    await this.ensureAccessToken();
    const url = new URL(
      `${BASE_URLS[this.config.environment]}/v3/company/${this.tokens.realmId}/${path}`,
    );
    url.searchParams.set("minorversion", MINOR_VERSION);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const doFetch = () =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.tokens.accessToken}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

    let res = await doFetch();
    if (res.status === 401) {
      await this.refresh();
      res = await doFetch();
    }
    const text = await res.text();
    if (!res.ok) {
      throw new QboError(`QuickBooks API error (${res.status} ${res.statusText}): ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async query(statement: string): Promise<unknown> {
    return this.request("GET", "query", { query: { query: statement } });
  }

  async getEntity(entity: string, id: string): Promise<unknown> {
    return this.request("GET", `${entity.toLowerCase()}/${encodeURIComponent(id)}`);
  }

  async report(name: string, params: Record<string, string>): Promise<unknown> {
    return this.request("GET", `reports/${encodeURIComponent(name)}`, { query: params });
  }

  async companyInfo(): Promise<unknown> {
    return this.request("GET", `companyinfo/${this.tokens.realmId}`);
  }

  async create(entity: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", entity.toLowerCase(), { body: payload });
  }

  private async withSyncToken(
    entity: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (payload.SyncToken !== undefined) return payload;
    const id = payload.Id;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new QboError("Payload must include an Id (and optionally a SyncToken).");
    }
    const current = (await this.getEntity(entity, String(id))) as Record<string, unknown>;
    const record = Object.values(current).find(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null && "SyncToken" in value,
    );
    if (record?.SyncToken === undefined) {
      throw new QboError(`Could not determine SyncToken for ${entity} ${id}.`);
    }
    return { ...payload, SyncToken: record.SyncToken };
  }

  async update(entity: string, payload: Record<string, unknown>): Promise<unknown> {
    const body = await this.withSyncToken(entity, { sparse: true, ...payload });
    return this.request("POST", entity.toLowerCase(), { body });
  }

  async remove(entity: string, id: string, syncToken?: string): Promise<unknown> {
    const body = await this.withSyncToken(entity, {
      Id: id,
      ...(syncToken !== undefined ? { SyncToken: syncToken } : {}),
    });
    return this.request("POST", entity.toLowerCase(), {
      query: { operation: "delete" },
      body: { Id: body.Id, SyncToken: body.SyncToken },
    });
  }
}
