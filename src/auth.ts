import { exchangeAuthCodeForTokens, OAuthTokenRecord, refreshAccessToken, type GoogleAuthEnv } from "./google";

const OAUTH_STATE_PREFIX = "oauth-state:";
const OAUTH_TOKEN_PREFIX = "oauth-token:";
const GOOGLE_SCOPES = [
	"https://www.googleapis.com/auth/spreadsheets",
	"https://www.googleapis.com/auth/drive",
];

interface OAuthStateRecord {
	sessionToken: string;
	codeVerifier: string;
}

export interface AuthEnv extends GoogleAuthEnv {
	GOOGLE_AUTH_KV: KVNamespace;
}

export interface AuthStartResponse {
	session_token: string;
	authorization_url: string;
	expires_in_seconds: number;
}

function toBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<string> {
	const encoded = new TextEncoder().encode(input);
	return toBase64Url(await crypto.subtle.digest("SHA-256", encoded));
}

function randomString(bytes = 32): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	let binary = "";
	for (const value of arr) binary += String.fromCharCode(value);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function buildAuthStart(env: AuthEnv): Promise<AuthStartResponse> {
	const sessionToken = crypto.randomUUID();
	const state = randomString();
	const codeVerifier = randomString(64);
	const codeChallenge = await sha256(codeVerifier);

	const stateRecord: OAuthStateRecord = { sessionToken, codeVerifier };
	await env.GOOGLE_AUTH_KV.put(`${OAUTH_STATE_PREFIX}${state}`, JSON.stringify(stateRecord), {
		expirationTtl: 600,
	});

	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", env.GOOGLE_OAUTH_CLIENT_ID);
	url.searchParams.set("redirect_uri", env.GOOGLE_OAUTH_REDIRECT_URI);
	url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
	url.searchParams.set("state", state);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("access_type", "offline");
	url.searchParams.set("prompt", "consent");

	return {
		session_token: sessionToken,
		authorization_url: url.toString(),
		expires_in_seconds: 600,
	};
}

export async function handleGoogleAuthCallback(request: Request, env: AuthEnv): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!code || !state) {
		return new Response("Missing code or state.", { status: 400 });
	}

	const stateRaw = await env.GOOGLE_AUTH_KV.get(`${OAUTH_STATE_PREFIX}${state}`);
	if (!stateRaw) {
		return new Response("State expired or invalid.", { status: 400 });
	}
	const stateRecord = JSON.parse(stateRaw) as OAuthStateRecord;

	try {
		const tokens = await exchangeAuthCodeForTokens(env, code, stateRecord.codeVerifier);
		await env.GOOGLE_AUTH_KV.put(`${OAUTH_TOKEN_PREFIX}${stateRecord.sessionToken}`, JSON.stringify(tokens));
		await env.GOOGLE_AUTH_KV.delete(`${OAUTH_STATE_PREFIX}${state}`);
		const body = [
			"Google authentication complete.",
			"",
			"Return to Claude and continue using this session token:",
			stateRecord.sessionToken,
		].join("\n");
		return new Response(body, {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	} catch (error) {
		return new Response(`Authentication failed: ${(error as Error).message}`, { status: 500 });
	}
}

export async function getValidAccessToken(env: AuthEnv, sessionToken: string): Promise<string> {
	const raw = await env.GOOGLE_AUTH_KV.get(`${OAUTH_TOKEN_PREFIX}${sessionToken}`);
	if (!raw) {
		throw new Error("No token found for session. Run start_google_auth first.");
	}

	let token = JSON.parse(raw) as OAuthTokenRecord;
	if (Date.now() >= token.expiryDate) {
		if (!token.refreshToken) {
			throw new Error("Access token expired and no refresh token available.");
		}
		token = await refreshAccessToken(env, token.refreshToken);
		await env.GOOGLE_AUTH_KV.put(`${OAUTH_TOKEN_PREFIX}${sessionToken}`, JSON.stringify(token));
	}

	return token.accessToken;
}
