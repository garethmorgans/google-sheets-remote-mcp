import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { driveApiUrl, escapeDriveQuery, googleApiRequest, slidesApiUrl } from "../google";
import { withAuth } from "./common";

export function registerSlidesTools(server: McpServer, env: AuthEnv, resolveUserId?: () => string | undefined): void {
	const reg = (name: string, schema: Record<string, z.ZodTypeAny>, handler: (accessToken: string, input: any) => Promise<unknown>) =>
		server.tool(name, schema, withAuth(env, resolveUserId, handler));

	reg("slides_list_presentations", { folder_id: z.string().optional() }, async (accessToken, { folder_id }: { folder_id?: string }) => {
		const query = folder_id
			? `'${folder_id}' in parents and mimeType='application/vnd.google-apps.presentation' and trashed=false`
			: "mimeType='application/vnd.google-apps.presentation' and trashed=false";
		const response = await googleApiRequest<{ files: Array<{ id: string; name: string; modifiedTime?: string }> }>(
			accessToken,
			driveApiUrl("/files", { q: query, fields: "files(id,name,modifiedTime)", orderBy: "modifiedTime desc", pageSize: "200" }),
		);
		return response.files.map((f) => ({ id: f.id, title: f.name, modifiedTime: f.modifiedTime }));
	});

	reg("slides_search_presentations", { query: z.string() }, async (accessToken, { query }: { query: string }) => {
		const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
			accessToken,
			driveApiUrl("/files", {
				q: `mimeType='application/vnd.google-apps.presentation' and name contains '${escapeDriveQuery(query)}' and trashed=false`,
				fields: "files(id,name)",
			}),
		);
		return response.files;
	});

	reg("slides_create_presentation", { title: z.string(), folder_id: z.string().optional() }, async (accessToken, { title, folder_id }: { title: string; folder_id?: string }) => {
		const created = await googleApiRequest<{ presentationId: string; title: string }>(accessToken, slidesApiUrl(""), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title }),
		});
		if (folder_id) {
			await googleApiRequest(
				accessToken,
				`https://www.googleapis.com/drive/v3/files/${created.presentationId}?addParents=${folder_id}&removeParents=root&fields=id,parents`,
				{ method: "PATCH" },
			);
		}
		return { presentationId: created.presentationId, title: created.title };
	});

	reg("slides_get_presentation", { presentation_id: z.string() }, async (accessToken, { presentation_id }: { presentation_id: string }) =>
		googleApiRequest(accessToken, slidesApiUrl(`/${presentation_id}`)),
	);

	reg("slides_batch_update", { presentation_id: z.string(), requests: z.array(z.unknown()) }, async (accessToken, { presentation_id, requests }: { presentation_id: string; requests: unknown[] }) =>
		googleApiRequest(accessToken, slidesApiUrl(`/${presentation_id}:batchUpdate`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requests }),
		}),
	);

	reg(
		"slides_create_slide",
		{
			presentation_id: z.string(),
			object_id: z.string().optional(),
			layout: z.string().optional(),
			insertion_index: z.number().int().nonnegative().optional(),
		},
		async (
			accessToken,
			{ presentation_id, object_id, layout = "TITLE_AND_BODY", insertion_index }: { presentation_id: string; object_id?: string; layout?: string; insertion_index?: number },
		) =>
			googleApiRequest(accessToken, slidesApiUrl(`/${presentation_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [
						{
							createSlide: {
								objectId: object_id,
								insertionIndex: insertion_index,
								slideLayoutReference: { predefinedLayout: layout },
							},
						},
					],
				}),
			}),
	);

	reg(
		"slides_insert_text",
		{ presentation_id: z.string(), object_id: z.string(), text: z.string(), insertion_index: z.number().int().nonnegative().optional() },
		async (
			accessToken,
			{ presentation_id, object_id, text, insertion_index = 0 }: { presentation_id: string; object_id: string; text: string; insertion_index?: number },
		) =>
			googleApiRequest(accessToken, slidesApiUrl(`/${presentation_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ insertText: { objectId: object_id, text, insertionIndex: insertion_index } }],
				}),
			}),
	);

	reg(
		"slides_replace_all_text",
		{ presentation_id: z.string(), find_text: z.string(), replace_text: z.string(), match_case: z.boolean().optional() },
		async (
			accessToken,
			{ presentation_id, find_text, replace_text, match_case = true }: { presentation_id: string; find_text: string; replace_text: string; match_case?: boolean },
		) =>
			googleApiRequest(accessToken, slidesApiUrl(`/${presentation_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ replaceAllText: { containsText: { text: find_text, matchCase: match_case }, replaceText: replace_text } }],
				}),
			}),
	);

	reg(
		"slides_share_presentation",
		{
			presentation_id: z.string(),
			recipients: z.array(z.object({ email_address: z.string().email(), role: z.enum(["reader", "commenter", "writer"]) })),
			send_notification: z.boolean().optional(),
		},
		async (
			accessToken,
			{ presentation_id, recipients, send_notification = true }: { presentation_id: string; recipients: Array<{ email_address: string; role: "reader" | "commenter" | "writer" }>; send_notification?: boolean },
		) => {
			const successes: Array<{ email: string }> = [];
			const failures: Array<{ email: string; error: string }> = [];
			for (const recipient of recipients) {
				try {
					await googleApiRequest(
						accessToken,
						`https://www.googleapis.com/drive/v3/files/${presentation_id}/permissions?sendNotificationEmail=${String(send_notification)}`,
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

	reg("slides_get_multiple_presentation_summary", { presentation_ids: z.array(z.string()) }, async (accessToken, { presentation_ids }: { presentation_ids: string[] }) =>
		Promise.all(
			presentation_ids.map(async (id) => {
				const presentation = await googleApiRequest<{ presentationId: string; title: string; slides?: Array<{ objectId: string }> }>(
					accessToken,
					slidesApiUrl(`/${id}`),
				);
				return {
					presentation_id: presentation.presentationId,
					title: presentation.title,
					slide_count: presentation.slides?.length ?? 0,
					slide_ids: (presentation.slides ?? []).map((s) => s.objectId).slice(0, 20),
				};
			}),
		),
	);
}
