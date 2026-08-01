export const TIER_DOCS = "DOCS";
export const TIER_STANDARD = "STANDARD";
export const TIER_CRITICAL = "CRITICAL";

const TIER_RANK = {
	[TIER_DOCS]: 0,
	[TIER_STANDARD]: 1,
	[TIER_CRITICAL]: 2,
};

const CRITICAL_DIFF_PATTERNS = [
	{ pattern: /\bSECURITY\s+DEFINER\b/i, label: "SECURITY DEFINER" },
	{ pattern: /\bprivate[_-]?key\b/i, label: "private key reference" },
	{ pattern: /\bsign\s*\(/i, label: "sign(...) call" },
];

function normalizePath(file) {
	return String(file)
		.replaceAll("\\", "/")
		.replace(/^\.\/+/, "")
		.toLowerCase();
}

function globToRegExp(glob) {
	let source = "^";
	const normalized = normalizePath(glob);
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		if (char === "*" && normalized[index + 1] === "*") {
			if (normalized[index + 2] === "/") {
				source += "(?:.*/)?";
				index += 2;
			} else {
				source += ".*";
				index += 1;
			}
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}
	return new RegExp(`${source}$`, "i");
}

function totalChangedLines(diffStat) {
	if (typeof diffStat === "number") {
		return Number.isFinite(diffStat) ? Math.max(0, Math.trunc(diffStat)) : 0;
	}

	if (typeof diffStat === "string") {
		const trimmed = diffStat.trim();
		if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

		const numstatTotal = trimmed.split(/\r?\n/).reduce((total, line) => {
			const match = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
			if (!match) return total;
			const additions = match[1] === "-" ? 0 : Number.parseInt(match[1], 10);
			const deletions = match[2] === "-" ? 0 : Number.parseInt(match[2], 10);
			return total + additions + deletions;
		}, 0);
		if (numstatTotal > 0) return numstatTotal;

		const insertions = trimmed.match(/([\d,]+)\s+insertions?\(\+\)/i);
		const deletions = trimmed.match(/([\d,]+)\s+deletions?\(-\)/i);
		return (
			Number.parseInt((insertions?.[1] ?? "0").replaceAll(",", ""), 10) +
			Number.parseInt((deletions?.[1] ?? "0").replaceAll(",", ""), 10)
		);
	}

	if (diffStat && typeof diffStat === "object") {
		const explicitTotal = Number(diffStat.total);
		if (Number.isFinite(explicitTotal)) return Math.max(0, Math.trunc(explicitTotal));
		const additions = Number(diffStat.insertions ?? diffStat.additions ?? diffStat.added ?? 0);
		const deletions = Number(diffStat.deletions ?? diffStat.deleted ?? diffStat.removed ?? 0);
		return (
			(Number.isFinite(additions) ? Math.max(0, Math.trunc(additions)) : 0) +
			(Number.isFinite(deletions) ? Math.max(0, Math.trunc(deletions)) : 0)
		);
	}

	return 0;
}

function hasChangedCheckConstraint(diffText) {
	return String(diffText)
		.split(/\r?\n/)
		.some(
			(line) =>
				/^[+-](?![+-])/.test(line) &&
				(/\bCHECK\s*\(/i.test(line) || /\b(?:ADD|DROP)\s+CONSTRAINT\b.*\bCHECK\b/i.test(line)),
		);
}

function routePaths(files, pathTierRules) {
	if (files.length === 0) {
		return {
			tier: TIER_STANDARD,
			reasons: ["No changed files were supplied, so review depth defaults to standard."],
		};
	}

	const matchesByFile = files.map((file) => {
		const matches = pathTierRules.filter((rule) => globToRegExp(rule.pattern).test(file));
		return { file, matches };
	});
	const reasons = [];
	let tier = TIER_DOCS;

	for (const { file, matches } of matchesByFile) {
		if (matches.length === 0) {
			tier = TIER_RANK[tier] < TIER_RANK[TIER_STANDARD] ? TIER_STANDARD : tier;
			continue;
		}
		const fileTier = matches.reduce(
			(highest, rule) => (TIER_RANK[rule.tier] > TIER_RANK[highest] ? rule.tier : highest),
			TIER_DOCS,
		);
		if (TIER_RANK[fileTier] > TIER_RANK[tier]) tier = fileTier;
		for (const rule of matches) {
			reasons.push(`"${file}" matched "${rule.pattern}": ${rule.reason}`);
		}
	}

	if (reasons.length === 0) {
		reasons.push("The changed paths match no configured routing rule.");
	}
	return { tier, reasons };
}

/**
 * Route a review using configured path patterns plus generic high-risk diff signals.
 *
 * @param {number|string|Record<string, number>} diffStat
 * @param {string[]} changedFiles
 * @param {string} diffText
 * @param {Array<{pattern: string, tier: "DOCS"|"STANDARD"|"CRITICAL", reason: string}>} pathTierRules
 */
export function routeTier(diffStat, changedFiles, diffText, pathTierRules = []) {
	const files = Array.isArray(changedFiles) ? changedFiles.map(normalizePath) : [];
	const routed = routePaths(files, Array.isArray(pathTierRules) ? pathTierRules : []);
	const reasons = [...routed.reasons];
	let tier = routed.tier;
	const text = String(diffText ?? "");

	for (const { pattern, label } of CRITICAL_DIFF_PATTERNS) {
		if (pattern.test(text)) {
			tier = TIER_CRITICAL;
			reasons.push(`Diff text contains critical token: ${label}.`);
		}
	}
	if (hasChangedCheckConstraint(text)) {
		tier = TIER_CRITICAL;
		reasons.push("Diff changes a CHECK constraint.");
	}

	const changedLineCount = totalChangedLines(diffStat);
	if (changedLineCount > 1500) {
		tier = TIER_CRITICAL;
		reasons.push(
			`Diff changes ${changedLineCount} lines, exceeding the 1500-line critical threshold.`,
		);
	}

	return { tier, reasons };
}

export function applyTierOverride(routed, requestedTier) {
	if (
		requestedTier === null ||
		requestedTier === undefined ||
		String(requestedTier).trim() === ""
	) {
		return { tier: routed.tier, reasons: [...routed.reasons], warning: null };
	}

	const override = String(requestedTier).trim().toUpperCase();
	if (!(override in TIER_RANK)) {
		throw new Error(
			`Invalid council tier "${requestedTier}". Expected docs, standard, or critical.`,
		);
	}

	if (TIER_RANK[override] < TIER_RANK[routed.tier]) {
		const warning = `Requested ${override} tier override ignored because computed ${routed.tier} is a review-depth floor.`;
		return {
			tier: routed.tier,
			reasons: [...routed.reasons, warning],
			warning,
		};
	}

	if (TIER_RANK[override] === TIER_RANK[routed.tier]) {
		return { tier: routed.tier, reasons: [...routed.reasons], warning: null };
	}

	return {
		tier: override,
		reasons: [
			...routed.reasons,
			`Tier override raised review depth from ${routed.tier} to ${override}.`,
		],
		warning: null,
	};
}

export { totalChangedLines };
