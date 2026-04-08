import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { parseA1Range } from "../a1";
import { driveApiUrl, escapeDriveQuery, googleApiRequest, sheetsApiUrl } from "../google";
import { withAuth } from "./common";

async function getSheetId(accessToken: string, spreadsheetId: string, sheetName: string): Promise<number> {
	const response = await googleApiRequest<{
		sheets: Array<{ properties: { sheetId: number; title: string } }>;
	}>(accessToken, sheetsApiUrl(`/${spreadsheetId}?fields=sheets.properties`));
	const found = response.sheets.find((s) => s.properties.title === sheetName);
	if (!found) throw new Error(`Sheet not found: ${sheetName}`);
	return found.properties.sheetId;
}

export function registerSheetsTools(
	server: McpServer,
	env: AuthEnv,
	resolveUserId?: () => string | undefined,
	options?: { prefix?: string; includeLegacyAliases?: boolean },
): void {
	const prefix = options?.prefix ?? "";
	const includeLegacyAliases = options?.includeLegacyAliases ?? false;

	const registerTool = (
		name: string,
		schema: Record<string, z.ZodTypeAny>,
		handler: (accessToken: string, input: any) => Promise<unknown>,
	) => {
		const wrapped = withAuth(env, resolveUserId, handler);
		server.tool(`${prefix}${name}`, schema, wrapped);
		if (includeLegacyAliases && prefix) {
			server.tool(name, schema, wrapped);
		}
	};

	registerTool("list_spreadsheets", { folder_id: z.string().optional() }, async (accessToken, { folder_id }: { folder_id?: string }) => {
		const query = folder_id
			? `'${folder_id}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`
			: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false";
		const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
			accessToken,
			driveApiUrl("/files", { q: query, fields: "files(id,name)", pageSize: "200", orderBy: "modifiedTime desc" }),
		);
		return response.files.map((file) => ({ id: file.id, title: file.name }));
	});

	registerTool(
		"create_spreadsheet",
		{ title: z.string(), folder_id: z.string().optional() },
		async (accessToken, { title, folder_id }: { title: string; folder_id?: string }) => {
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
		},
	);

	registerTool("list_sheets", { spreadsheet_id: z.string() }, async (accessToken, { spreadsheet_id }: { spreadsheet_id: string }) => {
		const response = await googleApiRequest<{ sheets: Array<{ properties: { title: string } }> }>(
			accessToken,
			sheetsApiUrl(`/${spreadsheet_id}?fields=sheets.properties.title`),
		);
		return response.sheets.map((sheet) => sheet.properties.title);
	});

	registerTool(
		"get_sheet_data",
		{ spreadsheet_id: z.string(), sheet: z.string(), range: z.string().optional(), include_grid_data: z.boolean().optional() },
		async (
			accessToken,
			{ spreadsheet_id, sheet, range, include_grid_data }: { spreadsheet_id: string; sheet: string; range?: string; include_grid_data?: boolean },
		) => {
			if (include_grid_data) {
				const targetRange = range ? `${sheet}!${range}` : sheet;
				return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}?ranges=${encodeURIComponent(targetRange)}&includeGridData=true`));
			}
			const targetRange = range ? `${sheet}!${range}` : sheet;
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}/values/${encodeURIComponent(targetRange)}?majorDimension=ROWS`));
		},
	);

	registerTool(
		"get_sheet_formulas",
		{ spreadsheet_id: z.string(), sheet: z.string(), range: z.string().optional() },
		async (accessToken, { spreadsheet_id, sheet, range }: { spreadsheet_id: string; sheet: string; range?: string }) => {
			const targetRange = range ? `${sheet}!${range}` : sheet;
			return googleApiRequest(
				accessToken,
				sheetsApiUrl(`/${spreadsheet_id}/values/${encodeURIComponent(targetRange)}?valueRenderOption=FORMULA`),
			);
		},
	);

	registerTool(
		"update_cells",
		{ spreadsheet_id: z.string(), sheet: z.string(), range: z.string(), data: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))) },
		async (
			accessToken,
			{ spreadsheet_id, sheet, range, data }: { spreadsheet_id: string; sheet: string; range: string; data: Array<Array<string | number | boolean | null>> },
		) => {
			const targetRange = `${sheet}!${range}`;
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}/values/${encodeURIComponent(targetRange)}?valueInputOption=USER_ENTERED`), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ range: targetRange, values: data }),
			});
		},
	);

	registerTool(
		"batch_update_cells",
		{
			spreadsheet_id: z.string(),
			sheet: z.string(),
			ranges: z.record(z.string(), z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))),
		},
		async (
			accessToken,
			{ spreadsheet_id, sheet, ranges }: { spreadsheet_id: string; sheet: string; ranges: Record<string, Array<Array<string | number | boolean | null>>> },
		) => {
			const data = Object.entries(ranges).map(([range, values]) => ({ range: `${sheet}!${range}`, values }));
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}/values:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
			});
		},
	);

	registerTool(
		"batch_update",
		{ spreadsheet_id: z.string(), requests: z.array(z.unknown()) },
		async (accessToken, { spreadsheet_id, requests }: { spreadsheet_id: string; requests: unknown[] }) => {
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests }),
			});
		},
	);

	registerTool(
		"add_rows",
		{ spreadsheet_id: z.string(), sheet: z.string(), count: z.number().int().positive(), start_row: z.number().int().nonnegative().optional() },
		async (accessToken, { spreadsheet_id, sheet, count, start_row = 0 }: { spreadsheet_id: string; sheet: string; count: number; start_row?: number }) => {
			const sheetId = await getSheetId(accessToken, spreadsheet_id, sheet);
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: start_row, endIndex: start_row + count }, inheritFromBefore: false } }],
				}),
			});
		},
	);

	registerTool(
		"add_columns",
		{ spreadsheet_id: z.string(), sheet: z.string(), count: z.number().int().positive(), start_column: z.number().int().nonnegative().optional() },
		async (accessToken, { spreadsheet_id, sheet, count, start_column = 0 }: { spreadsheet_id: string; sheet: string; count: number; start_column?: number }) => {
			const sheetId = await getSheetId(accessToken, spreadsheet_id, sheet);
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					requests: [{ insertDimension: { range: { sheetId, dimension: "COLUMNS", startIndex: start_column, endIndex: start_column + count }, inheritFromBefore: false } }],
				}),
			});
		},
	);

	registerTool("create_sheet", { spreadsheet_id: z.string(), title: z.string() }, async (accessToken, { spreadsheet_id, title }: { spreadsheet_id: string; title: string }) => {
		return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
		});
	});

	registerTool(
		"rename_sheet",
		{ spreadsheet: z.string(), sheet: z.string(), new_name: z.string() },
		async (accessToken, { spreadsheet, sheet, new_name }: { spreadsheet: string; sheet: string; new_name: string }) => {
			const sheetId = await getSheetId(accessToken, spreadsheet, sheet);
			return googleApiRequest(accessToken, sheetsApiUrl(`/${spreadsheet}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId, title: new_name }, fields: "title" } }] }),
			});
		},
	);

	registerTool(
		"copy_sheet",
		{ src_spreadsheet: z.string(), src_sheet: z.string(), dst_spreadsheet: z.string(), dst_sheet: z.string() },
		async (
			accessToken,
			{ src_spreadsheet, src_sheet, dst_spreadsheet, dst_sheet }: { src_spreadsheet: string; src_sheet: string; dst_spreadsheet: string; dst_sheet: string },
		) => {
			const sourceSheetId = await getSheetId(accessToken, src_spreadsheet, src_sheet);
			const copied = await googleApiRequest<{ sheetId: number }>(
				accessToken,
				sheetsApiUrl(`/${src_spreadsheet}/sheets/${sourceSheetId}:copyTo`),
				{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationSpreadsheetId: dst_spreadsheet }) },
			);
			await googleApiRequest(accessToken, sheetsApiUrl(`/${dst_spreadsheet}:batchUpdate`), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId: copied.sheetId, title: dst_sheet }, fields: "title" } }] }),
			});
			return { copiedSheetId: copied.sheetId };
		},
	);

	registerTool(
		"list_folders",
		{ parent_folder_id: z.string().optional() },
		async (accessToken, { parent_folder_id }: { parent_folder_id?: string }) => {
			const parentClause = parent_folder_id ? `'${parent_folder_id}' in parents and ` : "";
			const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
				accessToken,
				driveApiUrl("/files", {
					q: `${parentClause}mimeType='application/vnd.google-apps.folder' and trashed=false`,
					fields: "files(id,name)",
				}),
			);
			return response.files;
		},
	);

	registerTool(
		"search_spreadsheets",
		{ query: z.string() },
		async (accessToken, { query }: { query: string }) => {
			const response = await googleApiRequest<{ files: Array<{ id: string; name: string }> }>(
				accessToken,
				driveApiUrl("/files", {
					q: `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${escapeDriveQuery(query)}' and trashed=false`,
					fields: "files(id,name)",
				}),
			);
			return response.files;
		},
	);

	registerTool(
		"find_in_spreadsheet",
		{ spreadsheet_id: z.string(), query: z.string(), max_results: z.number().int().positive().optional() },
		async (accessToken, { spreadsheet_id, query, max_results = 50 }: { spreadsheet_id: string; query: string; max_results?: number }) => {
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
		},
	);

	registerTool(
		"get_multiple_sheet_data",
		{ queries: z.array(z.object({ spreadsheet_id: z.string(), sheet: z.string(), range: z.string() })) },
		async (
			accessToken,
			{ queries }: { queries: Array<{ spreadsheet_id: string; sheet: string; range: string }> },
		) => {
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
		},
	);

	registerTool(
		"get_multiple_spreadsheet_summary",
		{ spreadsheet_ids: z.array(z.string()), rows_to_fetch: z.number().int().positive().optional() },
		async (accessToken, { spreadsheet_ids, rows_to_fetch = 5 }: { spreadsheet_ids: string[]; rows_to_fetch?: number }) => {
			return Promise.all(
				spreadsheet_ids.map(async (spreadsheetId) => {
					const meta = await googleApiRequest<{ properties: { title: string }; sheets: Array<{ properties: { title: string } }> }>(
						accessToken,
						sheetsApiUrl(`/${spreadsheetId}?fields=properties.title,sheets.properties.title`),
					);
					const sheets = await Promise.all(
						meta.sheets.map(async (sheet) => {
							const preview = await googleApiRequest<{ values?: string[][] }>(
								accessToken,
								sheetsApiUrl(`/${spreadsheetId}/values/${encodeURIComponent(`${sheet.properties.title}!A1:Z${rows_to_fetch}`)}`),
							);
							return { name: sheet.properties.title, headers: preview.values?.[0] ?? [], rows: preview.values?.slice(1) ?? [] };
						}),
					);
					return { spreadsheet_id: spreadsheetId, title: meta.properties.title, sheets };
				}),
			);
		},
	);

	registerTool(
		"share_spreadsheet",
		{
			spreadsheet_id: z.string(),
			recipients: z.array(z.object({ email_address: z.string().email(), role: z.enum(["reader", "commenter", "writer"]) })),
			send_notification: z.boolean().optional(),
		},
		async (
			accessToken,
			{ spreadsheet_id, recipients, send_notification = true }: { spreadsheet_id: string; recipients: Array<{ email_address: string; role: "reader" | "commenter" | "writer" }>; send_notification?: boolean },
		) => {
			const successes: Array<{ email: string }> = [];
			const failures: Array<{ email: string; error: string }> = [];
			for (const recipient of recipients) {
				try {
					await googleApiRequest(accessToken, `https://www.googleapis.com/drive/v3/files/${spreadsheet_id}/permissions?sendNotificationEmail=${String(send_notification)}`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ type: "user", role: recipient.role, emailAddress: recipient.email_address }),
					});
					successes.push({ email: recipient.email_address });
				} catch (error) {
					failures.push({ email: recipient.email_address, error: (error as Error).message });
				}
			}
			return { successes, failures };
		},
	);

	registerTool(
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
		async (
			accessToken,
			input: {
				spreadsheet_id: string;
				sheet: string;
				chart_type: "COLUMN" | "BAR" | "LINE" | "AREA" | "PIE" | "SCATTER" | "COMBO" | "HISTOGRAM";
				data_range: string;
				title?: string;
				x_axis_label?: string;
				y_axis_label?: string;
				position_x?: number;
				position_y?: number;
				width?: number;
				height?: number;
			},
		) => {
			const { spreadsheet_id, sheet, chart_type, data_range, title, x_axis_label, y_axis_label, position_x = 0, position_y = 0, width = 600, height = 400 } = input;
			const sheetId = await getSheetId(accessToken, spreadsheet_id, sheet);
			const a1 = parseA1Range(data_range);
			const response = await googleApiRequest<{ replies?: Array<{ addChart?: { chart?: { chartId?: number } } }> }>(
				accessToken,
				sheetsApiUrl(`/${spreadsheet_id}:batchUpdate`),
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						requests: [{
							addChart: {
								chart: {
									spec: {
										title: title ?? undefined,
										basicChart: {
											chartType: chart_type,
											legendPosition: "BOTTOM_LEGEND",
											axis: [{ position: "BOTTOM_AXIS", title: x_axis_label ?? "" }, { position: "LEFT_AXIS", title: y_axis_label ?? "" }],
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
						}],
					}),
				},
			);
			return { success: true, chartId: response.replies?.[0]?.addChart?.chart?.chartId ?? null, details: response };
		},
	);
}
