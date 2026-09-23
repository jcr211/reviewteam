import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const BUILT_IN_CRITICS = ["claude", "codex", "grok", "omp", "opencode"];

export const DEFAULT_CONFIG = {
	projectName: "Your Project",
	description: "The repository under review.",
	reviewConcerns: [],
	architectureRules: [],
	pathTierRules: [
		{
			pattern: "db/migrations/**",
			tier: "CRITICAL",
			reason: "Database migrations require the deepest review.",
		},
		{
			pattern: "src/auth/**",
			tier: "CRITICAL",
			reason: "Authentication code is security-sensitive.",
		},
		{
			pattern: "src/payments/**",
			tier: "CRITICAL",
			reason: "Payment code is financially sensitive.",
		},
		{
			pattern: ".github/workflows/**",
			tier: "CRITICAL",
			reason: "Automation workflows can change release permissions and supply-chain behavior.",
		},
		{ pattern: "**/*.sql", tier: "CRITICAL", reason: "SQL changes require deep review." },
		{ pattern: "**/*.md", tier: "DOCS", reason: "Markdown-only change." },
		{ pattern: "**/*.mdx", tier: "DOCS", reason: "MDX-only change." },
		{ pattern: "**/*.txt", tier: "DOCS", reason: "Text-only change." },
	],
	critics: ["codex", "claude"],
	criticSpecialties: {},
	criticCommands: {},
	judgeModel: "claude-opus-5-5",
	judgeCanExecute: true,
	timeoutSeconds: 300,
	judgeTimeoutSeconds: 360,
	maxDiffBytes: 200_000,
	logDir: ".reviewteam/review-logs",
	memoryDir: ".reviewteam/memory",
};

function requireString(value, field, fallback) {
	if (value === undefined) {
		if (fallback !== undefined) return fallback;
		throw new Error(`council.config.json: "${field}" must be a non-empty string.`);
	}
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`council.config.json: "${field}" must be a non-empty string.`);
	}
	return value.trim();
}

function requireBoolean(value, field, fallback) {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		throw new Error(`council.config.json: "${field}" must be a boolean.`);
	}
	return value;
}

function requirePositiveInteger(value, field, fallback) {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`council.config.json: "${field}" must be a positive integer.`);
	}
	return value;
}

function requireStringArray(value, field, fallback) {
	if (value === undefined) return [...fallback];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`council.config.json: "${field}" must be an array of non-empty strings.`);
	}
	return value.map((item) => item.trim());
}

function requireRecord(value, field, fallback) {
	if (value === undefined) return { ...fallback };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`council.config.json: "${field}" must be an object.`);
	}
	return { ...value };
}

function requirePathTierRules(value, fallback) {
	if (value === undefined) return fallback.map((rule) => ({ ...rule }));
	if (!Array.isArray(value)) {
		throw new Error('council.config.json: "pathTierRules" must be an array.');
	}
	return value.map((rule, index) => {
		if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
			throw new Error(`council.config.json: pathTierRules[${index}] must be an object.`);
		}
		const tier = requireString(rule.tier, `pathTierRules[${index}].tier`).toUpperCase();
		if (!["DOCS", "STANDARD", "CRITICAL"].includes(tier)) {
			throw new Error(
				`council.config.json: pathTierRules[${index}].tier must be DOCS, STANDARD, or CRITICAL.`,
			);
		}
		return {
			pattern: requireString(rule.pattern, `pathTierRules[${index}].pattern`),
			tier,
			reason: requireString(
				rule.reason,
				`pathTierRules[${index}].reason`,
				`Path matched ${rule.pattern}.`,
			),
		};
	});
}

export function normalizeCouncilConfig(raw = {}) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("council.config.json must contain a JSON object.");
	}
	const critics = requireStringArray(raw.critics, "critics", DEFAULT_CONFIG.critics);
	const criticCommands = requireRecord(
		raw.criticCommands,
		"criticCommands",
		DEFAULT_CONFIG.criticCommands,
	);
	const unknownCritics = critics.filter(
		(critic) => !BUILT_IN_CRITICS.includes(critic) && !Object.hasOwn(criticCommands, critic),
	);
	if (unknownCritics.length > 0) {
		throw new Error(
			`council.config.json: unknown critic id(s): ${unknownCritics.map((critic) => `"${critic}"`).join(", ")}. Valid built-in adapters: ${BUILT_IN_CRITICS.join(", ")}. Define custom CLIs in "criticCommands".`,
		);
	}

	return {
		projectName: requireString(raw.projectName, "projectName", DEFAULT_CONFIG.projectName),
		description: requireString(raw.description, "description", DEFAULT_CONFIG.description),
		reviewConcerns: requireStringArray(
			raw.reviewConcerns,
			"reviewConcerns",
			DEFAULT_CONFIG.reviewConcerns,
		),
		architectureRules: requireStringArray(
			raw.architectureRules,
			"architectureRules",
			DEFAULT_CONFIG.architectureRules,
		),
		pathTierRules: requirePathTierRules(raw.pathTierRules, DEFAULT_CONFIG.pathTierRules),
		critics,
		criticSpecialties: requireRecord(
			raw.criticSpecialties,
			"criticSpecialties",
			DEFAULT_CONFIG.criticSpecialties,
		),
		criticCommands,
		judgeModel: requireString(raw.judgeModel, "judgeModel", DEFAULT_CONFIG.judgeModel),
		judgeCanExecute: requireBoolean(
			raw.judgeCanExecute,
			"judgeCanExecute",
			DEFAULT_CONFIG.judgeCanExecute,
		),
		timeoutSeconds: requirePositiveInteger(
			raw.timeoutSeconds,
			"timeoutSeconds",
			DEFAULT_CONFIG.timeoutSeconds,
		),
		judgeTimeoutSeconds: requirePositiveInteger(
			raw.judgeTimeoutSeconds,
			"judgeTimeoutSeconds",
			DEFAULT_CONFIG.judgeTimeoutSeconds,
		),
		maxDiffBytes: requirePositiveInteger(
			raw.maxDiffBytes,
			"maxDiffBytes",
			DEFAULT_CONFIG.maxDiffBytes,
		),
		logDir: requireString(raw.logDir, "logDir", DEFAULT_CONFIG.logDir),
		memoryDir: requireString(raw.memoryDir, "memoryDir", DEFAULT_CONFIG.memoryDir),
	};
}

export function loadCouncilConfig({
	configPath = path.join(process.cwd(), "council.config.json"),
	readFile = readFileSync,
	fileExists = existsSync,
} = {}) {
	if (!fileExists(configPath)) return normalizeCouncilConfig();

	let raw;
	try {
		raw = JSON.parse(readFile(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Could not parse ${configPath}: ${error.message}`);
	}
	return normalizeCouncilConfig(raw);
}
