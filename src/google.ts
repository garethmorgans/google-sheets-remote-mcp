export interface OAuthTokenRecord {
	accessToken: string;
	refreshToken?: string;
	expiryDate: number;
	scope?: string;
	tokenType?: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

export interface GoogleAuthEnv {
	GOOGLE_OAUTH_CLIENT_ID: string;
	GOOGLE_OAUTH_CLIENT_SECRET: string;
	GOOGLE_OAUTH_REDIRECT_URI: string;
}

export async function exchangeAuthCodeForTokens(
	env: GoogleAuthEnv,
	code: string,
	codeVerifier: string,
): Promise<OAuthTokenRecord> {
	const body = new URLSearchParams({
		code,
		client_id: env.GOOGLE_OAUTH_CLIENT_ID,
		client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
		redirect_uri: env.GOOGLE_OAUTH_REDIRECT_URI,
		grant_type: "authorization_code",
		code_verifier: codeVerifier,
	});
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!response.ok) {
		throw new Error(`Google token exchange failed: ${await response.text()}`);
	}

	const json = (await response.json()) as {
		access_token: string;
		refresh_token?: string;
		expires_in: number;
		scope?: string;
		token_type?: string;
	};
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token,
		expiryDate: Date.now() + json.expires_in * 1000 - 60_000,
		scope: json.scope,
		tokenType: json.token_type,
	};
}

export async function refreshAccessToken(env: GoogleAuthEnv, refreshToken: string): Promise<OAuthTokenRecord> {
	const body = new URLSearchParams({
		client_id: env.GOOGLE_OAUTH_CLIENT_ID,
		client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
		refresh_token: refreshToken,
		grant_type: "refresh_token",
	});
	const response = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!response.ok) {
		throw new Error(`Google token refresh failed: ${await response.text()}`);
	}

	const json = (await response.json()) as {
		access_token: string;
		expires_in: number;
		scope?: string;
		token_type?: string;
	};
	return {
		accessToken: json.access_token,
		refreshToken,
		expiryDate: Date.now() + json.expires_in * 1000 - 60_000,
		scope: json.scope,
		tokenType: json.token_type,
	};
}

export async function googleApiRequest<T>(accessToken: string, url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, {
		...init,
		headers: {
			Authorization: `Bearer ${accessToken}`,
			...(init?.headers || {}),
		},
	});
	if (!response.ok) {
		throw new Error(`Google API request failed (${response.status}): ${await response.text()}`);
	}
	return (await response.json()) as T;
}

export function driveApiUrl(path: string, query?: Record<string, string | undefined>): string {
	const url = new URL(`${GOOGLE_DRIVE_API}${path}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	return url.toString();
}

export function sheetsApiUrl(path: string): string {
	return `${GOOGLE_SHEETS_API}${path}`;
}
