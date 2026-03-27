import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { handleGoogleAuthCallback, type AuthEnv } from "./auth";
import { registerTools } from "./tools";

export class GoogleSheetsMCP extends McpAgent {
	server = new McpServer({
		name: "Google Sheets Remote MCP",
		version: "1.0.0",
	});

	async init() {
		registerTools(this.server, this.env as unknown as AuthEnv);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/auth/google/callback") {
			return handleGoogleAuthCallback(request, env as unknown as AuthEnv);
		}

		if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
			return GoogleSheetsMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};
