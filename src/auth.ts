import { getMcpAuthContext } from "agents/mcp";
import { exchangeAuthCodeForTokens, googleApiRequest, OAuthTokenRecord, refreshAccessToken, type GoogleAuthEnv } from "./google";

const MCP_OAUTH_STATE_PREFIX = "mcp-oauth-state:";
const GOOGLE_TOKEN_PREFIX = "google-token:";
const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/spreadsheets",
	"https://www.googleapis.com/auth/drive",
];

interface McpOAuthStateRecord {
	oauthRequest: unknown;
}

export interface AuthEnv extends GoogleAuthEnv {
	GOOGLE_AUTH_KV: KVNamespace;
	OAUTH_PROVIDER: {
		parseAuthRequest: (request: Request) => Promise<unknown>;
		completeAuthorization: (args: { request: unknown; userId: string; scope?: string[] }) => Promise<{ redirectTo: string }>;
	};
}

function randomString(bytes = 32): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	let binary = "";
	for (const value of arr) binary += String.fromCharCode(value);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseScopesFromAuthRequest(authRequest: unknown): string[] {
	if (!authRequest || typeof authRequest !== "object") return [];
	const maybeScope = (authRequest as { scope?: unknown }).scope;
	if (typeof maybeScope !== "string") return [];
	return maybeScope.split(" ").map((s) => s.trim()).filter(Boolean);
}

export async function beginAuthorize(request: Request, env: AuthEnv): Promise<Response> {
	const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
	const state = randomString();
	const stateRecord: McpOAuthStateRecord = { oauthRequest };
	await env.GOOGLE_AUTH_KV.put(`${MCP_OAUTH_STATE_PREFIX}${state}`, JSON.stringify(stateRecord), {
		expirationTtl: 600,
	});

	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URI);
	url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
	url.searchParams.set("state", state);
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");
	return Response.redirect(url.toString(), 302);
}

export async function handleGoogleAuthCallback(request: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		return new Response("Missing code or state.", { status: 400 });
	}

	const stateRaw = await env.GOOGLE_AUTH_KV.get(`${MCP_OAUTH_STATE_PREFIX}${state}`);
	if (!stateRaw) {
		return new Response("State expired or invalid.", { status: 400 });
	}
	const stateRecord = JSON.parse(stateRaw) as McpOAuthStateRecord;

	try {
		const tokens = await exchangeAuthCodeForTokens(env, code);
		const profile = await googleApiRequest<{ sub: string }>(
			tokens.accessToken,
			"https://openidconnect.googleapis.com/v1/userinfo",
		);
		await env.GOOGLE_AUTH_KV.put(`${GOOGLE_TOKEN_PREFIX}${profile.sub}`, JSON.stringify(tokens));
		await env.GOOGLE_AUTH_KV.delete(`${MCP_OAUTH_STATE_PREFIX}${state}`);

		const result = await env.OAUTH_PROVIDER.completeAuthorization({
			request: stateRecord.oauthRequest,
			userId: profile.sub,
			scope: parseScopesFromAuthRequest(stateRecord.oauthRequest),
		});
		return Response.redirect(result.redirectTo, 302);
	} catch (error) {
		return new Response(`Authentication failed: ${(error as Error).message}`, { status: 500 });
	}
}

export function getAuthenticatedUserId(): string {
	const ctx = getMcpAuthContext();
	const userId =
		(ctx as { props?: { userId?: string }; userId?: string } | undefined)?.props?.userId ??
		(ctx as { userId?: string } | undefined)?.userId;
	if (!userId) {
		throw new Error("Missing authenticated user context.");
	}
	return userId;
}

export async function getValidAccessToken(env: AuthEnv, userId: string): Promise<string> {
	const raw = await env.GOOGLE_AUTH_KV.get(`${GOOGLE_TOKEN_PREFIX}${userId}`);
	if (!raw) {
		throw new Error("No Google token found for authenticated user. Use Claude Connect first.");
	}

	let token = JSON.parse(raw) as OAuthTokenRecord;
	if (Date.now() >= token.expiryDate) {
		if (!token.refreshToken) {
			throw new Error("Access token expired and no refresh token available.");
		}
		token = await refreshAccessToken(env, token.refreshToken);
		await env.GOOGLE_AUTH_KV.put(`${GOOGLE_TOKEN_PREFIX}${userId}`, JSON.stringify(token));
	}

	return token.accessToken;
}
