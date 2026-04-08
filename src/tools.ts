import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthEnv } from "./auth";
import { registerDocsTools } from "./tools/docs";
import { registerSheetsTools } from "./tools/sheets";
import { registerSlidesTools } from "./tools/slides";

export function registerTools(server: McpServer, env: AuthEnv, resolveUserId?: () => string | undefined): void {
	registerSheetsTools(server, env, resolveUserId, { prefix: "sheets_", includeLegacyAliases: true });
	registerDocsTools(server, env, resolveUserId);
	registerSlidesTools(server, env, resolveUserId);
}
