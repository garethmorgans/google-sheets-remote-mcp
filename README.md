# Google Sheets Remote MCP on Cloudflare Workers

Cloudflare Workers-hosted remote MCP server with Google OAuth and Google Sheets/Drive tools.

This project is built from the Cloudflare Workers MCP template and implements a Workers-native Google Sheets MCP toolset inspired by [`xing5/mcp-google-sheets`](https://github.com/xing5/mcp-google-sheets).

## Features

- Remote MCP endpoint on Cloudflare Workers (`/mcp`).
- Per-user Google OAuth flow (each user authenticates their own Google account).
- Google Sheets and Drive operations (listing, reading, writing, sheet management, sharing, chart creation).

## Prerequisites

1. Cloudflare account + Wrangler configured.
2. Google Cloud project with:
   - Google Sheets API enabled
   - Google Drive API enabled
3. OAuth 2.0 credentials (Web application) in Google Cloud.

## Environment and Secrets

Set these secrets:

```bash
wrangler secret put GOOGLE_OAUTH_CLIENT_ID
wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
wrangler secret put GOOGLE_OAUTH_REDIRECT_URI
```

`GOOGLE_OAUTH_REDIRECT_URI` must be:

```text
https://<your-worker-domain>/auth/google/callback
```

Also configure `GOOGLE_AUTH_KV` namespace in `wrangler.jsonc`.

## Local Development

```bash
npm install
npm run dev
```

MCP endpoint:

```text
http://localhost:8787/mcp
```

## Deployment

```bash
npm run deploy
```

Deployed endpoints:

- `https://<worker-domain>/mcp`
- `https://<worker-domain>/auth/google/callback`

## Claude Cowork / mcp-remote Setup

Example MCP config:

```json
{
	"mcpServers": {
		"google-sheets-remote": {
			"command": "npx",
			"args": ["mcp-remote", "https://<worker-domain>/mcp"]
		}
	}
}
```

## Authentication Flow

1. Call tool `start_google_auth`.
2. Open returned `authorization_url`.
3. Complete Google consent.
4. Callback page returns a `session_token`.
5. Use `session_token` with Google Sheets tools.

## Tool Coverage

Implemented tools:

- `start_google_auth`
- `list_spreadsheets`
- `create_spreadsheet`
- `list_sheets`
- `get_sheet_data`
- `get_sheet_formulas`
- `update_cells`
- `batch_update_cells`
- `add_rows`
- `add_columns`
- `create_sheet`
- `rename_sheet`
- `copy_sheet`
- `batch_update`
- `find_in_spreadsheet`
- `search_spreadsheets`
- `list_folders`
- `get_multiple_sheet_data`
- `get_multiple_spreadsheet_summary`
- `share_spreadsheet`
- `add_chart`

## Notes

- Tool schemas include `session_token` for per-user token lookup.
- Access tokens are refreshed automatically when refresh tokens are available.
- Ensure OAuth consent screen + redirect URI are configured exactly in Google Cloud.
