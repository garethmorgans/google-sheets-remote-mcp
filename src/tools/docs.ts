import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { docsApiUrl, driveApiUrl, escapeDriveQuery, googleApiRequest } from "../google";
import { withAuth } from "./common";

interface DocsSummaryDocument {
	documentId: string;
	title: string;
	body?: {
		content?: Array<{
			paragraph?: {
				elements?: Array<{ textRun?: { content?: string } }>;
			};
		}>;
	};
}

export function registerDocsTools(server: McpServer, env: AuthEnv, resolveUserId?: () => string | undefined): void {
	const reg = (name: string, schema: Record<string, z.ZodTypeAny>, handler: (accessToken: string, input: any) => Promise<unknown>) =>
		server.tool(name, schema, withAuth(env, resolveUserId, handler));

	reg("docs_list_documents", { folder_id: z.string().optional() }, async (accessToken, { folder_id }: { folder_id?: string }) => {
		const query = folder_id
			? `'${folder_id}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`
			: "mimeType='application/vnd.google-apps.document' and trashed=false";
		const response = await googleApiRequest<{ files: Array<{ id: string; name: string; modifiedTime?: string }> }>(
			accessToken,
			driveApiUrl("/files", { q: query, fields: "files(id,name,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "200" }),
		);
		return response.files.map((f) => ({ id: f.id, title: f.name, modifiedTime: f.modifiedTime }));
	});

	reg("docs_search_documents", { query: z.string() }, async (accessToken, { query }: { query: string }) => {
		const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
			accessToken,
			driveApiUrl("/files", {
				q: `mimeType='application/vnd.google-apps.document' and name contains '${escapeDriveQuery(query)}' and trashed=false`,
				fields: "files(id,name)",
			}),
		);
		return response.files;
	});

	reg("docs_create_document", { title: z.string(), folder_id: z.string().optional() }, async (accessToken, { title, folder_id }: { title: string; folder_id?: string }) => {
		const created = await googleApiRequest<{ documentId: string; title: string }>(accessToken, docsApiUrl(""), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		});
		if (folder_id) {
			await googleApiRequest(
				accessToken,
				`https://www.googleapis.com/drive/v3/files/${created.documentId}?addParents=${folder_id}&removeParents=root&fields=id,parents`,
				{ method: "PATCH" },
			);
		}
		return { documentId: created.documentId, title: created.title };
	});

	reg("docs_get_document", { document_id: z.string() }, async (accessToken, { document_id }: { document_id: string }) =>
		googleApiRequest(accessToken, docsApiUrl(`/${document_id}`)),
	);

	reg("docs_batch_update", { document_id: z.string(), requests: z.array(z.unknown()) }, async (accessToken, { document_id, requests }: { document_id: string; requests: unknown[] }) =>
		googleApiRequest(accessToken, docsApiUrl(`/${document_id}:batchUpdate`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requests }),
		}),
	);

	reg(
		"docs_insert_text",
		{ document_id: z.string(), text: z.string(), index: z.number().int().nonnegative() },
		async (accessToken, { document_id, text, index }: { document_id: string; text: string; index: number }) =>
			googleApiRequest(accessToken, docsApiUrl(`/${document_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests: [{ insertText: { location: { index }, text } }] }),
			}),
	);

	reg(
		"docs_replace_all_text",
		{ document_id: z.string(), find_text: z.string(), replace_text: z.string(), match_case: z.boolean().optional() },
		async (
			accessToken,
			{ document_id, find_text, replace_text, match_case = true }: { document_id: string; find_text: string; replace_text: string; match_case?: boolean },
		) =>
			googleApiRequest(accessToken, docsApiUrl(`/${document_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ replaceAllText: { containsText: { text: find_text, matchCase: match_case }, replaceText: replace_text } }],
				}),
			}),
	);

	reg(
		"docs_share_document",
		{
			document_id: z.string(),
			recipients: z.array(z.object({ email_address: z.string().email(), role: z.enum(["reader", "commenter", "writer"]) })),
			send_notification: z.boolean().optional(),
		},
		async (
			accessToken,
			{ document_id, recipients, send_notification = true }: { document_id: string; recipients: Array<{ email_address: string; role: "reader" | "commenter" | "writer" }>; send_notification?: boolean },
		) => {
			const successes: Array<{ email: string }> = [];
			const failures: Array<{ email: string; error: string }> = [];
			for (const recipient of recipients) {
				try {
					await googleApiRequest(
						accessToken,
						`https://www.googleapis.com/drive/v3/files/${document_id}/permissions?sendNotificationEmail=${String(send_notification)}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ type: "user", role: recipient.role, emailAddress: recipient.email_address }),
						},
					);
					successes.push({ email: recipient.email_address });
				} catch (error) {
					failures.push({ email: recipient.email_address, error: (error as Error).message });
				}
			}
			return { successes, failures };
		},
	);

	reg("docs_get_multiple_document_summary", { document_ids: z.array(z.string()) }, async (accessToken, { document_ids }: { document_ids: string[] }) => {
		return Promise.all(
			document_ids.map(async (id) => {
				const doc = await googleApiRequest<DocsSummaryDocument>(
					accessToken,
					docsApiUrl(`/${id}`),
				);
				const preview = (doc.body?.content ?? [])
					.flatMap((c) => c.paragraph?.elements ?? [])
					.map((e) => e.textRun?.content ?? "")
					.join("")
					.slice(0, 500);
				return { document_id: doc.documentId, title: doc.title, preview };
			}),
		);
	});
}
