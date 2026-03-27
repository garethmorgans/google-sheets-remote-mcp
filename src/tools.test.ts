import { describe, expect, it } from "vitest";
import { parseA1Range } from "./tools";

describe("parseA1Range", () => {
	it("parses single cell", () => {
		expect(parseA1Range("A1")).toEqual({
			startRowIndex: 0,
			endRowIndex: 1,
			startColumnIndex: 0,
			endColumnIndex: 1,
		});
	});

	it("parses multi-column range", () => {
		expect(parseA1Range("B2:D5")).toEqual({
			startRowIndex: 1,
			endRowIndex: 5,
			startColumnIndex: 1,
			endColumnIndex: 4,
		});
	});
});
