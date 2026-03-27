export function parseA1Range(range: string): {
	startRowIndex: number;
	endRowIndex: number;
	startColumnIndex: number;
	endColumnIndex: number;
} {
	const clean = range.includes("!") ? range.split("!")[1] : range;
	const [start, end = start] = clean.split(":");
	const parseCell = (cell: string) => {
		const colMatch = cell.match(/[A-Z]+/i)?.[0] ?? "A";
		const rowMatch = cell.match(/\d+/)?.[0] ?? "1";
		let col = 0;
		for (const char of colMatch.toUpperCase()) col = col * 26 + (char.charCodeAt(0) - 64);
		return { row: Number(rowMatch) - 1, col: col - 1 };
	};
	const startCell = parseCell(start);
	const endCell = parseCell(end);
	return {
		startRowIndex: startCell.row,
		endRowIndex: endCell.row + 1,
		startColumnIndex: startCell.col,
		endColumnIndex: endCell.col + 1,
	};
}
