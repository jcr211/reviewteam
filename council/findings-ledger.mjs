import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const KEYS = [
	"v",
	"ts",
	"runId",
	"branch",
	"baseSha",
	"headSha",
	"verdict",
	"critic",
	"file",
	"line",
	"severity",
	"category",
	"title",
	"fingerprint",
	"judgeDisposition",
	"grounding",
	"lineVerified",
	"endorsedBy",
	"refutedBy",
	"unsureBy",
];
const OPTIONAL_KEYS = new Set([
	"grounding",
	"lineVerified",
	"endorsedBy",
	"refutedBy",
	"unsureBy",
]);
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"is",
	"are",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"and",
	"or",
]);
const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
const CATEGORIES = new Set([
	"security",
	"correctness",
	"error-handling",
	"api-contract",
	"database",
	"performance",
	"other",
]);
const DISPOSITIONS = new Set(["confirmed", "dismissed", "unaddressed", null]);
const GROUNDING_VALUES = new Set(["grounded", "out_of_scope", "fabricated"]);

function normalizeTitle(title) {
	return String(title)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter((token) => token && !STOP_WORDS.has(token))
		.slice(0, 8)
		.join(" ");
}

function normalizedTokens(value) {
	return String(value)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter((token) => token && !STOP_WORDS.has(token));
}

export function computeFingerprint(file, category, title) {
	return `fp1:${createHash("sha256")
		.update(`${file}|${category}|${normalizeTitle(title)}`, "utf8")
		.digest("hex")
		.slice(0, 16)}`;
}

function normalizeSeverity(value) {
	const severity = String(value || "").toUpperCase();
	if (SEVERITIES.has(severity)) return severity;
	if (severity === "CRITICAL") return "P0";
	if (severity === "HIGH") return "P1";
	if (severity === "MEDIUM") return "P2";
	if (severity === "LOW") return "P3";
	return null;
}

function normalizeCategory(value) {
	const category = String(value || "")
		.toLowerCase()
		.trim()
		.replace(/[\s_]+/g, "-");
	if (category === "errorhandling") return "error-handling";
	if (category === "apicontract") return "api-contract";
	return CATEGORIES.has(category) ? category : "other";
}

function normalizeCriticIds(value) {
	if (!Array.isArray(value)) return undefined;
	return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
}

function normalizeFinding(finding) {
	if (!finding || typeof finding !== "object" || Array.isArray(finding)) return null;
	const file = String(finding.file || "")
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\\/g, "/")
		.replace(/^(?:a|b)\//, "");
	const rawTitle = String(finding.title ?? finding.description ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const title =
		/^(?:\d+\.\s*)?[-*]?\s*\[?(?:P[0-3]|critical|high|medium|low)\b/i.test(rawTitle) &&
		/\s+—\s+/.test(rawTitle)
			? rawTitle.split(/\s+—\s+/, 2)[1].trim()
			: rawTitle;
	const severity = normalizeSeverity(finding.severity);
	if (!file || !title || !severity) return null;
	const parsedLine = Number(finding.line ?? finding.lineStart);
	const result = {
		file,
		line: Number.isInteger(parsedLine) && parsedLine > 0 ? parsedLine : null,
		severity,
		category: normalizeCategory(finding.category),
		title,
	};
	if (finding.grounding && GROUNDING_VALUES.has(finding.grounding)) {
		result.grounding = finding.grounding;
	}
	if (typeof finding.lineVerified === "boolean") result.lineVerified = finding.lineVerified;
	for (const field of ["endorsedBy", "refutedBy", "unsureBy"]) {
		const critics = normalizeCriticIds(finding[field]);
		if (critics) result[field] = critics;
	}
	return result;
}

function parseJsonFindings(output) {
	const candidates = [...output.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) =>
		match[1].trim(),
	);
	for (const line of output.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (
			(trimmed.startsWith("{") && trimmed.endsWith("}")) ||
			(trimmed.startsWith("[") && trimmed.endsWith("]"))
		) {
			candidates.push(trimmed);
		}
	}
	const findings = [];
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			const values = Array.isArray(parsed) ? parsed : parsed?.findings;
			if (Array.isArray(values)) {
				for (const value of values) {
					const finding = normalizeFinding(value);
					if (finding) findings.push(finding);
				}
			}
		} catch {
			// Fall back to conservative prose parsing.
		}
	}
	return findings;
}

function parseProseFindings(output) {
	const findings = [];
	for (const line of output.split(/\r?\n/)) {
		const file = line.match(
			/[`"]?((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.(?:json|mjs|cjs|tsx|toml|yaml|scss|lock|ps1|css|sql|yml|md|js|ts|py|rs|sh))(?=[`"]|:|\s|\)|$)[`"]?(?::L?(\d+))?/i,
		);
		const severity = line.match(/\b(P0|P1|P2|P3|critical|high|medium|low)\b/i);
		if (!file || !severity || /^(?:#{1,6}\s*)?(?:ALLOW|BLOCK):/i.test(line.trim())) continue;
		const category = line.match(
			/\b(security|correctness|error[- ]?handling|api[- ]?contract|database|performance)\b/i,
		);
		const separator = line.match(/\s+—\s+/);
		const finding = normalizeFinding({
			file: file[1],
			line: file[2] ? Number(file[2]) : null,
			severity: severity[1],
			category: category?.[1],
			title: (separator?.index === undefined
				? line.replace(/^\s*(?:\d+\.\s*)?[-*]?\s*/, "").replace(/\*\*/g, "")
				: line.slice(separator.index + separator[0].length)
			).trim(),
		});
		if (finding) findings.push(finding);
	}
	return findings;
}

export function parseFindings(output) {
	const text = String(output || "");
	const structured = parseJsonFindings(text);
	return structured.length > 0 ? structured : parseProseFindings(text);
}

function parseJudgeFindings(output) {
	const text = String(output || "");
	const structured = parseJsonFindings(text);
	if (structured.length > 0) return structured;

	const ownSections = [];
	let current = [];
	let collecting = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^#{2,4}\s+/.test(line)) {
			if (collecting && current.length > 0) ownSections.push(current.join("\n"));
			collecting =
				/\b(?:deep[- ]dive discoveries|new findings?|gap[- ]scan results|additional findings?)\b/i.test(
					line,
				);
			current = [];
			continue;
		}
		if (collecting) current.push(line);
	}
	if (collecting && current.length > 0) ownSections.push(current.join("\n"));
	return ownSections.flatMap(parseProseFindings);
}

function dedupe(findings) {
	const seen = new Set();
	return findings.filter((finding) => {
		const key = `${finding.file}|${finding.line ?? ""}|${finding.category}|${normalizeTitle(finding.title)}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function aggregatedFindingsByCritic(findings) {
	const grouped = new Map();
	for (const finding of findings || []) {
		const providers = new Set([finding?.foundBy, ...(finding?.agreedBy || [])]);
		const normalized = normalizeFinding(finding);
		if (!normalized) continue;
		for (const provider of providers) {
			if (!provider) continue;
			const values = grouped.get(provider) || [];
			values.push(normalized);
			grouped.set(provider, values);
		}
	}
	return grouped;
}

function dispositionLineMatches(finding, line) {
	const claim = normalizedTokens(finding.title);
	const lineTokens = normalizedTokens(line);
	const overlap = claim.filter((token) => lineTokens.includes(token)).length;
	const normalizedFile = finding.file.toLowerCase();
	const basename = normalizedFile.split("/").at(-1);
	const lowerLine = line.toLowerCase();
	const namesFile =
		lowerLine.includes(normalizedFile) || (basename ? lowerLine.includes(basename) : false);
	const referencedLine = Number(line.match(/:L?(\d+)/i)?.[1]);
	const exactLocation = namesFile && finding.line !== null && referencedLine === finding.line;
	return (
		exactLocation ||
		(namesFile && overlap >= Math.min(2, claim.length)) ||
		overlap >= Math.min(3, claim.length)
	);
}

function dispositionFor(finding, judgeStructuredFindings, judgeOutput) {
	if (!judgeOutput.trim()) return null;
	for (const line of judgeOutput.split(/\r?\n/)) {
		const category = line.match(
			/\b(security|correctness|error[- ]?handling|api[- ]?contract|database|performance|other)\b/i,
		);
		if (
			/\bconfirmed\b/i.test(line) &&
			dispositionLineMatches(finding, line) &&
			category &&
			normalizeCategory(category[1]) === finding.category
		) {
			return "confirmed";
		}
		if (
			/\b(?:dismissed|false positive|reject(?:ed|s)?)\b/i.test(line) &&
			dispositionLineMatches(finding, line)
		)
			return "dismissed";
	}
	if (
		judgeStructuredFindings.some(
			(candidate) => candidate.file === finding.file && candidate.category === finding.category,
		)
	) {
		return "confirmed";
	}
	return "unaddressed";
}

export function buildLedgerRecords(runData) {
	const judgeOutput = String(runData.judgeOutput || "");
	const judgeStructuredFindings = dedupe(parseJsonFindings(judgeOutput));
	const judgeFindings = dedupe([
		...(runData.judgeFindings || []).map(normalizeFinding).filter(Boolean),
		...parseJudgeFindings(judgeOutput),
	]);
	const occurrences = [];
	const aggregated = aggregatedFindingsByCritic(runData.aggregatedFindings);
	for (const critic of runData.critics || []) {
		const attributed = dedupe([
			...(critic.findings || []).map(normalizeFinding).filter(Boolean),
			...(aggregated.get(critic.provider || critic.critic) || []),
		]);
		const findings = dedupe([...attributed, ...parseFindings(String(critic.output || ""))]);
		for (const finding of findings)
			occurrences.push({ critic: critic.provider || critic.critic, finding });
	}
	for (const finding of judgeFindings) occurrences.push({ critic: "judge", finding });
	const rawVerdict =
		typeof runData.verdict === "string" ? runData.verdict : runData.verdict?.decision;
	const verdict = String(rawVerdict).toUpperCase();
	if (verdict !== "ALLOW" && verdict !== "BLOCK") {
		throw new Error(`Unsupported council verdict: ${String(rawVerdict)}`);
	}
	return occurrences.map(({ critic, finding }) => ({
		v: 1,
		ts: String(runData.ts || runData.timestamp || ""),
		runId: String(runData.runId || ""),
		branch: String(runData.branch || "unknown"),
		baseSha: String(runData.baseSha || "unknown"),
		headSha: String(runData.headSha || "unknown"),
		verdict,
		critic: String(critic || "unknown"),
		file: finding.file,
		line: finding.line,
		severity: finding.severity,
		category: finding.category,
		title: finding.title,
		fingerprint: computeFingerprint(finding.file, finding.category, finding.title),
		judgeDisposition:
			critic === "judge"
				? "confirmed"
				: dispositionFor(finding, judgeStructuredFindings, judgeOutput),
		...(finding.grounding ? { grounding: finding.grounding } : {}),
		...(finding.lineVerified !== undefined ? { lineVerified: finding.lineVerified } : {}),
		...(finding.endorsedBy ? { endorsedBy: finding.endorsedBy } : {}),
		...(finding.refutedBy ? { refutedBy: finding.refutedBy } : {}),
		...(finding.unsureBy ? { unsureBy: finding.unsureBy } : {}),
	}));
}

export function validateLedgerRecord(record) {
	if (!record || typeof record !== "object" || Array.isArray(record)) return false;
	const keys = Object.keys(record);
	const requiredKeys = KEYS.filter((key) => !OPTIONAL_KEYS.has(key));
	if (
		!keys.every((key) => KEYS.includes(key)) ||
		!requiredKeys.every((key) => keys.includes(key))
	)
		return false;
	return (
		record.v === 1 &&
		["ts", "runId", "branch", "baseSha", "headSha", "critic", "file", "title"].every(
			(key) => typeof record[key] === "string" && record[key].length > 0,
		) &&
		!Number.isNaN(Date.parse(record.ts)) &&
		!record.title.includes("\n") &&
		(record.verdict === "ALLOW" || record.verdict === "BLOCK") &&
		(record.line === null || (Number.isInteger(record.line) && record.line > 0)) &&
		SEVERITIES.has(record.severity) &&
		CATEGORIES.has(record.category) &&
		/^fp1:[0-9a-f]{16}$/.test(record.fingerprint) &&
		DISPOSITIONS.has(record.judgeDisposition) &&
		(record.grounding === undefined || GROUNDING_VALUES.has(record.grounding)) &&
		(record.lineVerified === undefined || typeof record.lineVerified === "boolean") &&
		["endorsedBy", "refutedBy", "unsureBy"].every(
			(field) =>
				record[field] === undefined ||
				(Array.isArray(record[field]) &&
					record[field].every((critic) => typeof critic === "string" && critic.length > 0) &&
					new Set(record[field]).size === record[field].length),
		)
	);
}

export function appendRunToLedger(runData, ledgerPath) {
	if (existsSync(ledgerPath)) {
		for (const line of readFileSync(ledgerPath, "utf8").split(/\r?\n/)) {
			if (!line.trim()) continue;
			try {
				if (JSON.parse(line).runId === runData.runId) {
					process.stderr.write(
						`Ledger warning: runId ${runData.runId} already exists; skipping.\n`,
					);
					return { skipped: true, written: 0 };
				}
			} catch {
				// Continue scanning after malformed historical lines.
			}
		}
	}
	const records = buildLedgerRecords(runData);
	for (const record of records) {
		if (!validateLedgerRecord(record)) {
			throw new Error("Refusing to append an invalid ledger record");
		}
	}
	if (records.length > 0) {
		appendFileSync(
			ledgerPath,
			`${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
			"utf8",
		);
	}
	return { skipped: false, written: records.length };
}
