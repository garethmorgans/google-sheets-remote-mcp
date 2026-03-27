import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAuthenticatedUserId, getValidAccessToken, type AuthEnv } from "./auth";
import { parseA1Range } from "./a1";
import { driveApiUrl, googleApiRequest, sheetsApiUrl } from "./google";

function textResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function withAuth<T extends object>(
	env: AuthEnv,
	handler: (accessToken: string, input: T) => Promise<unknown>,
) {
	return async (input: T) => {
		const userId = getAuthenticatedUserId();
		const accessToken = await getValidAccessToken(env, userId);
		return textResult(await handler(accessToken, input));
	};
}

async function getSheetId(accessToken: string, spreadsheetId: string, sheetName: string): Promise<number> {
	const response = await googleApiRequest<{
		sheets: Array<{ properties: { sheetId: number; title: string } }>;
	}>(accessToken, sheetsApiUrl(`/${spreadsheetId}?fields=sheets.properties`));
	const found = response.sheets.find((s) => s.properties.title === sheetName);
	if (!found) throw new Error(`Sheet not found: ${sheetName}`);
	return found.properties.sheetId;
}

export function registerTools(server: McpServer, env: AuthEnv): void {
	server.tool(
		"list_spreadsheets",
		{ folder_id: z.string().optional() },
		withAuth(env, async (accessToken, { folder_id }) => {
			const query = folder_id
				? `'${folder_id}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
				: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
			const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
				accessToken,
				driveApiUrl("/files", {
					q: query,
					fields: "files(id,name)",
					pageSize: "200",
					orderBy: "modifiedTime desc",
				}),
			);
			return response.files.map((file) => ({ id: file.id, title: file.name }));
		}),
	);

	server.tool(
		"create_spreadsheet",
		{ title: z.string(), folder_id: z.string().optional() },
		withAuth(env, async (accessToken, { title, folder_id }) => {
			const created = await googleApiRequest<{ spreadsheetId: string; properties: { title: string } }>(
				accessToken,
				sheetsApiUrl(""),
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ properties: { title } }) },
			);
			if (folder_id) {
				await googleApiRequest(
					accessToken,
					`https://www.googleapis.com/drive/v3/files/${created.spreadsheetId}?addParents=${folder_id}&removeParents=root&fields=id,parents`,
					{ method: "PATCH" },
				);
			}
			return { spreadsheetId: created.spreadsheetId, title: created.properties.title, folder: folder_id ?? null };
		}),
	);

	server.tool(
		"list_sheets",
		{ spreadsheet_id: z.string() },
		withAuth(env, async (accessToken, { spreadsheet_id }) => {
			const response = await googleApiRequest<{
				sheets: Array<{ properties: { title: string } }>;
			}>(accessToken, sheetsApiUrl(`/${spreadsheet_id}?fields=sheets.properties.title`));
			return response.sheets.map((sheet) => sheet.properties.title);
		}),
	);

	server.tool(
		"get_sheet_data",
		{
			spreadsheet_id: z.string(),
			sheet: z.string(),
			range: z.string().optional(),
			include_grid_data: z.boolean().optional(),
		},
		withAuth(env, async (accessToken, { spreadsheet_id, sheet, range, include_grid_data }) => {
			if (include_grid_data) {
				const targetRange = range ? `${sheet}!${range}` : sheet;
				return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}?ranges=${encodeURIComponent(targetRange)}&includeGridData=true`));
			}
			const targetRange = range ? `${sheet}!${range}` : sheet;
			return googleApiRequest(
				accessToken,
				sheetsApiUrl(`/${spreadsheet_id}/values/${encodeURIComponent(targetRange)}?majorDimension=ROWS`),
			);
		}),
	);

	server.tool(
		"get_sheet_formulas",
		{ spreadsheet_id: z.string(), sheet: z.string(), range: z.string().optional() },
		withAuth(env, async (accessToken, { spreadsheet_id, sheet, range }) => {
			const targetRange = range ? `${sheet}!${range}` : sheet;
			return googleApiRequest(
				accessToken,
				sheetsApiUrl(`/${spreadsheet_id}/values/${encodeURIComponent(targetRange)}?valueRenderOption=FORMULA`),
			);
		}),
	);

	server.tool(
		"update_cells",
		{
			spreadsheet_id: z.string(),
			sheet: z.string(),
			range: z.string(),
			data: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
		},
		withAuth(env, async (accessToken, { spreadsheet_id, sheet, range, data }) => {
			const targetRange = `${sheet}!${range}`;
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}/values/${encodeURIComponent(targetRange)}?valueInputOption=USER_ENTERED`), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ range: targetRange, values: data }),
			});
		}),
	);

	server.tool(
		"batch_update_cells",
		{
			spreadsheet_id: z.string(),
			sheet: z.string(),
			ranges: z.record(z.string(), z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))),
		},
		withAuth(env, async (accessToken, { spreadsheet_id, sheet, ranges }) => {
			const data = Object.entries(ranges).map(([range, values]) => ({ range: `${sheet}!${range}`, values }));
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}/values:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
			});
		}),
	);

	server.tool(
		"add_rows",
		{ spreadsheet_id: z.string(), sheet: z.string(), count: z.number().int().positive(), start_row: z.number().int().nonnegative().optional() },
		withAuth(env, async (accessToken, { spreadsheet_id, sheet, count, start_row = 0 }) => {
			const sheetId = await getSheetId(accessToken, spreadsheet_id, sheet);
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{
						insertDimension: {
							range: { sheetId, dimension: "ROWS", startIndex: start_row, endIndex: start_row + count },
							inheritFromBefore: false,
						},
					}],
				}),
			});
		}),
	);

	server.tool(
		"add_columns",
		{ spreadsheet_id: z.string(), sheet: z.string(), count: z.number().int().positive(), start_column: z.number().int().nonnegative().optional() },
		withAuth(env, async (accessToken, { spreadsheet_id, sheet, count, start_column = 0 }) => {
			const sheetId = await getSheetId(accessToken, spreadsheet_id, sheet);
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{
						insertDimension: {
							range: { sheetId, dimension: "COLUMNS", startIndex: start_column, endIndex: start_column + count },
							inheritFromBefore: false,
						},
					}],
				}),
			});
		}),
	);

	server.tool(
		"create_sheet",
		{ spreadsheet_id: z.string(), title: z.string() },
		withAuth(env, async (accessToken, { spreadsheet_id, title }) => {
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
			});
		}),
	);

	server.tool(
		"rename_sheet",
		{ spreadsheet: z.string(), sheet: z.string(), new_name: z.string() },
		withAuth(env, async (accessToken, { spreadsheet, sheet, new_name }) => {
			const sheetId = await getSheetId(accessToken, spreadsheet, sheet);
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId, title: new_name }, fields: "title" } }] }),
			});
		}),
	);

	server.tool(
		"copy_sheet",
		{ src_spreadsheet: z.string(), src_sheet: z.string(), dst_spreadsheet: z.string(), dst_sheet: z.string() },
		withAuth(env, async (accessToken, { src_spreadsheet, src_sheet, dst_spreadsheet, dst_sheet }) => {
			const sourceSheetId = await getSheetId(accessToken, src_spreadsheet, src_sheet);
			const copied = await googleApiRequest<{ sheetId: number }>(
				accessToken,
				sheetsApiUrl(`/${src_spreadsheet}/sheets/${sourceSheetId}:copyTo`),
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationSpreadsheetId: dst_spreadsheet }) },
			);
			await googleApiRequest(accessToken, sheetsApiUrl(`/${dst_spreadsheet}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ updateSheetProperties: { properties: { sheetId: copied.sheetId, title: dst_sheet }, fields: "title" } }],
				}),
			});
			return { copiedSheetId: copied.sheetId };
		}),
	);

	server.tool(
		"batch_update",
		{ spreadsheet_id: z.string(), requests: z.array(z.unknown()) },
		withAuth(env, async (accessToken, { spreadsheet_id, requests }) => {
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests }),
			});
		}),
	);

	server.tool(
		"find_in_spreadsheet",
		{ spreadsheet_id: z.string(), query: z.string(), max_results: z.number().int().positive().optional() },
		withAuth(env, async (accessToken, { spreadsheet_id, query, max_results = 50 }) => {
			const spreadsheet = await googleApiRequest<{
				sheets: Array<{ properties: { title: string }; data?: Array<{ rowData?: Array<{ values?: Array<{ formattedValue?: string }> }> }> }>;
			}>(accessToken, sheetsApiUrl(`/${spreadsheet_id}?includeGridData=true`));
			const matches: Array<{ sheet: string; row: number; column: number; value: string }> = [];
			for (const sheet of spreadsheet.sheets) {
				const rows = sheet.data?.[0]?.rowData ?? [];
				for (let r = 0; r < rows.length; r += 1) {
					const cells = rows[r]?.values ?? [];
					for (let c = 0; c < cells.length; c += 1) {
						const value = cells[c]?.formattedValue ?? "";
						if (value.toLowerCase().includes(query.toLowerCase())) {
							matches.push({ sheet: sheet.properties.title, row: r + 1, column: c + 1, value });
							if (matches.length >= max_results) return matches;
						}
					}
				}
			}
			return matches;
		}),
	);

	server.tool(
		"search_spreadsheets",
		{ query: z.string() },
		withAuth(env, async (accessToken, { query }) => {
			const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
				accessToken,
				driveApiUrl("/files", {
					q: `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${query.replace(/'/g, "\\'")}' and trashed=false`,
					fields: "files(id,name)",
				}),
			);
			return response.files;
		}),
	);

	server.tool(
		"list_folders",
		{ parent_folder_id: z.string().optional() },
		withAuth(env, async (accessToken, { parent_folder_id }) => {
			const parentClause = parent_folder_id ? `'${parent_folder_id}' in parents and ` : "";
			const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
				accessToken,
				driveApiUrl("/files", {
					q: `${parentClause}mimeType='application/vnd.google-apps.folder' and trashed=false`,
					fields: "files(id,name)",
				}),
			);
			return response.files;
		}),
	);

	server.tool(
		"get_multiple_sheet_data",
		{
			queries: z.array(z.object({ spreadsheet_id: z.string(), sheet: z.string(), range: z.string() })),
		},
		withAuth(env, async (accessToken, { queries }) => {
			return Promise.all(
				queries.map(async (query) => {
					try {
						const data = await googleApiRequest(
							accessToken,
							sheetsApiUrl(`/${query.spreadsheet_id}/values/${encodeURIComponent(`${query.sheet}!${query.range}`)}`),
						);
						return { ...query, data };
					} catch (error) {
						return { ...query, error: (error as Error).message };
					}
				}),
			);
		}),
	);

	server.tool(
		"get_multiple_spreadsheet_summary",
		{ spreadsheet_ids: z.array(z.string()), rows_to_fetch: z.number().int().positive().optional() },
		withAuth(env, async (accessToken, { spreadsheet_ids, rows_to_fetch = 5 }) => {
			return Promise.all(
				spreadsheet_ids.map(async (spreadsheetId) => {
					const meta = await googleApiRequest<{
						properties: { title: string };
						sheets: Array<{ properties: { title: string } }>;
					}>(accessToken, sheetsApiUrl(`/${spreadsheetId}?fields=properties.title,sheets.properties.title`));

					const sheets = await Promise.all(
						meta.sheets.map(async (sheet) => {
							const preview = await googleApiRequest<{ values?: string[][] }>(
								accessToken,
								sheetsApiUrl(`/${spreadsheetId}/values/${encodeURIComponent(`${sheet.properties.title}!A1:Z${rows_to_fetch}`)}`),
							);
							return {
								name: sheet.properties.title,
								headers: preview.values?.[0] ?? [],
								rows: preview.values?.slice(1) ?? [],
							};
						}),
					);
					return { spreadsheet_id: spreadsheetId, title: meta.properties.title, sheets };
				}),
			);
		}),
	);

	server.tool(
		"share_spreadsheet",
		{
			spreadsheet_id: z.string(),
			recipients: z.array(z.object({ email_address: z.string().email(), role: z.enum(["reader", "commenter", "writer"]) })),
			send_notification: z.boolean().optional(),
		},
		withAuth(env, async (accessToken, { spreadsheet_id, recipients, send_notification = true }) => {
			const successes: Array<{ email: string }> = [];
			const failures: Array<{ email: string; error: string }> = [];
			for (const recipient of recipients) {
				try {
					await googleApiRequest(
						accessToken,
						`https://www.googleapis.com/drive/v3/files/${spreadsheet_id}/permissions?sendNotificationEmail=${String(send_notification)}`,
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
		}),
	);

	server.tool(
		"add_chart",
		{
			spreadsheet_id: z.string(),
			sheet: z.string(),
			chart_type: z.enum(["COLUMN", "BAR", "LINE", "AREA", "PIE", "SCATTER", "COMBO", "HISTOGRAM"]),
			data_range: z.string(),
			title: z.string().optional(),
			x_axis_label: z.string().optional(),
			y_axis_label: z.string().optional(),
			position_x: z.number().int().nonnegative().optional(),
			position_y: z.number().int().nonnegative().optional(),
			width: z.number().int().positive().optional(),
			height: z.number().int().positive().optional(),
		},
		withAuth(env, async (accessToken, input) => {
			const {
				spreadsheet_id,
				sheet,
				chart_type,
				data_range,
				title,
				x_axis_label,
				y_axis_label,
				position_x = 0,
				position_y = 0,
				width = 600,
				height = 400,
			} = input;
			const sheetId = await getSheetId(accessToken, spreadsheet_id, sheet);
			const a1 = parseA1Range(data_range);
			const response = await googleApiRequest<{ replies?: Array<{ addChart?: { chart?: { chartId?: number } } }> }>(
				accessToken,
				sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						requests: [
							{
								addChart: {
									chart: {
										spec: {
											title: title ?? undefined,
											basicChart: {
												chartType: chart_type,
												legendPosition: "BOTTOM_LEGEND",
												axis: [
													{ position: "BOTTOM_AXIS", title: x_axis_label ?? "" },
													{ position: "LEFT_AXIS", title: y_axis_label ?? "" },
												],
												domains: [{ domain: { sourceRange: { sources: [{ sheetId, ...a1 }] } } }],
												series: [{ series: { sourceRange: { sources: [{ sheetId, ...a1 }] } } }],
												headerCount: 1,
											},
										},
										position: {
											overlayPosition: {
												anchorCell: { sheetId, rowIndex: 0, columnIndex: 0 },
												offsetXPixels: position_x,
												offsetYPixels: position_y,
												widthPixels: width,
												heightPixels: height,
											},
										},
									},
								},
							},
						],
					}),
				},
			);
			return { success: true, chartId: response.replies?.[0]?.addChart?.chart?.chartId ?? null, details: response };
		}),
	);
}
