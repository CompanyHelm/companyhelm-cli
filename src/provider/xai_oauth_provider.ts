import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  getOAuthProvider,
  registerOAuthProvider,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
} from "@mariozechner/pi-ai/oauth";

type XaiDiscoveryDocument = {
  authorization_endpoint?: string;
  token_endpoint?: string;
};

type XaiTokenPayload = {
  access_token?: string;
  expires_in?: number | string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
};

type XaiCallbackResult = {
  code?: string;
  error?: string;
  errorDescription?: string;
  state?: string;
};

type XaiCallbackServer = {
  close: () => void;
  redirectUri: string;
  waitForCallback: (signal?: AbortSignal) => Promise<XaiCallbackResult>;
};

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REFRESH_SKEW_MILLISECONDS = 120_000;
const XAI_OAUTH_CALLBACK_TIMEOUT_MILLISECONDS = 180_000;
const XAI_OAUTH_PROVIDER_IDS = ["xai-auth", "xai"] as const;

/**
 * Registers CompanyHelm's xAI OAuth provider aliases when the bundled Pi OAuth registry does not
 * include them yet. This keeps the CLI compatible with current Pi releases while allowing future
 * bundled xAI providers to take precedence automatically.
 */
export function registerCompanyHelmXaiOAuthProviders(): void {
  for (const providerId of XAI_OAUTH_PROVIDER_IDS) {
    if (!getOAuthProvider(providerId)) {
      registerOAuthProvider(new XaiOAuthProvider(providerId));
    }
  }
}

class XaiOAuthProvider implements OAuthProviderInterface {
  readonly id: string;
  readonly name = "xAI (Grok)";
  readonly usesCallbackServer = true;

  constructor(id: string) {
    this.id = id;
  }

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    callbacks.onProgress?.("Starting xAI Grok OAuth login...");
    const discovery = await discoverXaiEndpoints();
    const pkce = createPkcePair();
    const state = randomUUID().replace(/-/gu, "");
    const nonce = randomUUID().replace(/-/gu, "");
    const callbackServer = await startCallbackServer(state);
    const authorizeUrl = buildAuthorizeUrl(discovery.authorizationEndpoint, callbackServer.redirectUri, pkce.challenge, state, nonce);

    try {
      callbacks.onAuth({
        instructions: "Approve the xAI/Grok login in your browser, then return to this terminal.",
        url: authorizeUrl,
      });
      callbacks.onProgress?.(`Waiting for xAI OAuth callback on ${callbackServer.redirectUri}...`);
      const callback = await callbackServer.waitForCallback(callbacks.signal);
      if (callback.error) {
        throw new Error(`xAI authorization failed: ${callback.errorDescription || callback.error}`);
      }
      if (callback.state !== state) {
        throw new Error("xAI authorization failed: state mismatch.");
      }
      if (!callback.code) {
        throw new Error("xAI authorization failed: no authorization code returned.");
      }

      callbacks.onProgress?.("Exchanging xAI authorization code for tokens...");
      const tokenPayload = await exchangeXaiToken(discovery.tokenEndpoint, {
        client_id: XAI_OAUTH_CLIENT_ID,
        code: callback.code,
        code_verifier: pkce.verifier,
        grant_type: "authorization_code",
        redirect_uri: callbackServer.redirectUri,
      });

      return credentialsFromTokenPayload(tokenPayload, discovery.tokenEndpoint);
    } finally {
      callbackServer.close();
    }
  }

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    return refreshXaiCredentials(credentials);
  }

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  }
}

function createPkcePair(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { challenge, verifier };
}

async function discoverXaiEndpoints(): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`xAI OAuth discovery failed: ${response.status} ${await response.text()}`);
  }

  const payload = await response.json() as XaiDiscoveryDocument;
  if (!payload.authorization_endpoint || !payload.token_endpoint) {
    throw new Error("xAI OAuth discovery response did not include authorization and token endpoints.");
  }

  return {
    authorizationEndpoint: validateXaiEndpoint(payload.authorization_endpoint),
    tokenEndpoint: validateXaiEndpoint(payload.token_endpoint),
  };
}

function validateXaiEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("xAI OAuth discovery returned an invalid endpoint.");
  }

  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "x.ai" && !hostname.endsWith(".x.ai"))) {
    throw new Error(`xAI OAuth discovery returned an unexpected endpoint: ${value}`);
  }

  return url.toString();
}

function buildAuthorizeUrl(authorizationEndpoint: string, redirectUri: string, challenge: string, state: string, nonce: string): string {
  const params = new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: "S256",
    nonce,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: XAI_OAUTH_SCOPE,
    state,
  });
  return `${authorizationEndpoint}?${params.toString()}`;
}

async function startCallbackServer(expectedState: string): Promise<XaiCallbackServer> {
  let resolveCallback!: (result: XaiCallbackResult) => void;
  const callbackPromise = new Promise<XaiCallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const makeServer = (): Server => createServer((request, response) => {
    const url = new URL(request.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
    if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const result: XaiCallbackResult = {
      code: url.searchParams.get("code") || undefined,
      error: url.searchParams.get("error") || undefined,
      errorDescription: url.searchParams.get("error_description") || undefined,
      state: url.searchParams.get("state") || undefined,
    };

    if (result.state !== expectedState) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body><h1>xAI authorization state mismatch.</h1>Please return to CompanyHelm and try again.</body></html>");
      return;
    }

    response.writeHead(result.error ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      result.error
        ? "<html><body><h1>xAI authorization failed.</h1>You can close this tab.</body></html>"
        : "<html><body><h1>xAI authorization received.</h1>You can close this tab.</body></html>",
    );
    resolveCallback(result);
  });

  const server = await listenWithFallback(makeServer);
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not determine xAI OAuth callback port.");
  }

  const redirectUri = `http://${XAI_OAUTH_REDIRECT_HOST}:${address.port}${XAI_OAUTH_REDIRECT_PATH}`;
  const close = (): void => {
    try {
      server.close();
    } catch {
      // Ignore close errors after the callback flow has already settled.
    }
  };

  return {
    close,
    redirectUri,
    waitForCallback: async (signal?: AbortSignal) => {
      let timeout: NodeJS.Timeout | undefined;
      let abortHandler: (() => void) | undefined;
      const timeoutPromise = new Promise<XaiCallbackResult>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out waiting for xAI OAuth callback.")), XAI_OAUTH_CALLBACK_TIMEOUT_MILLISECONDS);
        abortHandler = () => {
          if (timeout) clearTimeout(timeout);
          reject(new Error("xAI OAuth login was cancelled."));
        };
        signal?.addEventListener("abort", abortHandler, { once: true });
      });

      try {
        return await Promise.race([callbackPromise, timeoutPromise]);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        close();
      }
    },
  };
}

async function listenWithFallback(makeServer: () => Server): Promise<Server> {
  try {
    return await listen(makeServer(), XAI_OAUTH_REDIRECT_PORT);
  } catch {
    return listen(makeServer(), 0);
  }
}

function listen(server: Server, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function exchangeXaiToken(tokenEndpoint: string, body: Record<string, string>): Promise<XaiTokenPayload> {
  const response = await fetch(tokenEndpoint, {
    body: new URLSearchParams(body).toString(),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`xAI token request failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as XaiTokenPayload;
}

async function refreshXaiCredentials(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error("xAI credentials do not include a refresh token.");
  }

  const tokenEndpoint = typeof credentials.tokenEndpoint === "string" && credentials.tokenEndpoint.length > 0
    ? validateXaiEndpoint(credentials.tokenEndpoint)
    : (await discoverXaiEndpoints()).tokenEndpoint;
  const payload = await exchangeXaiToken(tokenEndpoint, {
    client_id: XAI_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
  });

  return credentialsFromTokenPayload(payload, tokenEndpoint, credentials.refresh);
}


function credentialsFromTokenPayload(payload: XaiTokenPayload, tokenEndpoint: string, fallbackRefresh = ""): OAuthCredentials {
  const access = String(payload.access_token || "").trim();
  if (!access) {
    throw new Error("xAI token response did not include an access token.");
  }

  const refresh = String(payload.refresh_token || fallbackRefresh).trim();
  if (!refresh) {
    throw new Error("xAI token response did not include a refresh token.");
  }

  const expiresInSeconds = typeof payload.expires_in === "number"
    ? payload.expires_in
    : Number(String(payload.expires_in || "3600").trim());
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new Error("xAI token response did not include a valid expiry.");
  }

  return {
    access,
    expires: Date.now() + expiresInSeconds * 1000 - XAI_OAUTH_REFRESH_SKEW_MILLISECONDS,
    idToken: String(payload.id_token || ""),
    refresh,
    tokenEndpoint,
    tokenType: String(payload.token_type || "Bearer"),
  };
}
