import { getAuthenticatedUserId, getValidAccessToken, type AuthEnv } from "../auth";

export function textResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function withAuth<T extends object>(
	env: AuthEnv,
	resolveUserId: (() => string | undefined) | undefined,
	handler: (accessToken: string, input: T) => Promise<unknown>,
) {
	return async (input: T) => {
		const userId = getAuthenticatedUserId(resolveUserId);
		const accessToken = await getValidAccessToken(env, userId);
		return textResult(await handler(accessToken, input));
	};
}
