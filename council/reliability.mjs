import { readFileSync } from "node:fs";

const CONFIRMED_DISPOSITIONS = new Set(["confirmed", "upheld"]);
const REJECTED_DISPOSITIONS = new Set(["dismissed", "rejected"]);

function makeCell() {
	return {
		findings: 0,
		confirmed: 0,
		rejected: 0,
		fabricated: 0,
		confirmationRate: 0,
	};
}

function finalizeCell(cell) {
	return {
		...cell,
		confirmationRate: cell.findings > 0 ? cell.confirmed / cell.findings : 0,
	};
}

function isReliabilityRecord(record) {
	return (
		record &&
		typeof record === "object" &&
		!Array.isArray(record) &&
		typeof record.runId === "string" &&
		record.runId.length > 0 &&
		typeof record.critic === "string" &&
		record.critic.length > 0 &&
		record.critic !== "judge" &&
		typeof record.category === "string" &&
		record.category.length > 0
	);
}

/**
 * Summarize ledger-shaped finding records by critic and category.
 * @param {Array<object>} records
 * @returns {Record<string, Record<string, ReturnType<typeof makeCell>>>}
 */
export function summarizeCriticReliability(records) {
	const critics = new Map();
	for (const record of records) {
		if (!isReliabilityRecord(record)) continue;
		let categories = critics.get(record.critic);
		if (!categories) {
			categories = new Map();
			critics.set(record.critic, categories);
		}
		for (const category of new Set(["all", record.category])) {
			const cell = categories.get(category) || makeCell();
			cell.findings++;
			if (CONFIRMED_DISPOSITIONS.has(record.judgeDisposition)) cell.confirmed++;
			if (REJECTED_DISPOSITIONS.has(record.judgeDisposition)) cell.rejected++;
			if (record.grounding === "fabricated") cell.fabricated++;
			categories.set(category, cell);
		}
	}

	return Object.fromEntries(
		[...critics.entries()].map(([critic, categories]) => [
			critic,
			Object.fromEntries(
				[...categories.entries()].map(([category, cell]) => [
					category,
					finalizeCell(cell),
				]),
			),
		]),
	);
}

/**
 * Read the append-only ledger and summarize the most recent runs containing findings.
 * Malformed lines are ignored so a damaged historical entry cannot break a review.
 * @param {string} ledgerPath
 * @param {{lastRuns?: number}} options
 * @returns {Record<string, Record<string, ReturnType<typeof makeCell>>>}
 */
export function computeCriticReliability(ledgerPath, { lastRuns = 30 } = {}) {
	let lines;
	try {
		lines = readFileSync(ledgerPath, "utf8").split(/\r?\n/);
	} catch {
		return {};
	}

	const records = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const record = JSON.parse(line);
			if (isReliabilityRecord(record)) records.push(record);
		} catch {
			// Fail open: retain other valid append-only records.
		}
	}
	if (records.length === 0) return {};

	const runLimit = Math.max(0, Math.floor(Number(lastRuns) || 0));
	if (runLimit === 0) return {};
	const recentRunIds = new Set();
	for (
		let index = records.length - 1;
		index >= 0 && recentRunIds.size < runLimit;
		index--
	) {
		recentRunIds.add(records[index].runId);
	}
	return summarizeCriticReliability(
		records.filter((record) => recentRunIds.has(record.runId)),
	);
}

/**
 * Merge reliability summaries and recompute their rates.
 * @param {...Record<string, Record<string, ReturnType<typeof makeCell>>>} summaries
 * @returns {Record<string, Record<string, ReturnType<typeof makeCell>>>}
 */
export function mergeCriticReliability(...summaries) {
	const merged = new Map();
	for (const summary of summaries) {
		for (const [critic, categories] of Object.entries(summary || {})) {
			let mergedCategories = merged.get(critic);
			if (!mergedCategories) {
				mergedCategories = new Map();
				merged.set(critic, mergedCategories);
			}
			for (const [category, source] of Object.entries(categories || {})) {
				const cell = mergedCategories.get(category) || makeCell();
				cell.findings += Number(source.findings) || 0;
				cell.confirmed += Number(source.confirmed) || 0;
				cell.rejected += Number(source.rejected) || 0;
				cell.fabricated += Number(source.fabricated) || 0;
				mergedCategories.set(category, cell);
			}
		}
	}
	return Object.fromEntries(
		[...merged.entries()].map(([critic, categories]) => [
			critic,
			Object.fromEntries(
				[...categories.entries()].map(([category, cell]) => [
					category,
					finalizeCell(cell),
				]),
			),
		]),
	);
}

/**
 * Return critic-level quarantine candidates from the all-category rollup.
 * @param {Record<string, Record<string, ReturnType<typeof makeCell>>>} reliability
 * @param {{minFindings?: number, threshold?: number}} options
 * @returns {Array<{critic: string, findings: number, fabricated: number}>}
 */
export function findQuarantinedCritics(
	reliability,
	{ minFindings = 5, threshold = 0.3 } = {},
) {
	return Object.entries(reliability || {})
		.flatMap(([critic, categories]) => {
			const cell = categories?.all;
			if (
				!cell ||
				cell.findings < minFindings ||
				cell.fabricated / cell.findings <= threshold
			) {
				return [];
			}
			return [{ critic, findings: cell.findings, fabricated: cell.fabricated }];
		})
		.sort((left, right) => left.critic.localeCompare(right.critic));
}

/**
 * Whether at least one critic/category cell has enough observations to show a rate.
 * @param {Record<string, Record<string, ReturnType<typeof makeCell>>>} reliability
 * @param {number} minSamples
 * @returns {boolean}
 */
export function hasSufficientReliabilityData(reliability, minSamples = 5) {
	return Object.values(reliability || {}).some((categories) =>
		Object.values(categories || {}).some((cell) => cell.findings >= minSamples),
	);
}

/**
 * Render one row per critic and one column per observed category.
 * @param {Record<string, Record<string, ReturnType<typeof makeCell>>>} reliability
 * @param {{minSamples?: number}} options
 * @returns {string}
 */
export function formatReliabilityTable(reliability, { minSamples = 5 } = {}) {
	const criticIds = Object.keys(reliability || {}).sort();
	if (criticIds.length === 0) return "";
	const categories = [
		"all",
		...new Set(
			criticIds.flatMap((critic) =>
				Object.keys(reliability[critic] || {}).filter(
					(category) => category !== "all",
				),
			),
		),
	].sort((left, right) => {
		if (left === "all") return -1;
		if (right === "all") return 1;
		return left.localeCompare(right);
	});
	const rows = [
		["critic", ...categories].join(" | "),
		["---", ...categories.map(() => "---")].join(" | "),
	];
	for (const critic of criticIds) {
		const cells = categories.map((category) => {
			const cell = reliability[critic]?.[category];
			if (!cell || cell.findings < minSamples) return "insufficient data";
			return `${Math.round(cell.confirmationRate * 100)}% (${cell.confirmed}/${cell.findings})`;
		});
		rows.push([critic, ...cells].join(" | "));
	}
	return rows.join("\n");
}
