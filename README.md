# Google Workspace MCP on Cloudflare Workers

Cloudflare Workers-hosted remote MCP server with Claude-native OAuth connect and Google Sheets, Docs, Slides, and Drive tools.

This project is built from the Cloudflare Workers MCP template and implements a Workers-native Google Sheets MCP toolset inspired by [`xing5/mcp-google-sheets`](https://github.com/xing5/mcp-google-sheets).

## Features

- Remote MCP endpoint on Cloudflare Workers (`/mcp`).
- Native Claude `Connect` OAuth flow.
- Per-user Google OAuth flow behind Claude auth (persistent across sessions).
- Google Sheets, Docs, Slides, and Drive operations (listing, reading, writing, management, sharing).

## Prerequisites

1. Cloudflare account + Wrangler configured.
2. Google Cloud project with:
   - Google Sheets API enabled
   - Google Docs API enabled
   - Google Slides API enabled
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
https://<your-worker-domain>/callback
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
- `https://<worker-domain>/authorize`
- `https://<worker-domain>/oauth/token`
- `https://<worker-domain>/oauth/register`
- `https://<worker-domain>/callback`

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

1. Add the MCP URL to Claude via `mcp-remote`.
2. Claude shows `Connect`.
3. User completes OAuth + Google consent in browser.
4. Claude stores MCP auth token, and the worker stores Google refresh token by user identity.
5. Tools work without passing a `session_token`.

## Tool Coverage

Implemented tools:
- **Sheets (new prefixed names + legacy aliases)**  
  `sheets_list_spreadsheets`, `sheets_create_spreadsheet`, `sheets_list_sheets`, `sheets_get_sheet_data`, `sheets_update_cells`, `sheets_batch_update_cells`, `sheets_batch_update`, `sheets_add_rows`, `sheets_add_columns`, `sheets_create_sheet`, `sheets_rename_sheet`, `sheets_copy_sheet`, `sheets_search_spreadsheets`, `sheets_find_in_spreadsheet`, `sheets_get_multiple_sheet_data`, `sheets_get_multiple_spreadsheet_summary`, `sheets_share_spreadsheet`, `sheets_add_chart`  
  Legacy unprefixed sheets tool names are still registered for compatibility.
- **Docs**  
  `docs_list_documents`, `docs_search_documents`, `docs_create_document`, `docs_get_document`, `docs_batch_update`, `docs_insert_text`, `docs_replace_all_text`, `docs_share_document`, `docs_get_multiple_document_summary`
- **Slides**  
  `slides_list_presentations`, `slides_search_presentations`, `slides_create_presentation`, `slides_get_presentation`, `slides_batch_update`, `slides_create_slide`, `slides_insert_text`, `slides_replace_all_text`, `slides_share_presentation`, `slides_get_multiple_presentation_summary`

## Notes

- Tool schemas no longer require `session_token`; user context is resolved from MCP auth.
- Google access tokens are refreshed automatically when refresh tokens are available.
- Ensure OAuth consent screen + redirect URI are configured exactly in Google Cloud.
- OAuth consent should include scopes for Sheets, Docs, Slides, and Drive access.
