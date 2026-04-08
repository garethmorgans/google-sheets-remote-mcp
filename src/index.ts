import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { beginAuthorize, handleGoogleAuthCallback, type AuthEnv } from "./auth";
import { registerTools } from "./tools";

export class GoogleSheetsMCP extends McpAgent {
	server = new McpServer({
		name: "Google Sheets Remote MCP",
		version: "1.0.0",
	});

	async init() {
		registerTools(this.server, this.env as unknown as AuthEnv, () => {
			const props = this.props as { userId?: string; sub?: string; email?: string } | undefined;
			return props?.userId ?? props?.sub ?? props?.email;
		});
	}
}

// Backwards-compatibility: older Durable Objects were created from the template's
// exported class name `MyMCP`. Keeping this export prevents Cloudflare deploy-time
// failures when upgrading the worker.
export class MyMCP extends GoogleSheetsMCP {}

const apiHandler = {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return GoogleSheetsMCP.serve("/mcp").fetch(request, env, ctx);
	},
};

const defaultHandler = {
	fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		if (url.pathname === "/authorize") {
			return beginAuthorize(request, env as unknown as AuthEnv);
		}

		if (url.pathname === "/callback" || url.pathname === "/auth/google/callback") {
			return handleGoogleAuthCallback(request, env as unknown as AuthEnv);
		}

		return new Response("Not found", { status: 404 });
	},
};

export default new OAuthProvider({
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/oauth/token",
	clientRegistrationEndpoint: "/oauth/register",
	apiRoute: "/mcp",
	apiHandler: apiHandler as any,
	defaultHandler: defaultHandler as any,
});
