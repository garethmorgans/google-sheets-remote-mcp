import { describe, expect, it } from "vitest";
import { docsApiUrl, escapeDriveQuery, slidesApiUrl } from "./google";

describe("google url helpers", () => {
	it("builds docs and slides api URLs", () => {
		expect(docsApiUrl("/abc")).toBe("https://docs.googleapis.com/v1/documents/abc");
		expect(slidesApiUrl("/xyz")).toBe("https://slides.googleapis.com/v1/presentations/xyz");
	});

	it("escapes single quotes for drive query", () => {
		expect(escapeDriveQuery("o'hara")).toBe("o\\'hara");
	});
});
