import { AppConfig, CachedToken, loadConfig, loadToken, saveToken } from "./config.js";
import { BASE_URL, fetchToken } from "./auth.js";

export class PaychexError extends Error {}

type Query = Record<string, string | number | undefined>;

export class PaychexClient {
  private config: AppConfig;
  private token: CachedToken | undefined;

  private constructor(config: AppConfig, token: CachedToken | undefined) {
    this.config = config;
    this.token = token;
  }

  static load(): PaychexClient {
    const config = loadConfig();
    if (!config) {
      throw new PaychexError(
        "Paychex Flex credentials are not configured. Open a terminal in the project's paychex " +
          "folder and run `node dist/index.js auth` first.",
      );
    }
    return new PaychexClient(config, loadToken());
  }

  get defaultCompanyId(): string | undefined {
    return this.config.companyId;
  }

  private async ensureAccessToken(): Promise<string> {
    if (!this.token || Date.now() > this.token.expiresAt - 60_000) {
      try {
        this.token = await fetchToken(this.config);
      } catch (error) {
        throw new PaychexError(error instanceof Error ? error.message : String(error));
      }
      saveToken(this.token);
    }
    return this.token.accessToken;
  }

  async get(path: string, options: { query?: Query } = {}): Promise<unknown> {
    if (!path.startsWith("/")) {
      throw new PaychexError('The API path must start with "/", e.g. "/companies".');
    }
    const url = new URL(BASE_URL + path);
    if (url.origin !== BASE_URL) {
      throw new PaychexError("The API path must stay on api.paychex.com.");
    }
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const doFetch = (accessToken: string) =>
      fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });

    let res = await doFetch(await this.ensureAccessToken());
    if (res.status === 401) {
      // The cached token was revoked or expired early — fetch a fresh one and retry once.
      this.token = undefined;
      res = await doFetch(await this.ensureAccessToken());
    }
    const text = await res.text();
    if (!res.ok) {
      throw new PaychexError(`Paychex API error (${res.status} ${res.statusText}): ${text}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async resolveCompanyId(explicit?: string): Promise<string> {
    if (explicit) return explicit;
    if (this.config.companyId) return this.config.companyId;
    const body = (await this.get("/companies")) as { content?: { companyId?: string }[] };
    const companies = body.content ?? [];
    if (companies.length === 1 && companies[0].companyId) return companies[0].companyId;
    throw new PaychexError(
      companies.length === 0
        ? "This API key cannot see any Paychex companies yet. In the Paychex developer portal " +
            "(developer.paychex.com), link your Paychex Flex company to the application — a " +
            "company admin must approve the access."
        : "Several Paychex companies are available and no default is saved. Call " +
            "paychex_companies, then pass the desired companyId — or run " +
            "`node dist/index.js auth` in the paychex folder to save a default.",
    );
  }

  companies(): Promise<unknown> {
    return this.get("/companies");
  }

  async workers(companyId: string | undefined, query: Query): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    return this.get(`/companies/${encodeURIComponent(id)}/workers`, { query });
  }

  worker(workerId: string): Promise<unknown> {
    return this.get(`/workers/${encodeURIComponent(workerId)}`);
  }

  async payPeriods(companyId: string | undefined, query: Query): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    return this.get(`/companies/${encodeURIComponent(id)}/payperiods`, { query });
  }

  async companyChecks(companyId: string | undefined, payPeriodId: string): Promise<unknown> {
    const id = await this.resolveCompanyId(companyId);
    return this.get(`/companies/${encodeURIComponent(id)}/checks`, {
      query: { payperiodid: payPeriodId },
    });
  }

  workerChecks(workerId: string, payPeriodId?: string): Promise<unknown> {
    return this.get(`/workers/${encodeURIComponent(workerId)}/checks`, {
      query: { payperiodid: payPeriodId },
    });
  }
}
