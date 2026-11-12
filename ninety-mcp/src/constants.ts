// Values shared by the desktop (stdio) build and the hosted (Cloudflare Worker) build.
// This file must stay free of Node-only imports so the Worker can bundle it.

export const SERVER_NAME = "ninety-mcp";
export const SERVER_VERSION = "0.3.0";

export const DEFAULT_BASE_URL = "https://api.public.ninety.io";

export const DEVELOPER_SETTINGS_URL = "https://app.ninety.io/settings/user/developer-settings";
