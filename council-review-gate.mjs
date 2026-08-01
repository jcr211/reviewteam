// Pre-PR Council Review Gate — Two-Phase Critic-Guided Deep Review
// Phase 1: A configurable set of CLI-driven critics reviews the diff in parallel.
// Phase 1.5: At CRITICAL tier, critics endorse or refute surviving peer findings.
// Phase 2: A judge verifies findings, deep-dives flagged areas, and gap-scans.
// The judge verdict is final: ALLOW or BLOCK.
//
// Usage:
//   node council-review-gate.mjs [--base <branch>] [--tier <tier>] [--debate|--no-debate] [--no-block] [--verbose]
//   node council-review-gate.mjs --stats [--last <N>]   # health dashboard over recent runs
//
// Exit codes:
//   0 = ALLOW (or --no-block mode)
//   1 = BLOCK (blocking findings detected)
//   2 = ERROR (council failed to run)

import { execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCouncilConfig } from "./council/config.mjs";
import { appendRunToLedger } from "./council/findings-ledger.mjs";
import {
	computeCriticReliability,
	findQuarantinedCritics,
	formatReliabilityTable,
	hasSufficientReliabilityData,
	mergeCriticReliability,
	summarizeCriticReliability,
} from "./council/reliability.mjs";
import { acquireRunLock, releaseRunLock } from "./council/run-lock.mjs";
import { applyTierOverride, routeTier, TIER_CRITICAL, TIER_DOCS } from "./council/tier-router.mjs";

const COUNCIL_CONFIG = loadCouncilConfig();
const FULL_COUNCIL_CRITICS = [...COUNCIL_CONFIG.critics];
const PHASE1_CRITICS = process.env.COUNCIL_CRITICS
	? process.env.COUNCIL_CRITICS.split(",")
			.map((c) => c.trim())
			.filter(Boolean)
	: FULL_COUNCIL_CRITICS;
const JUDGE_MODEL = COUNCIL_CONFIG.judgeModel;
const GROK_COUNCIL_MODEL = process.env.GROK_COUNCIL_MODEL || "grok-4.5";

function stripTrailingV1(url) {
	return url
		.trim()
		.replace(/\/v1\/?$/i, "")
		.replace(/\/+$/, "");
}

function resolveLocalModelConfig({
	env = process.env,
} = {}) {
	const envUrl = env.LOCAL_MODEL_URL || env.LM_STUDIO_URL;
	if (!envUrl) return null;
	return { url: stripTrailingV1(envUrl), key: env.LOCAL_MODEL_API_KEY };
}

function buildLocalModelHeaders(key, includeJson = false) {
	const headers = {};
	if (includeJson) headers["Content-Type"] = "application/json";
	if (key) headers.Authorization = `Bearer ${key}`;
	return headers;
}

/**
 * Optional preflight for an explicitly configured OpenAI-compatible endpoint. omp resolves its
 * own provider and model configuration, so an unset endpoint is a silent skip.
 */
async function preflightLocalModel({
	env = process.env,
	fetchImpl = fetch,
	writeError = (message) => process.stderr.write(message),
	exitProcess = (code) => process.exit(code),
} = {}) {
	const config = resolveLocalModelConfig({ env });
	if (!config) return false;
	const modelId = env.LOCAL_MODEL || env.LM_STUDIO_MODEL || env.OMP_COUNCIL_MODEL;

	let response;
	try {
		response = await fetchImpl(`${config.url}/v1/models`, {
			headers: buildLocalModelHeaders(config.key),
			signal: AbortSignal.timeout(10_000),
		});
	} catch (err) {
		writeError(
			`Local model preflight FAILED: cannot reach ${config.url}/v1/models — ${err.message}\n`,
		);
		writeError("  Verify the endpoint URL and LOCAL_MODEL_API_KEY, when required.\n");
		writeError("Exit: local_model_not_available\n");
		exitProcess(2);
		return false;
	}
	if (!response.ok) {
		writeError(
			`Local model preflight FAILED: ${config.url}/v1/models returned ${response.status}\n`,
		);
		writeError("  Verify the endpoint URL and LOCAL_MODEL_API_KEY, when required.\n");
		writeError("Exit: local_model_not_available\n");
		exitProcess(2);
		return false;
	}
	let data;
	try {
		data = await response.json();
	} catch {
		writeError("Local model preflight FAILED: /v1/models response is not valid JSON\n");
		writeError("Exit: local_model_not_available\n");
		exitProcess(2);
		return false;
	}
	const models = Array.isArray(data?.data) ? data.data : [];
	const found = !modelId || models.some((model) => model?.id === modelId);
	if (!found) {
		const available = models.map((m) => m.id).join(", ") || "(none)";
		writeError(
			`Local model preflight FAILED: configured model "${modelId}" is not available.\n`,
		);
		writeError(`  Available models: ${available}\n`);
		writeError("Exit: local_model_not_available\n");
		exitProcess(2);
		return false;
	}
	const modelSuffix = modelId ? `; "${modelId}" is available` : "";
	writeError(`Local model preflight OK: ${config.url}${modelSuffix}.\n`);
	return true;
}

const TIMEOUT_SECONDS = COUNCIL_CONFIG.timeoutSeconds;
const JUDGE_TIMEOUT_SECONDS = COUNCIL_CONFIG.judgeTimeoutSeconds;
const DEBATE_TIMEOUT_MS = Math.max(120_000, Math.floor((TIMEOUT_SECONDS * 1000) / 2));
const MAX_DIFF_BYTES = COUNCIL_CONFIG.maxDiffBytes;
const OPUS_CONTEXT_CHAR_LIMIT = 80_000;
const OPUS_DIFF_CONTEXT_LINES = 20;
const MAX_CRITIC_OUTPUT_CHARS = 8000;
const OPENCODE_RETRY_DELAY_MS = 5_000;
const OPENCODE_PREFLIGHT_TIMEOUT_MS = 45_000;
const CRITIC_NO_VERDICT_CHAR_LIMIT = 500;
const CRITIC_NO_VERDICT_RETRY_DELAY_MS = 5_000;
const JUDGE_TRANSIENT_RETRY_DELAY_MS = 60_000;
// Distinct non-zero exit code for a degraded run: the required Phase-2 judge could not
// authenticate, so the verdict is a critic-only fallback. The coordinator must re-authenticate
// and re-run the council rather than trust this verdict — even a fallback ALLOW.
const EXIT_JUDGE_AUTH_FAILED = 3;

const NPM_CMD_EXT = process.platform === "win32" ? ".cmd" : "";
// Resolve critic binaries portably. Environment overrides win; otherwise prefer a standard
// per-user installation on Windows and fall back to the bare command name.
const NPM_GLOBAL_CODEX = path.join(process.env.APPDATA || "", "npm", `codex${NPM_CMD_EXT}`);
const CODEX_BIN =
	process.env.CODEX_BIN ||
	(NPM_CMD_EXT && existsSync(NPM_GLOBAL_CODEX) ? NPM_GLOBAL_CODEX : `codex${NPM_CMD_EXT}`);
function resolveWindowsNpmPs1(commandName) {
	const appDataCandidate = process.env.APPDATA
		? path.join(process.env.APPDATA, "npm", `${commandName}.ps1`)
		: null;
	if (appDataCandidate && existsSync(appDataCandidate)) return appDataCandidate;

	try {
		const npmPrefix = execFileSync("npm", ["prefix", "-g"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const npmCandidate = npmPrefix ? path.join(npmPrefix, `${commandName}.ps1`) : null;
		if (npmCandidate && existsSync(npmCandidate)) return npmCandidate;
	} catch {
		// Fall through to the standard per-user npm prefix.
	}

	const fallbackCandidate = path.join(homedir(), "AppData", "Roaming", "npm", `${commandName}.ps1`);
	return fallbackCandidate;
}
const OPENCODE_PS1 =
	process.env.OPENCODE_PS1 ||
	(process.platform === "win32" ? resolveWindowsNpmPs1("opencode") : "opencode");
// Defaults to a non-OpenAI model on purpose: the codex adapter already covers that
// family, and critics from different families miss different defects.
const OPENCODE_COUNCIL_MODEL =
	process.env.OPENCODE_COUNCIL_MODEL || "opencode-go/deepseek-v4-pro";
const STD_GROK_BIN = path.join(
	homedir(),
	".grok",
	"bin",
	process.platform === "win32" ? "grok.exe" : "grok",
);
const GROK_BIN = process.env.GROK_BIN || (existsSync(STD_GROK_BIN) ? STD_GROK_BIN : "grok");
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

function resolveBuiltInBinary(provider) {
	const normalized = provider.toLowerCase().replace(/-/g, "");
	if (normalized === "codex") return CODEX_BIN;
	if (normalized === "claude" || normalized === "claudecode") return CLAUDE_BIN;
	if (normalized === "grok" || normalized === "grokcli") return GROK_BIN;
	if (normalized === "opencode") return OPENCODE_PS1;
	if (normalized === "omp") return process.env.OMP_BIN || "omp";
	return null;
}
/**
 * Decide whether the `claude` CLI must be launched through a shell. Node's
 * shell-less spawn uses CreateProcess on Windows, which auto-resolves a native `claude.exe`
 * on PATH but cannot launch a `claude.cmd`/`.bat` npm shim. When a native executable is
 * available, the judge spawns it directly. When only an npm shim is available, the
 * shell-less spawn would fail — detect that shape and fall back to a shell. Prefer the native
 * executable; only require a shell when no `.exe` is resolvable but a shim is.
 * @returns {boolean}
 */
function claudeNeedsShell() {
	if (process.platform !== "win32") return false;
	const override = process.env.CLAUDE_BIN;
	if (override) return !/\.exe$/i.test(override);
	const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
	const onPath = (name) => pathDirs.some((dir) => existsSync(path.join(dir, name)));
	if (onPath("claude.exe")) return false;
	if (onPath("claude.cmd") || onPath("claude.bat")) return true;
	return false;
}
const CLAUDE_NEEDS_SHELL = claudeNeedsShell();
const LOG_DIR = COUNCIL_CONFIG.logDir;
const CONSULT_LOG_DIR = `${COUNCIL_CONFIG.logDir}-consult`;
const RELIABILITY_LAST_RUNS = 30;
const RELIABILITY_MIN_SAMPLES = 5;
const QUARANTINE_LAST_RUNS = 10;
const CONSULT_PLAN_CHAR_LIMIT = 120_000;
const CONSULT_CRITICS = process.env.CONSULT_CRITICS
	? process.env.CONSULT_CRITICS.split(",")
			.map((c) => c.trim())
			.filter(Boolean)
	: PHASE1_CRITICS;

// Nested Claude invocations must not inherit unrelated hooks from the parent session.
// A minimal settings file keeps critic and judge subprocesses isolated and reproducible.
const CLEAN_SETTINGS_PATH = path.join(tmpdir(), "council-clean-settings.json");
try {
	writeFileSync(CLEAN_SETTINGS_PATH, JSON.stringify({ disableAllHooks: true }), "utf8");
} catch {
	// Non-fatal: if we can't write it, the args below still reference the path and
	// claude will surface a clear settings-not-found error rather than failing silently.
}

// Memory directory is relative to the repository root.
const MEMORY_DIR_RELATIVE = COUNCIL_CONFIG.memoryDir;

// Resolve the repository root shared by linked Git worktrees so review artifacts
// from the same repository stay together.
function getMainWorktreeRoot() {
	try {
		const gitCommonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir");
		return path.resolve(gitCommonDir, "..");
	} catch {
		return process.cwd();
	}
}

function getMemoryDir() {
	return path.join(getMainWorktreeRoot(), MEMORY_DIR_RELATIVE);
}

/**
 * Slugify a string for use as a filename component.
 * @param {string} text
 * @returns {string}
 */
function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

/**
 * Extract file paths from a unified diff string.
 * Matches "--- a/path" and "+++ b/path" header lines.
 * @param {string} diff
 * @returns {string[]}
 */
function extractDiffFiles(diff) {
	const files = new Set();
	for (const line of diff.split("\n")) {
		const m = line.match(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/);
		if (m && m[1] !== "/dev/null") files.add(m[1]);
	}
	return [...files];
}

/**
 * Parse YAML-style frontmatter from a memory .md file.
 * Returns null if parsing fails.
 * @param {string} content
 * @returns {{ file: string, pattern: string, critic: string, dismissedAt: string, reason: string } | null}
 */
function parseMemoryFile(content) {
	try {
		const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!fmMatch) return null;
		const fm = {};
		for (const line of fmMatch[1].split("\n")) {
			const kv = line.match(/^(\w+):\s*(.+)$/);
			if (kv) fm[kv[1]] = kv[2].trim();
		}
		const reasonMatch = fmMatch[2].match(/^Reason:\s*(.+)/m);
		fm.reason = reasonMatch ? reasonMatch[1].trim() : "";
		if (!fm.file || !fm.pattern) return null;
		return fm;
	} catch {
		return null;
	}
}

/**
 * Read relevant false positives for the files in the current diff.
 * Caps injected text at 1000 characters.
 * @param {string} diff
 * @returns {string}
 */
function loadRelevantMemory(diff) {
	const memDir = getMemoryDir();
	const fpDir = path.join(memDir, "false-positives");
	if (!existsSync(fpDir)) return "";

	let files;
	try {
		files = readdirSync(fpDir).filter((f) => f.endsWith(".md"));
	} catch {
		return "";
	}
	if (files.length === 0) return "";

	const diffFiles = extractDiffFiles(diff);
	if (diffFiles.length === 0) return "";

	// TTL: ignore entries older than 60 days.
	const ttlMs = 60 * 24 * 60 * 60 * 1000;
	const cutoff = new Date(Date.now() - ttlMs).toISOString().slice(0, 10);

	// Parse all memory files and filter to those relevant to the current diff.
	const relevant = [];
	for (const fname of files) {
		try {
			const content = readFileSync(path.join(fpDir, fname), "utf8");
			const entry = parseMemoryFile(content);
			if (!entry) continue;
			// Skip expired entries.
			if (entry.dismissedAt && entry.dismissedAt < cutoff) continue;
			// Match if any diff file starts with (or equals) the memory entry's file path.
			const matches = diffFiles.some(
				(df) =>
					df === entry.file ||
					df.startsWith(`${entry.file}/`) ||
					entry.file.startsWith(`${df}/`),
			);
			if (matches) relevant.push({ entry, fname });
		} catch {
			// Skip unreadable files.
		}
	}

	if (relevant.length === 0) return "";

	// Sort by dismissedAt descending (most recent first), take top 10.
	relevant.sort((a, b) => (b.entry.dismissedAt || "").localeCompare(a.entry.dismissedAt || ""));
	const top = relevant.slice(0, 10);

	const lines = ["", "KNOWN FALSE POSITIVES for files in this diff (do not re-flag these):"];
	let charCount = lines.join("\n").length;
	const MAX_CHARS = 1000;

	for (const { entry } of top) {
		const line = `- ${entry.file}: "${entry.pattern}" — ${entry.reason}`;
		if (charCount + line.length + 1 > MAX_CHARS) break;
		lines.push(line);
		charCount += line.length + 1;
	}

	if (lines.length <= 2) return "";
	return lines.join("\n");
}

/**
 * Write learned patterns to memory after Phase 2 judge verdict.
 * Parses DISMISSED findings from judge output and updates stats.json.
 * @param {string} judgeOutput
 * @param {Array<{provider: string, ok: boolean, output: string}>} criticResults
 */
function writeCouncilMemory(judgeOutput, criticResults) {
	if (!judgeOutput) return;

	const memDir = getMemoryDir();
	const fpDir = path.join(memDir, "false-positives");
	try {
		mkdirSync(fpDir, { recursive: true });
	} catch {
		return;
	}

	const today = new Date().toISOString().slice(0, 10);

	// Parse dismissed findings from judge output.
	// Pattern: lines containing "DISMISSED" followed by a reason.
	// Expected format from judge: "DISMISSED: <reason>" near a finding with file/pattern info.
	const lines = judgeOutput.split("\n");
	const dismissed = [];

	// Build a map of critic -> findings for attribution.
	/** @type {Map<string, Array<{file: string|null, description: string}>>} */
	const criticFindings = new Map();
	for (const r of criticResults) {
		if (!r.ok) continue;
		criticFindings.set(r.provider, extractStructuredFindings(r.output));
	}

	// Walk judge output looking for DISMISSED lines preceded by finding lines.
	let lastFinding = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// Capture context of the finding being discussed.
		const fileMatch = line.match(/[`"]?([a-zA-Z0-9_\-/.]+\.[a-zA-Z]{1,4})[`"]?/);
		if (fileMatch && fileMatch[1] !== "file.ext") {
			lastFinding = { file: fileMatch[1], description: line };
		}

		if (/\bDISMISSED\b/i.test(line) && lastFinding) {
			// Extract reason — text after "DISMISSED" or "DISMISSED:"
			const reasonMatch = line.match(/DISMISSED[:\s]+(.+)/i);
			const reason = reasonMatch ? reasonMatch[1].trim() : "False positive per judge review";

			// Find which critic flagged this file.
			let critic = "unknown";
			for (const [provider, findings] of criticFindings) {
				if (findings.some((f) => f.file === lastFinding.file)) {
					critic = provider;
					break;
				}
			}

			// Extract a short pattern description from the finding.
			const pattern = lastFinding.description
				.replace(/^\[.*?\]\s*/, "")
				.replace(/`[^`]+`\s*/, "")
				.replace(/\(.*?\)\s*—\s*/, "")
				.trim()
				.slice(0, 80);

			dismissed.push({ file: lastFinding.file, pattern, reason, critic, dismissedAt: today });
			lastFinding = null;
		}
	}

	// Write one .md file per dismissed finding.
	for (const d of dismissed) {
		const slug = slugify(`${d.file}-${d.pattern}`);
		const timestamp = Date.now();
		const fname = `${slug}-${timestamp}.md`;
		const content = [
			"---",
			`file: ${d.file}`,
			`pattern: ${d.pattern}`,
			`critic: ${d.critic}`,
			`dismissedAt: ${d.dismissedAt}`,
			"---",
			`Reason: ${d.reason}`,
		].join("\n");
		try {
			writeFileSync(path.join(fpDir, fname), content, "utf8");
		} catch {
			// Best-effort.
		}
	}

	// Update stats.json.
	const statsPath = path.join(memDir, "stats.json");
	let stats = {};
	try {
		stats = JSON.parse(readFileSync(statsPath, "utf8"));
	} catch {
		// Start fresh.
	}

	// Count confirmed vs dismissed per critic from judge output.
	for (const r of criticResults) {
		if (!r.ok) continue;
		const p = r.provider;
		if (!stats[p]) stats[p] = { confirmed: 0, dismissed: 0, lastRun: today };
		stats[p].lastRun = today;
	}

	// Tally dismissed counts.
	for (const d of dismissed) {
		if (d.critic !== "unknown") {
			if (!stats[d.critic]) stats[d.critic] = { confirmed: 0, dismissed: 0, lastRun: today };
			stats[d.critic].dismissed += 1;
		}
	}

	// Tally confirmed: any finding that appears as CONFIRMED in judge output,
	// attributed to the critic that originally flagged it.
	const confirmedFiles = [];
	const confirmedLines = lines.filter((l) => /\bCONFIRMED\b/i.test(l));
	for (const line of confirmedLines) {
		const fileMatch = line.match(/[`"]?([a-zA-Z0-9_\-/.]+\.[a-zA-Z]{1,4})[`"]?/);
		if (!fileMatch) continue;
		confirmedFiles.push(fileMatch[1]);
		for (const [provider, findings] of criticFindings) {
			if (findings.some((f) => f.file === fileMatch[1])) {
				if (stats[provider]) stats[provider].confirmed += 1;
				break;
			}
		}
	}

	// Counter-evidence: delete dismissals that contradict confirmed findings.
	// If the judge CONFIRMED a finding for a file that has an existing dismissal,
	// that dismissal is now wrong — remove it.
	if (confirmedFiles.length > 0) {
		try {
			const existingFiles = readdirSync(fpDir).filter((f) => f.endsWith(".md"));
			for (const fname of existingFiles) {
				try {
					const content = readFileSync(path.join(fpDir, fname), "utf8");
					const entry = parseMemoryFile(content);
					if (entry && confirmedFiles.includes(entry.file)) {
						unlinkSync(path.join(fpDir, fname));
					}
				} catch {}
			}
		} catch {}
	}

	// Cap: keep max 200 entries, prune oldest when exceeded.
	try {
		const allFiles = readdirSync(fpDir).filter((f) => f.endsWith(".md"));
		if (allFiles.length > 200) {
			const withDates = allFiles.map((fname) => {
				try {
					const content = readFileSync(path.join(fpDir, fname), "utf8");
					const entry = parseMemoryFile(content);
					return { fname, date: entry?.dismissedAt || "0000" };
				} catch {
					return { fname, date: "0000" };
				}
			});
			withDates.sort((a, b) => a.date.localeCompare(b.date));
			const toDelete = withDates.slice(0, allFiles.length - 200);
			for (const { fname } of toDelete) {
				try {
					unlinkSync(path.join(fpDir, fname));
				} catch {}
			}
		}
	} catch {}

	try {
		mkdirSync(memDir, { recursive: true });
		writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");
	} catch {
		// Best-effort.
	}
}

// Built-in adapters have generic specialties. Projects can replace these prompts through
// criticSpecialties in council.config.json without changing source.
const SPECIALIZATIONS = {
	codex: {
		label: "Correctness and data integrity",
		emphasis: [
			"YOUR SPECIALTY: Correctness and data integrity. Focus on:",
			"- Transaction safety: are multi-step operations atomic? Can partial failures leave inconsistent state?",
			"- State machine correctness: do status transitions follow the documented lifecycle?",
			"- Idempotency: can retries cause duplicate side effects?",
			"- Migration integrity: ordering conflicts and missing compatibility paths",
			"- Workflow ordering: do steps happen in the right sequence?",
			"- Schema integrity: column names, parameter names, constraints, and caller permissions",
			"Deprioritize: styling, performance, and logging patterns.",
		],
	},
	grok: {
		label: "Generalist (holistic whole-diff review)",
		emphasis: [
			"YOUR ROLE: the council's GENERALIST. The other critics each own a NARROW lane (correctness/atomicity, security/database, error-handling/architecture, security-surface) and deliberately deprioritize everything else. You are NOT lane-constrained — do the holistic whole-diff read a senior engineer does last: surface the most important issues, ESPECIALLY anything that falls between the specialists' lanes or that a narrow lens would miss.",
			"Range freely: subtle logic bugs, cross-cutting design/architecture problems, money-safety / fail-closed gaps, missing edge cases, maintainability and readability traps, incorrect assumptions, test gaps, or risks that don't fit a single category.",
			"You have NO tools: do not attempt to read files or run commands. Everything you need is included in this prompt — if any content appears truncated, work only from what is shown.",
			"Prioritize real, high-signal findings over nitpicks. Lead with the single most important issue. If nothing is wrong, say so plainly.",
		],
		reviewOnly: ["Severity-tag each finding P0/P1/P2/P3. Start your output with ALLOW or BLOCK."],
	},
	omp: {
		label: "Error handling and architecture",
		emphasis: [
			"YOUR SPECIALTY: Error handling and architecture. Focus on:",
			"- Banned patterns: console.log/console.error in production code (use structured logging), never-casts, double type assertions",
			"- Error propagation: are errors swallowed silently? Do catch blocks rethrow or log appropriately?",
			"- Test quality: do test mocks use proper typing? Do mock fallbacks mask setup errors?",
			"- Defense-in-depth: runtime type guards on external results and null checks after persistence operations",
			"- Boundary consistency: do public contracts, implementations, and environment configuration agree?",
			"Deprioritize: formatting and naming unless they hide a correctness issue.",
		],
	},
	opencode: {
		label: "Security Surface Analysis",
		emphasis: [
			"YOUR SPECIALTY: Security surface analysis. Focus on:",
			"- Credential handling: secrets in code, env var exposure, token lifecycle",
			"- Transport security: TLS configuration, auth headers, API key handling",
			"- Input validation: injection vectors, unsanitized user input reaching DB or external APIs",
			"- Access control: endpoint auth middleware, permission checks",
		],
		reviewOnly: [
			"Maximum 5 findings. One line per finding: file, line, severity (P0/P1/P2/P3), category, description.",
			"No verbose explanations. No preamble. Start with ALLOW or BLOCK.",
		],
	},
};

function getConfiguredSpecialization(provider) {
	const configured = COUNCIL_CONFIG.criticSpecialties[provider];
	if (typeof configured === "string" && configured.trim()) {
		return { label: "Configured specialty", emphasis: [configured.trim()] };
	}
	if (!configured || typeof configured !== "object" || Array.isArray(configured)) return null;
	const prompt = typeof configured.prompt === "string" ? configured.prompt.trim() : "";
	if (!prompt) return null;
	return {
		label:
			typeof configured.label === "string" && configured.label.trim()
				? configured.label.trim()
				: "Configured specialty",
		emphasis: [prompt],
	};
}

function getSpecialization(provider) {
	let key = (provider || "").toLowerCase().replace(/-/g, "");
	if (key === "grokcli" || key === "grokcomposer" || key === "composer") key = "grok";
	return getConfiguredSpecialization(provider) || (key ? SPECIALIZATIONS[key] : null);
}

function getSpecializationBlock(provider, mode = "review") {
	const spec = getSpecialization(provider);
	if (!spec) return "";
	// Consult (advisory) mode keeps only the emphasis persona and drops review-only output-format
	// directives (verdict/severity/max-N lines) that contradict "Do NOT produce an approval verdict".
	const lines = mode === "consult" ? spec.emphasis : [...spec.emphasis, ...(spec.reviewOnly || [])];
	return `\n\n${lines.join("\n")}`;
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }).trim();
}

function gitSafe(...args) {
	try {
		return git(...args);
	} catch {
		return null;
	}
}

function parseArgs(args = process.argv.slice(2)) {
	const opts = {
		base: null,
		noBlock: false,
		verbose: false,
		stats: false,
		statsLimit: 20,
		consult: null,
		topic: null,
		tier: null,
		debate: args.includes("--no-debate") ? false : args.includes("--debate") ? true : null,
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--base" && args[i + 1]) opts.base = args[++i];
		else if (args[i] === "--no-block") opts.noBlock = true;
		else if (args[i] === "--verbose" || args[i] === "-v") opts.verbose = true;
		else if (args[i] === "--stats") opts.stats = true;
		else if (args[i] === "--last" && args[i + 1]) opts.statsLimit = parseInt(args[++i], 10) || 20;
		else if (args[i] === "--consult" && args[i + 1]) opts.consult = args[++i];
		else if (args[i] === "--topic" && args[i + 1]) opts.topic = args[++i];
		else if (args[i] === "--tier" && args[i + 1]) opts.tier = args[++i];
	}
	return opts;
}

function shouldRunDebate(tier, debateOverride, survivingCriticCount) {
	if (survivingCriticCount < 2 || debateOverride === false) return false;
	return debateOverride === true || tier === TIER_CRITICAL;
}

function detectBaseBranch() {
	for (const branch of ["main", "master", "develop"]) {
		if (gitSafe("rev-parse", "--verify", branch) !== null) return branch;
	}
	return "main";
}

function getFullDiff(base) {
	const mergeBase = gitSafe("merge-base", base, "HEAD") || base;
	const diff = git("diff", mergeBase, "HEAD");

	if (diff.length > MAX_DIFF_BYTES) {
		const statSummary = git("diff", "--stat", mergeBase, "HEAD");
		return (
			`[TRUNCATED: diff is ${diff.length} bytes, showing first ${MAX_DIFF_BYTES} bytes]\n\n` +
			`Full diff stat:\n${statSummary}\n\n` +
			diff.slice(0, MAX_DIFF_BYTES)
		);
	}
	return diff;
}

function getTierRoute(base, tierOverride) {
	const mergeBase = gitSafe("merge-base", base, "HEAD") || base;
	const fullDiff = git("diff", mergeBase, "HEAD");
	const diffStat = git("diff", "--numstat", mergeBase, "HEAD");
	const changedFiles = git("diff", "--name-only", mergeBase, "HEAD").split(/\r?\n/).filter(Boolean);
	return applyTierOverride(
		routeTier(diffStat, changedFiles, fullDiff, COUNCIL_CONFIG.pathTierRules),
		tierOverride,
	);
}

function resolveJudgeTools(tier, judgeCanExecute = true) {
	if (tier === TIER_DOCS) return ["Read"];
	if (tier === TIER_CRITICAL && judgeCanExecute) return ["Read", "Grep", "Glob", "Bash"];
	return ["Read", "Grep", "Glob"];
}

function resolveTierReviewDepth(tier, standardCritics = PHASE1_CRITICS) {
	const judgeCanExecute = COUNCIL_CONFIG.judgeCanExecute;
	const judgeTools = resolveJudgeTools(tier, judgeCanExecute);
	if (tier === TIER_DOCS) {
		return {
			critics: standardCritics.slice(0, 1),
			judgeEffort: "high",
			judgeTools,
			header: "TIER: DOCS — reduced bench",
		};
	}
	if (tier === TIER_CRITICAL) {
		return {
			critics: [...standardCritics],
			judgeEffort: "xhigh",
			judgeTools,
			judgeExecuted: judgeTools.includes("Bash"),
			header: "TIER: CRITICAL — full bench, xhigh judge",
		};
	}
	return {
		critics: [...standardCritics],
		judgeEffort: "high",
		judgeTools,
		header: "TIER: STANDARD — default bench",
	};
}

function getBranchInfo() {
	return {
		branch: gitSafe("branch", "--show-current") || "unknown",
		lastCommit: gitSafe("log", "-1", "--format=%h %s") || "?",
	};
}

function buildTaskPrompt(branchInfo, provider = null) {
	const projectContext = [
		`Project: ${COUNCIL_CONFIG.projectName}`,
		`Description: ${COUNCIL_CONFIG.description}`,
		...(COUNCIL_CONFIG.reviewConcerns.length > 0
			? [
					"",
					"Project-specific review concerns:",
					...COUNCIL_CONFIG.reviewConcerns.map((concern) => `- ${concern}`),
				]
			: []),
		...(COUNCIL_CONFIG.architectureRules.length > 0
			? [
					"",
					"Project-specific architecture rules:",
					...COUNCIL_CONFIG.architectureRules.map((rule) => `- ${rule}`),
				]
			: []),
	].join("\n");
	const basePrompt = [
		"You are a pre-PR code review gate.",
		projectContext,
		"",
		"Review the FULL git diff below for shipping blockers.",
		"This diff represents ALL changes on this branch — not a single turn, but the complete body of work.",
		"",
		`Branch: ${branchInfo.branch}`,
		`Last commit: ${branchInfo.lastCommit}`,
		"",
		"Focus on:",
		"- Security vulnerabilities (injection, authorization bypass, data exposure, secret leakage)",
		"- Correctness bugs (logic errors, off-by-one, null handling, race conditions)",
		"- Error handling gaps (unhandled throws, swallowed errors, missing validation)",
		"- API contract violations (wrong status codes, missing fields, type mismatches)",
		"- Database issues (unsafe queries, isolation failures, migration problems)",
		"",
		"RESPONSE FORMAT:",
		"Your response MUST begin with exactly one of:",
		"  ALLOW: <one-line reason>",
		"  BLOCK: <one-line reason>",
		"",
		"If BLOCK, follow with a numbered list of findings.",
		"If ALLOW, you may optionally list non-blocking observations.",
		"",
		"ALL findings (blocking or non-blocking) must use this format:",
		"  - [SEVERITY] `file.ext:L##` (CATEGORY) — description",
		"Include exact file paths and line numbers from the diff for every finding.",
		"Do not use placeholder names like file.ext — use the real file path from the diff.",
		"",
		"Severity levels:",
		"  P0 = must fix before merge (blocking)",
		"  P1 = should fix before merge (blocking)",
		"  P2 = should fix eventually (non-blocking)",
		"  P3 = nit/minor (non-blocking)",
		"",
		"Categories: security | correctness | error-handling | api-contract | database | performance",
		"",
		"Do not include any preamble before the ALLOW/BLOCK line.",
		"Only BLOCK for issues that are P0 or P1.",
		"Style, naming, and minor improvements are NOT blocking (P3 at most).",
		"",
		"AVOID these common false-positive patterns:",
		"- Trace data-access rules through the actual schema and authorization path before claiming an isolation failure.",
		"- Only flag issues INTRODUCED or MODIFIED by this diff. Do not flag pre-existing patterns in unchanged code visible as diff context lines.",
		"- Verify column/field names exist before recommending filters on them. If unsure, note the uncertainty.",
		"- Report ISSUES ONLY. Do not file positive observations, compliments, or 'well-implemented' notes as findings. If code is correct, move on.",
	].join("\n");

	// Machine-readable findings block. Parsed deterministically (see parseJsonFindings);
	// eliminates regex-scraping noise and enables exact file:line agreement matching.
	const jsonBlock = [
		"",
		"---",
		"",
		"MACHINE-READABLE FINDINGS (REQUIRED):",
		"After your prose review above, append a fenced JSON block as the LAST thing in your response.",
		"It is parsed programmatically and MUST be valid JSON:",
		"```json",
		'{"findings":[{"file":"packages/api/src/foo.ts","line":42,"severity":"P2","category":"correctness","description":"one-line summary of the issue"}]}',
		"```",
		"Rules:",
		'- One object per finding. Use {"findings":[]} if you found nothing.',
		"- `file` MUST be a real path from the diff. OMIT any finding you cannot tie to a file (no summaries).",
		"- `line` = integer line number from the diff. `severity` = P0|P1|P2|P3.",
		"- `category` = security|correctness|error-handling|api-contract|database|performance.",
		"- The prose review above is still REQUIRED — the JSON block is in addition to it, not a replacement.",
	].join("\n");

	return `${basePrompt}${getSpecializationBlock(provider)}\n${jsonBlock}`;
}

function writeTempFile(content, suffix = ".txt") {
	const tempPath = path.join(
		tmpdir(),
		`council-critic-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
	);
	writeFileSync(tempPath, content, "utf8");
	return tempPath;
}

function parseNdjsonOpencode(stdout) {
	const parts = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "error")
			throw new Error(`opencode error: ${event.message || JSON.stringify(event)}`);
		if (event.type === "text") parts.push(event.part?.text || "");
	}
	return parts.join("");
}

function buildOpenCodeArgs(prompt, promptFilePath = null, model = OPENCODE_COUNCIL_MODEL) {
	// Read-only plan agent avoids TTY-less permission hangs without granting mutating tools.
	// The preflight uses the same read-only execution path as a real critic run.
	return [
		...(process.platform === "win32" ? ["-NoProfile", "-File", OPENCODE_PS1] : []),
		"run",
		"--format",
		"json",
		"--pure",
		"--agent",
		"plan",
		"--model",
		model,
		prompt,
		...(promptFilePath ? ["-f", promptFilePath] : []),
	];
}

function getOpenCodePreflightConfig() {
	return {
		cmd: process.platform === "win32" ? "pwsh" : "opencode",
		args: buildOpenCodeArgs("Reply with exactly: OK"),
		useStdin: false,
		useTempFile: false,
		promptAsTempFile: false,
		parseOutput: parseNdjsonOpencode,
		minTimeout: OPENCODE_PREFLIGHT_TIMEOUT_MS,
		noShell: process.platform === "win32",
	};
}

function buildOmpArgs(effectiveTimeoutMs, env = process.env, promptFilePath = null) {
	const maxTimeSeconds = Math.max(60, Math.floor(effectiveTimeoutMs / 1000) - 15);
	// Enabling ANY tool on a critic is a security regression: omp's read tool fetches URLs
	// and arbitrary absolute paths outside the reviewed repository.
	return [
		"-p",
		"--no-tools",
		"--no-extensions",
		"--no-rules",
		"--no-skills",
		"--approval-mode",
		"always-ask",
		"--no-session",
		"--no-title",
		"--thinking",
		"medium",
		"--max-time",
		String(maxTimeSeconds),
		...(env.OMP_COUNCIL_MODEL ? ["--model", env.OMP_COUNCIL_MODEL] : []),
		...(promptFilePath ? [`@${promptFilePath}`] : []),
	];
}

function getProviderConfig(provider, mode = "review", options = {}) {
	const isConsult = mode === "consult";
	const p = provider.toLowerCase().replace(/-/g, "");
	const custom = COUNCIL_CONFIG.criticCommands[provider];
	if (custom && typeof custom === "object" && !Array.isArray(custom)) {
		const command = typeof custom.command === "string" ? custom.command.trim() : "";
		const args = Array.isArray(custom.args)
			? custom.args.filter((arg) => typeof arg === "string")
			: [];
		const promptMode = custom.promptMode === "file" ? "file" : "stdin";
		const timeoutSeconds =
			Number.isInteger(custom.timeoutSeconds) && custom.timeoutSeconds > 0
				? custom.timeoutSeconds
				: TIMEOUT_SECONDS;
		if (!command) return null;
		return {
			cmd: command,
			args,
			useStdin: promptMode === "stdin",
			useTempFile: promptMode === "file",
			promptAsTempFile: promptMode === "file",
			buildArgs:
				promptMode === "file"
					? (tempFilePath) => {
							const replaced = args.map((arg) => arg.replaceAll("{promptFile}", tempFilePath));
							return args.some((arg) => arg.includes("{promptFile}"))
								? replaced
								: [...replaced, tempFilePath];
						}
					: undefined,
			parseOutput: (stdout) => (stdout || "").trim(),
			minTimeout: timeoutSeconds * 1000,
		};
	}

	if (p === "grok" || p === "grokcli" || p === "grokcomposer" || p === "composer") {
		// File-based prompts avoid command-line length limits. Plan permissions keep the critic
		// read-only, and the specialty prompt keeps the run single-shot without tool excursions.
		return {
			// GROK_BIN: env override, else ~/.grok/bin/grok.exe (standard install), else bare `grok`.
			cmd: GROK_BIN,
			// Pin optional telemetry off at the harness layer instead of relying on vendor defaults.
			env: { GROK_TELEMETRY_ENABLED: "0", GROK_TELEMETRY_TRACE_UPLOAD: "0" },
			args: [],
			useStdin: false,
			useTempFile: true,
			promptAsTempFile: true,
			buildArgs: (tempFilePath) => [
				"--prompt-file",
				tempFilePath,
				"-m",
				options.modelOverride || GROK_COUNCIL_MODEL,
				"--permission-mode",
				"plan",
				"--output-format",
				"plain",
				"--disable-web-search",
				// NO --effort: grok-4.5 accepts reasoningEffort; we still omit it for safety — revisit
				// before re-adding because the old grok-composer path 400ed and caused empty verdicts.
				"--max-turns",
				"15",
			],
			// Reanchoring is a review-mode verdict normalizer. Consult prompts forbid an approval
			// verdict and expect an unmodified advisory, so in consult mode pass the output through
			// untouched — reanchoring would delete all but the last ALLOW:/BLOCK: line and reorder
			// it to the top, materially altering the counsel the chair sees.
			parseOutput: isConsult
				? (stdout) => (stdout || "").trim()
				: (stdout) => reanchorCriticVerdict(stdout),
			minTimeout: TIMEOUT_SECONDS * 1000,
		};
	}

	if (p === "codex") {
		return {
			// CODEX_BIN: env override, else the npm-global codex.cmd resolved by full path
			// (avoids an unrelated `codex` earlier on PATH shadowing it), else bare `codex`.
			cmd: CODEX_BIN,
			args: [
				"exec",
				"-m",
				options.modelOverride || process.env.CODEX_COUNCIL_MODEL || "gpt-5.6-sol",
				"-c",
				"model_reasoning_effort=high",
				"--sandbox",
				"read-only",
				"--skip-git-repo-check",
			],
			useStdin: true,
			useTempFile: false,
			promptAsTempFile: false,
			useOutputFile: true,
			parseOutput: (stdout) => stdout.trim(),
			minTimeout: 600_000,
		};
	}

	if (p === "opencode") {
		// Cross-family critic through OpenCode. Override the model with OPENCODE_COUNCIL_MODEL.
		return {
			cmd: process.platform === "win32" ? "pwsh" : "opencode",
			buildArgs: (tempFilePath) =>
				buildOpenCodeArgs(
					isConsult
						? "Read the advisory task in the attached file and follow its instructions exactly. Output only your advisory response."
						: "Analyze the code review task in the attached file. List every bug, security issue, and code quality problem you find. Include file paths and line numbers for each issue.",
					tempFilePath,
					options.modelOverride || OPENCODE_COUNCIL_MODEL,
				),
			args: [],
			useStdin: false,
			useTempFile: true,
			promptAsTempFile: true,
			parseOutput: parseNdjsonOpencode,
			minTimeout: 300_000,
			noShell: process.platform === "win32",
			twoPass: !isConsult,
		};
	}

	if (p === "omp") {
		const env = {
			...(options.env ?? process.env),
			...(options.modelOverride ? { OMP_COUNCIL_MODEL: options.modelOverride } : {}),
		};
		const effectiveTimeoutMs = options.timeoutMs ?? TIMEOUT_SECONDS * 1000;
		return {
			cmd: env.OMP_BIN || "omp",
			args: buildOmpArgs(effectiveTimeoutMs, env),
			buildArgs: (tempFilePath) => buildOmpArgs(effectiveTimeoutMs, env, tempFilePath),
			useStdin: false,
			useTempFile: true,
			promptAsTempFile: true,
			// Reanchoring is a review-mode verdict normalizer. Consult prompts forbid an approval
			// verdict and expect an unmodified advisory, so in consult mode pass the output through
			// untouched — reanchoring would delete all but the last ALLOW:/BLOCK: line and reorder
			// it to the top, materially altering the counsel the chair sees.
			parseOutput: isConsult
				? (stdout) => (stdout || "").trim()
				: (stdout) => reanchorCriticVerdict(stdout),
			minTimeout: 0,
			cwd: process.cwd(),
		};
	}

	if (p === "claude" || p === "claudecode" || p === "opus") {
		return {
			cmd: CLAUDE_BIN,
			args: [
				"-p",
				"--model",
				options.modelOverride || process.env.CLAUDE_CRITIC_MODEL || JUDGE_MODEL,
				"--effort",
				"max",
				"--output-format",
				"text",
				"--settings",
				CLEAN_SETTINGS_PATH,
				"--max-turns",
				"1",
			],
			useStdin: true,
			useTempFile: false,
			parseOutput: (stdout) => stdout.trim(),
			minTimeout: TIMEOUT_SECONDS * 1000,
		};
	}

	if (p === "opusjudge") {
		const tools = Array.isArray(options.judgeTools) && options.judgeTools.length > 0
			? options.judgeTools
			: ["Read"];
		const effectiveTimeout = options.judgeTimeoutSeconds ?? JUDGE_TIMEOUT_SECONDS;
		return {
			cmd: CLAUDE_BIN,
			args: [
				"-p",
				"--model",
				JUDGE_MODEL,
				"--effort",
				options.judgeEffort || "high",
				"--output-format",
				"text",
				"--settings",
				CLEAN_SETTINGS_PATH,
				"--allowedTools",
				tools.join(","),
			],
			useStdin: true,
			useTempFile: false,
			parseOutput: (stdout) => stdout.trim(),
			minTimeout: effectiveTimeout * 1000,
			// A native `claude.exe` is directly spawnable on Windows, so we default to noShell to
			// avoid layering cmd.exe's exit-code behavior over the CLI's own failure reporting.
			// claudeNeedsShell() flips this ON for npm-shim installs (claude.cmd/.bat), which
			// shell-less spawn cannot launch. normalizeProviderFailure
			// below also catches Claude releases that print an auth error to stdout and exit zero.
			noShell: !CLAUDE_NEEDS_SHELL,
			...(options.judgeCwd ? { cwd: options.judgeCwd } : {}),
		};
	}

	return null;
}

/**
 * Kill a critic child process AND all its descendants. Plain child.kill() only signals the
 * direct child, which on Windows is usually a wrapper (cmd.exe via shell:true, or pwsh running
 * the opencode.ps1 shim) — killing it can orphan the real CLI underneath.
 * taskkill /T walks the live parent-child tree, so this must run while the wrapper is still
 * alive — i.e. at the kill sites, never after exit. POSIX kills the process group instead,
 * which requires the child to be spawned detached (its own group leader).
 */
function killTree(child) {
	if (!child || child.pid == null) return;
	if (process.platform === "win32") {
		try {
			execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} catch {}
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
	}
	try {
		child.kill("SIGKILL");
	} catch {}
}

/**
 * Live critic children, reaped if the gate itself is interrupted. POSIX critics run detached
 * (own process group, for killTree's group kill), which also means a Ctrl-C/SIGTERM to the
 * gate no longer propagates to them — and on Windows console signals never reached grandchildren
 * anyway. Without this, aborting a long review can orphan active critics.
 * Installed lazily on first spawn so importing this module (tests) registers no handlers.
 */
const ACTIVE_CRITIC_CHILDREN = new Set();
let signalReapersInstalled = false;
function installSignalReapers() {
	if (signalReapersInstalled) return;
	signalReapersInstalled = true;
	for (const [signal, code] of [
		["SIGHUP", 129],
		["SIGINT", 130],
		["SIGTERM", 143],
	]) {
		process.on(signal, () => {
			for (const child of ACTIVE_CRITIC_CHILDREN) killTree(child);
			process.exit(code);
		});
	}
}

async function spawnCriticOnce(provider, config, prompt, timeoutMs) {
	const t0 = Date.now();
	const effectiveTimeout = Math.max(timeoutMs, config.minTimeout);
	const tempFiles = [];

	let stdinFd = null;
	let outputFile = null;
	try {
		let spawnArgs = [...config.args];
		let stdinMode = config.useStdin ? "pipe" : "ignore";

		if (config.promptAsTempFile) {
			const promptFile = writeTempFile(prompt, ".md");
			tempFiles.push(promptFile);
			spawnArgs = config.buildArgs(promptFile);
		} else if (config.useTempFile && !config.promptAsTempFile) {
			const promptFile = writeTempFile(prompt, ".md");
			tempFiles.push(promptFile);
			stdinFd = openSync(promptFile, "r");
			stdinMode = stdinFd;
		}

		if (config.useOutputFile) {
			outputFile = writeTempFile("", ".txt");
			tempFiles.push(outputFile);
			spawnArgs.push("-o", outputFile);
		}

		return await new Promise((resolve) => {
			let stdout = "";
			let stderr = "";
			let settled = false;

			function settle(result) {
				if (settled) return;
				settled = true;
				resolve(result);
			}

			const useShell = process.platform === "win32" && !config.noShell;
			const spawnOpts = {
				stdio: [stdinMode, "pipe", "pipe"],
				shell: useShell,
				// POSIX: own process group so killTree can reap the whole tree via kill(-pid).
				detached: process.platform !== "win32",
				// Per-provider env overrides merge over the inherited environment.
				...(config.env ? { env: { ...process.env, ...config.env } } : {}),
				...(config.cwd ? { cwd: config.cwd } : {}),
			};

			installSignalReapers();
			const child = useShell
				? spawn(
						[config.cmd, ...spawnArgs]
							.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
							.join(" "),
						[],
						spawnOpts,
					)
				: spawn(config.cmd, spawnArgs, spawnOpts);
			ACTIVE_CRITIC_CHILDREN.add(child);

			const timer = setTimeout(() => {
				let parsed = stdout;
				try {
					parsed = config.parseOutput(stdout);
				} catch {}
				settle({
					provider,
					ok: false,
					output: parsed,
					error: `Timeout after ${effectiveTimeout}ms`,
					durationMs: Date.now() - t0,
					rawOutput: stdout,
				});
				killTree(child);
			}, effectiveTimeout);

			// Optional inactivity watchdog: providers that opt in via config.idleTimeoutMs are
			// reaped when they produce NO stdout/stderr for that window (a hung stream), instead
			// of waiting out the full wall-clock timeout. Reset on every chunk.
			const idleMs = config.idleTimeoutMs;
			let idleTimer = null;
			function clearIdle() {
				if (idleTimer) {
					clearTimeout(idleTimer);
					idleTimer = null;
				}
			}
			function resetIdle() {
				if (settled || !idleMs) return;
				clearIdle();
				idleTimer = setTimeout(() => {
					let parsed = stdout;
					try {
						parsed = config.parseOutput(stdout);
					} catch {}
					killTree(child);
					settle({
						provider,
						ok: false,
						output: parsed,
						error: `Idle timeout: no output for ${idleMs}ms`,
						durationMs: Date.now() - t0,
						rawOutput: stdout,
					});
				}, idleMs);
			}
			resetIdle();

			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
				resetIdle();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
				resetIdle();
			});

			if (config.useStdin) {
				child.stdin.write(prompt, "utf8");
				child.stdin.end();
				child.stdin.on("error", () => {});
			}

			child.on("close", (code) => {
				ACTIVE_CRITIC_CHILDREN.delete(child);
				clearTimeout(timer);
				clearIdle();
				const durationMs = Date.now() - t0;
				if (code !== 0 && !stdout.trim()) {
					settle({
						provider,
						ok: false,
						output: stdout,
						error: `Exit ${code}: ${stderr.slice(0, 500)}`,
						exitCode: code,
						durationMs,
						rawOutput: stdout,
					});
				} else {
					let output;
					let fromOutputFile = false;
					if (outputFile) {
						try {
							const fileContent = readFileSync(outputFile, "utf8").trim();
							if (fileContent) {
								output = fileContent;
								fromOutputFile = true;
							}
						} catch {}
					}
					if (!fromOutputFile) {
						try {
							output = config.parseOutput(stdout);
						} catch (parseErr) {
							settle({
								provider,
								ok: false,
								output: stdout,
								error: `Parse error: ${parseErr.message}`,
								durationMs,
							});
							return;
						}
					}
					settle({
						provider,
						ok: true,
						output,
						error: null,
						exitCode: code,
						durationMs,
						rawOutput: stdout,
						stderr,
					});
				}
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				clearIdle();
				settle({
					provider,
					ok: false,
					output: "",
					error: err.message,
					durationMs: Date.now() - t0,
					rawOutput: "",
				});
			});
		});
	} finally {
		if (stdinFd !== null) {
			try {
				closeSync(stdinFd);
			} catch {}
		}
		for (const f of tempFiles) {
			try {
				unlinkSync(f);
			} catch {}
		}
		// Codex -o flag on Windows can write a stray file literally named "-"
		try {
			const s = statSync("-");
			if (s.isFile() && s.size === 0) unlinkSync("-");
		} catch {}
	}
}

async function preflightOpenCode() {
	const result = await spawnCriticOnce(
		"opencode-preflight",
		getOpenCodePreflightConfig(),
		"",
		OPENCODE_PREFLIGHT_TIMEOUT_MS,
	);
	if (!result.ok || result.exitCode !== 0) {
		return { status: "failed", reason: result.error || `Exit ${result.exitCode}` };
	}
	if (!result.output?.trim()) {
		return { status: "failed", reason: "empty output" };
	}
	return { status: "passed", reason: null };
}

async function preflightActiveCritics(critics) {
	const effectiveCritics = [...critics];
	if (!effectiveCritics.some((provider) => isOpenCodeProvider(provider))) {
		return { effectiveCritics, opencodePreflight: "not_run" };
	}

	const result = await preflightOpenCode();
	if (result.status === "passed") {
		return { effectiveCritics, opencodePreflight: "passed" };
	}

	const failureReason = result.reason.replace(/\s+/g, " ").trim().slice(0, 500);
	process.stderr.write(
		`opencode critic EXCLUDED for this run (preflight failed: ${failureReason}) — likely provider quota exhaustion; the seat auto-revives when the preflight passes.\n`,
	);
	return {
		effectiveCritics: effectiveCritics.filter((provider) => !isOpenCodeProvider(provider)),
		opencodePreflight: "failed",
	};
}

function buildPass2Prompt(pass1Output) {
	return [
		"You previously analyzed a code diff and found these issues:",
		"",
		pass1Output,
		"",
		"Now produce your final review verdict.",
		"Your response MUST begin with exactly one of:",
		"  ALLOW: <one-line reason>",
		"  BLOCK: <one-line reason>",
		"",
		"Reformat each finding as:",
		"  - [SEVERITY] `filepath:L##` (CATEGORY) — description",
		"",
		"Severity: P0 = must fix (blocking), P1 = should fix (blocking), P2 = fix eventually, P3 = nit",
		"Categories: security | correctness | error-handling | api-contract | database | performance",
		"Only BLOCK for P0 or P1 issues.",
	].join("\n");
}

async function callLocalModelDirect(prompt, opts = {}) {
	const config = resolveLocalModelConfig();
	const t0 = Date.now();
	if (!config) {
		return {
			ok: false,
			output: "",
			error: "Local model API: set LOCAL_MODEL_URL or LM_STUDIO_URL to enable direct grading",
			durationMs: Date.now() - t0,
		};
	}
	const model =
		process.env.LOCAL_MODEL || process.env.LM_STUDIO_MODEL || process.env.OMP_COUNCIL_MODEL;
	if (!model) {
		return {
			ok: false,
			output: "",
			error: "Local model API: set LOCAL_MODEL, LM_STUDIO_MODEL, or OMP_COUNCIL_MODEL",
			durationMs: Date.now() - t0,
		};
	}
	try {
		const response = await fetch(`${config.url}/v1/chat/completions`, {
			method: "POST",
			headers: buildLocalModelHeaders(config.key, true),
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				temperature: 0.7,
				top_p: 0.8,
				presence_penalty: 1.5,
				max_tokens: opts.maxTokens ?? 4096,
				chat_template_kwargs: { enable_thinking: false },
			}),
			signal: AbortSignal.timeout(opts.timeout ?? 60_000),
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			const authHint =
				response.status === 401 && !config.key
					? " Set LOCAL_MODEL_API_KEY when the endpoint requires authentication."
					: "";
			return {
				ok: false,
				output: "",
				error: `Local model ${response.status}: ${body.slice(0, 300)}${authHint}`,
				durationMs: Date.now() - t0,
			};
		}
		const data = await response.json();
		const content = data.choices?.[0]?.message?.content || "";
		return { ok: true, output: content.trim(), error: null, durationMs: Date.now() - t0 };
	} catch (err) {
		return {
			ok: false,
			output: "",
			error: `Local model API: ${err.message}`,
			durationMs: Date.now() - t0,
		};
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isOpenCodeProvider(provider) {
	return provider.toLowerCase() === "opencode";
}

function hasCriticOutput(result) {
	return Boolean(result.output?.trim());
}

/** @param {string} output */
function hasCriticVerdictHeading(output) {
	return collectCriticVerdictLines(output).length > 0;
}

/** @param {string} output */
function hasCriticFindingsJsonBlock(output) {
	if (!output) return false;
	for (const match of output.matchAll(/```json\s*([\s\S]*?)```/gi)) {
		try {
			const parsed = JSON.parse(match[1].trim());
			if (parsed && typeof parsed === "object" && "findings" in parsed) return true;
		} catch {}
	}
	return /\{\s*"findings"\s*:/i.test(output);
}

/**
 * Agentic critic CLIs (grok-4.5, omp) can prepend a narration preamble
 * ("I'll review the full branch diff…") and glue the ALLOW:/BLOCK: verdict onto the same line,
 * defeating the line-anchored verdict detector and first-content-line parser, causing a false
 * critic_no_output when short, mis-tallied BLOCK when long. Re-anchor the LAST explicit verdict
 * line at the start (last occurrence wins), remove earlier verdict lines, and preserve all other
 * review content. Markdown heading/bold wrappers are normalized away. No-op when absent.
 * @param {string} stdout
 */
function reanchorCriticVerdict(stdout) {
	const s = (stdout || "").trim();
	const verdicts = collectCriticVerdictLines(s);
	if (verdicts.length === 0) return s;
	const selected = verdicts.at(-1);
	const verdictIndexes = new Set(verdicts.map((verdict) => verdict.index));
	const remaining = s
		.split("\n")
		.filter((_, index) => !verdictIndexes.has(index))
		.join("\n")
		.trim();
	return remaining ? `${selected.text}\n\n${remaining}` : selected.text;
}

/**
 * Strip a single layer of balanced outer markdown emphasis from a line so a fully-wrapped
 * verdict ("**ALLOW: …**") parses without the wrapper leaking into the reason. Only strips when
 * the line both starts and ends with the same marker — a reason that ends in emphasis mid-line
 * ("ALLOW: this is *critical*") is left untouched so it stays balanced.
 * @param {string} line
 */
function stripOuterEmphasis(line) {
	for (const marker of ["**", "__", "*", "_"]) {
		if (line.length > marker.length * 2 && line.startsWith(marker) && line.endsWith(marker)) {
			return line.slice(marker.length, -marker.length).trim();
		}
	}
	return line;
}

/**
 * Find explicit critic verdict lines outside code fences. A verdict may appear anywhere and may
 * use markdown heading/bold wrappers. It may sit at the line start OR be glued after a narration
 * sentence boundary ("I reviewed the diff. BLOCK: missing account filter"). The
 * sentence-boundary requirement (a `.`/`!`/`?` + space) avoids matching prose that merely quotes
 * the token ("emit an explicit BLOCK: line"). Callers select the last occurrence.
 * @param {string} output
 */
function collectCriticVerdictLines(output) {
	if (!output?.trim()) return [];
	const verdicts = [];
	let inFence = false;
	for (const [index, line] of output.split("\n").entries()) {
		const trimmed = line.trim();
		if (/^(?:```|~~~)/.test(trimmed)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const clean = stripOuterEmphasis(trimmed.replace(/^#{1,6}\s*/, ""));
		const match =
			clean.match(/^(?:\*{1,2}|_{1,2})?\s*(ALLOW|BLOCK):\s*(.*)$/i) ||
			clean.match(/[.!?]\s+(?:\*{1,2}|_{1,2})?\s*(ALLOW|BLOCK):\s*(.*)$/i);
		if (!match) continue;
		const decision = match[1].toLowerCase();
		const reason = match[2].trim();
		verdicts.push({
			decision,
			index,
			text: `${decision.toUpperCase()}:${reason ? ` ${reason}` : ""}`,
		});
	}
	return verdicts;
}

/** @param {string} output */
function isCriticNoVerdict(output) {
	const trimmed = (output || "").trim();
	if (trimmed.length >= CRITIC_NO_VERDICT_CHAR_LIMIT) return false;
	return !hasCriticVerdictHeading(output) && !hasCriticFindingsJsonBlock(output);
}

/** @param {{ ok: boolean, output?: string, error?: string | null }} result */
function isJudgeTransientFailure(result) {
	const diagnostic = `${result.error || ""}\n${result.output || ""}`;
	if (/failed to authenticate|oauth session expired|not logged in/i.test(diagnostic)) return false;
	if (/529|rate.?limit|overload|resource.?exhaust/i.test(result.error || "")) return true;
	if (!result.output?.trim()) return true;
	if (result.ok && result.output?.trim()) {
		const verdict = parseVerdict(result.output);
		if (verdict.reason?.toLowerCase().includes("judge verdict unparseable")) return true;
	}
	return false;
}

function normalizeProviderFailure(result) {
	const output = (result.output || "").trim();
	// Only classify as an auth failure when the output is short AND error-shaped. Two guards, both
	// required, so a real review is never dropped as an auth failure:
	//   1. length guard — a full-length review that merely quotes "not logged in" (e.g. reviewing
	//      auth code) is not an error.
	//   2. shape guard — even a SHORT response that carries a real review payload (an explicit
	//      ALLOW:/BLOCK: verdict or a findings JSON block) is a legitimate concise review, not a
	//      standalone CLI auth diagnostic, and must be preserved.
	if (output.length >= CRITIC_NO_VERDICT_CHAR_LIMIT) return result;
	if (hasCriticVerdictHeading(output) || hasCriticFindingsJsonBlock(output)) return result;

	const diagnostic = `${result.error || ""}\n${output}`;
	if (result.ok && /failed to authenticate|oauth session expired|not logged in/i.test(diagnostic)) {
		return {
			...result,
			ok: false,
			error: output || result.error || "Provider authentication failed",
		};
	}
	return result;
}

/**
 * A permanent judge authentication failure (expired OAuth, not logged in). Keyed on a
 * non-ok result carrying an auth-error phrase: a rendered verdict (ok:true) is never an auth
 * failure even when its prose discusses auth code, because normalizeProviderFailure has already
 * demoted a genuine exit-zero auth diagnostic to ok:false.
 * @param {{ ok: boolean, output?: string, error?: string | null }} result
 */
function isJudgeAuthFailure(result) {
	if (result.ok) return false;
	return /failed to authenticate|oauth session expired|not logged in/i.test(
		`${result.error || ""}\n${result.output || ""}`,
	);
}

function markCriticNoOutput(result) {
	return {
		...result,
		ok: false,
		criticNoOutput: true,
		error: result.error || "critic_no_output",
	};
}

function shouldRetryOpenCodeResult(result) {
	return !result.ok || !hasCriticOutput(result);
}

function normalizeOpenCodeRetryFailure(result) {
	if (result.ok && !hasCriticOutput(result)) {
		return { ...result, ok: false, error: "OpenCode returned empty output after retry" };
	}
	return result;
}

async function retryOpenCodeOnce(provider, config, prompt, timeoutMs, firstResult) {
	const reason = firstResult.ok ? "empty output" : firstResult.error || "failure";
	console.error(
		`  [${provider}] ${reason}; retrying once after ${OPENCODE_RETRY_DELAY_MS / 1000}s...`,
	);
	await delay(OPENCODE_RETRY_DELAY_MS);
	const retryResult = await spawnCriticOnce(provider, config, prompt, timeoutMs);
	return normalizeOpenCodeRetryFailure(retryResult);
}

async function spawnCritic(provider, prompt, timeoutMs, mode = "review", options = {}) {
	const config = getProviderConfig(provider, mode, { ...options, timeoutMs });
	if (!config) {
		return {
			provider,
			ok: false,
			output: "",
			error: `Unknown provider: ${provider}`,
			durationMs: 0,
		};
	}

	let result = normalizeProviderFailure(await spawnCriticOnce(provider, config, prompt, timeoutMs));

	if (isOpenCodeProvider(provider) && shouldRetryOpenCodeResult(result)) {
		result = await retryOpenCodeOnce(provider, config, prompt, timeoutMs, result);
		if (!result.ok) {
			return result;
		}
	} else {
		if (
			!result.ok &&
			config.fallbackArgs &&
			/rate.?limit|quota|429|resource.?exhaust/i.test(result.error)
		) {
			const fallbackConfig = { ...config, args: config.fallbackArgs };
			const fallbackModel =
				config.fallbackArgs[config.fallbackArgs.indexOf("--model") + 1] || "fallback";
			console.error(`  [${provider}] Rate limited, retrying with ${fallbackModel}...`);
			return spawnCriticOnce(provider, fallbackConfig, prompt, timeoutMs);
		}

		if (
			!result.ok &&
			/model.?(?:re|un)?load(?:ing|ed)?|ECONNREFUSED|ECONNRESET|EPIPE|UV_HANDLE_CLOSING|idle timeout/i.test(
				result.error || "",
			)
		) {
			console.error(`  [${provider}] Transient error, retrying...`);
			return spawnCriticOnce(provider, config, prompt, timeoutMs);
		}

		if (result.ok && !hasCriticOutput(result)) {
			console.error(`  [${provider}] Empty output, retrying...`);
			return spawnCriticOnce(provider, config, prompt, timeoutMs);
		}
	}

	if (config.twoPass && result.ok && hasCriticOutput(result)) {
		console.error(
			`  [${provider}] Pass 1 complete (${(result.durationMs / 1000).toFixed(1)}s), running grading pass (direct API, thinking OFF)...`,
		);
		const pass2Prompt = buildPass2Prompt(result.output);
		const pass2Result = await callLocalModelDirect(pass2Prompt, { timeout: 60_000 });
		if (pass2Result.ok && pass2Result.output?.trim()) {
			result = {
				provider,
				ok: true,
				output: pass2Result.output,
				error: null,
				durationMs: result.durationMs + pass2Result.durationMs,
			};
		} else {
			console.error(
				`  [${provider}] Grading pass failed (${pass2Result.error}), using pass 1 output`,
			);
			result.pass2Fallback = true;
		}
	}

	// A critic lacking both verdict heading and findings JSON is retried once, then excluded.
	if (mode === "review" && result.ok && isCriticNoVerdict(result.output || "")) {
		console.error(
			`  [${provider}] critic_no_output suspected (<${CRITIC_NO_VERDICT_CHAR_LIMIT} chars, no verdict/findings); retrying once after ${CRITIC_NO_VERDICT_RETRY_DELAY_MS / 1000}s...`,
		);
		await delay(CRITIC_NO_VERDICT_RETRY_DELAY_MS);
		const retryResult = await spawnCriticOnce(provider, config, prompt, timeoutMs);
		if (isCriticNoVerdict(retryResult.output || "")) {
			console.error(`  [${provider}] critic_no_output — excluded from tallies (not a BLOCK)`);
			return markCriticNoOutput(retryResult);
		}
		return retryResult;
	}

	return result;
}

async function probeCriticAuth(provider, prompt, timeoutMs = 60_000) {
	const config = getProviderConfig(provider, "consult", { timeoutMs });
	if (!config) {
		return {
			provider,
			ok: false,
			output: "",
			error: `Unknown provider: ${provider}`,
			durationMs: 0,
		};
	}
	return normalizeProviderFailure(
		await spawnCriticOnce(provider, { ...config, minTimeout: 0, twoPass: false }, prompt, timeoutMs),
	);
}

function buildCriticPrompt(branchInfo, provider, diff, context = "") {
	return `${buildTaskPrompt(branchInfo, provider)}${context}\n\nDIFF:\n${diff}`;
}

async function runCriticsParallel(critics, branchInfo, diff, timeoutMs, context = "") {
	const providers = Array.isArray(critics)
		? critics
		: critics
				.split(",")
				.map((p) => p.trim())
				.filter(Boolean);
	const settled = await Promise.allSettled(
		providers.map((provider) => {
			const prompt = buildCriticPrompt(branchInfo, provider, diff, context);
			return spawnCritic(provider, prompt, timeoutMs);
		}),
	);
	return settled.map((result, index) =>
		result.status === "fulfilled"
			? result.value
			: {
					provider: providers[index] ?? "unknown",
					ok: false,
					output: "",
					error: result.reason?.message ?? String(result.reason),
					durationMs: 0,
				},
	);
}

// Critics are asked to append a machine-readable ```json {"findings":[...]} ``` block.
// When present and valid, this is parsed deterministically — far more reliable than
// regex-scraping prose (no "uncategorized" noise, exact file:line for agreement matching).
// Returns an array of normalized findings, or null if no valid JSON block is present
// (callers fall back to extractStructuredFindings on the prose).
function parseJsonFindings(output) {
	if (!output) return null;
	const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/gi)].map((m) => m[1]);
	// Prefer the LAST valid block (the prompt asks for it as the final element).
	for (let i = blocks.length - 1; i >= 0; i--) {
		let parsed;
		try {
			parsed = JSON.parse(blocks[i].trim());
		} catch {
			continue;
		}
		if (!Array.isArray(parsed?.findings)) continue;
		return parsed.findings
			.filter((f) => f && typeof f === "object")
			.map((f) => {
				// `line` may be a number (42) or a range string ("10-20"); take the start.
				const firstSeg = String(f.line ?? f.lineStart ?? "")
					.trim()
					.split(/[-–]/)[0];
				const parsedLine = parseInt(firstSeg, 10);
				return {
					description: String(f.description || "").trim(),
					file: f.file ? String(f.file).trim() : null,
					lineStart: Number.isFinite(parsedLine) ? parsedLine : 0,
					severity: String(f.severity || "info")
						.toLowerCase()
						.replace(/[^a-z0-9]/g, ""),
					category: String(f.category || "uncategorized")
						.toLowerCase()
						.trim()
						.replace(/\s+/g, "-"),
				};
			})
			.filter((f) => f.description || f.file);
	}
	return null;
}

/**
 * Parse a Phase-1 critic's verdict. Unlike the stricter judge parser, critic verdict lines may
 * appear anywhere in the document; the last explicit line wins. When no explicit line exists, a
 * valid findings JSON block is authoritative: P0/P1 findings block, while an empty/advisory-only
 * list allows. This prevents a clean findings block from becoming a fail-closed false BLOCK.
 * @param {string} output
 */
function parseCriticVerdict(output) {
	const genericVerdict = parseVerdict(output);
	const explicitVerdicts = collectCriticVerdictLines(output);
	const explicitVerdict = explicitVerdicts.at(-1) || null;
	const findings = parseJsonFindings(output);
	const findingsDecision =
		findings === null
			? null
			: findings.some((finding) => /^(?:p0|p1)$/i.test(finding.severity))
				? "block"
				: "allow";

	const blockerCount = findings
		? findings.filter((finding) => /^(?:p0|p1)$/i.test(finding.severity)).length
		: 0;
	// Fail CLOSED on one specific disagreement shape: the critic wrote an explicit ALLOW but its
	// machine-readable findings carry a P0/P1 blocker. ALLOW + empty/advisory-only findings stays
	// ALLOW; only a blocker-severity contradiction escalates to BLOCK. A conflicting-signal ALLOW
	// must not be able to pass the gate via the judge-unavailable critic fallback.
	const failClosed = explicitVerdict?.decision === "allow" && findingsDecision === "block";
	const decision = failClosed
		? "block"
		: explicitVerdict?.decision || findingsDecision || genericVerdict.decision;
	const reason = failClosed
		? `BLOCK: critic emitted "${explicitVerdict.text}" but its findings JSON contains ${blockerCount} P0/P1 blocker(s) — failing closed`
		: explicitVerdict
			? explicitVerdict.text
			: findingsDecision
				? `${findingsDecision.toUpperCase()}: findings JSON contains ${findings.length} finding(s), with ${blockerCount} blocker(s)`
				: genericVerdict.reason;
	const discrepancies = [];
	if (explicitVerdict && genericVerdict.decision !== explicitVerdict.decision) {
		discrepancies.push(
			`explicit text says ${explicitVerdict.decision.toUpperCase()} but the generic parser says ${genericVerdict.decision.toUpperCase()}`,
		);
	}
	if (explicitVerdict && findingsDecision && explicitVerdict.decision !== findingsDecision) {
		discrepancies.push(
			`explicit text says ${explicitVerdict.decision.toUpperCase()} but findings imply ${findingsDecision.toUpperCase()}`,
		);
	}
	if (!explicitVerdict && findingsDecision && genericVerdict.decision !== findingsDecision) {
		discrepancies.push(
			`findings imply ${findingsDecision.toUpperCase()} but the generic parser says ${genericVerdict.decision.toUpperCase()}`,
		);
	}

	return {
		decision,
		reason,
		discrepancy: discrepancies.length > 0 ? discrepancies.join("; ") : null,
	};
}

function criticVerdictSource(result) {
	const provider = result.provider.toLowerCase().replace(/-/g, "");
	if ((provider === "omp" || provider === "grok") && result.rawOutput) {
		return result.rawOutput;
	}
	return result.output || "";
}

function tallyCriticVerdict(result, logDiscrepancy = false) {
	const rawVerdict = parseCriticVerdict(criticVerdictSource(result));
	let verdict = rawVerdict;
	if (Array.isArray(result.groundedFindings) && result.groundedFindings.length > 0) {
		const countedFindings = result.groundedFindings
			.filter((finding) => finding.grounding !== "fabricated")
			.map((finding) => ({
				...finding,
				severity:
					finding.grounding === "out_of_scope" && /^(?:p0|p1)$/i.test(finding.severity)
						? "p2"
						: finding.severity,
			}));
		const blockers = countedFindings.filter((finding) => /^(?:p0|p1)$/i.test(finding.severity));
		const decision = blockers.length > 0 ? "block" : "allow";
		verdict = {
			decision,
			reason: `${decision.toUpperCase()}: grounded findings contain ${countedFindings.length} counted finding(s), with ${blockers.length} blocker(s)`,
			discrepancy:
				rawVerdict.decision === decision
					? rawVerdict.discrepancy
					: `raw critic verdict says ${rawVerdict.decision.toUpperCase()} but grounded findings imply ${decision.toUpperCase()}`,
		};
	}
	if (logDiscrepancy && verdict.discrepancy) {
		process.stderr.write(
			`  [${result.provider}] verdict_discrepancy: ${verdict.discrepancy}; using ${verdict.decision.toUpperCase()}\n`,
		);
	}
	return verdict;
}

function extractStructuredFindings(output) {
	const findings = [];
	const lines = (output || "").split("\n");
	for (const line of lines) {
		const fileMatch = line.match(/[`"]?([a-zA-Z0-9_\-/.]+\.[a-zA-Z]{1,4})[`"]?[:\s]/);
		if (fileMatch?.[1] === "file.ext") continue;
		const lineMatch = line.match(/[:\s]L?(\d+[-–]\d+|\d+)/i);
		const severityMatch = line.match(/\b(P0|P1|P2|P3|info|critical|high|medium|low)\b/i);
		const categoryMatch = line.match(
			/\b(security|correctness|error.?handling|api.?contract|database|performance)\b/i,
		);

		if (fileMatch || severityMatch) {
			findings.push({
				description: line.trim(),
				file: fileMatch?.[1] || null,
				lineStart: lineMatch?.[1] ? parseInt(lineMatch[1].split(/[-–]/)[0], 10) : 0,
				severity: severityMatch?.[1]?.toLowerCase() || "info",
				category: categoryMatch?.[1]?.toLowerCase() || "uncategorized",
			});
		}
	}
	return findings;
}

function isVerdictSummary(finding) {
	if (!finding.description) return false;
	const d = finding.description.trim();
	// Drop ALLOW/BLOCK verdict lines and any finding with no locatable file — a
	// finding without a file path is a summary/observation, not an actionable issue.
	return /^(?:ALLOW|BLOCK):/i.test(d) || !finding.file;
}

function aggregateFindings(criticResults) {
	const allFindings = [];
	const seenSignatures = new Set();

	for (const result of criticResults) {
		if (!result.ok || result.criticNoOutput) continue;
		// Prefer the critic's machine-readable JSON block; fall back to prose scraping
		// for critics that didn't emit a valid block.
		const findings = parseJsonFindings(result.output) ?? extractStructuredFindings(result.output);
		for (const finding of findings) {
			if (isVerdictSummary(finding)) continue;
			const normFile = finding.file ? normalizeDiffPath(finding.file) : null;
			const bucket = Math.floor(finding.lineStart / 20);
			const sig = `${normFile}:${bucket}`;
			if (seenSignatures.has(sig)) {
				const existing = allFindings.find((f) => {
					const ef = f.file ? normalizeDiffPath(f.file) : null;
					return `${ef}:${Math.floor(f.lineStart / 20)}` === sig;
				});
				if (existing && finding.description.length > existing.description.length) {
					Object.assign(existing, {
						...finding,
						foundBy: existing.foundBy,
						agreedBy: existing.agreedBy,
					});
				}
				if (
					existing &&
					result.provider !== existing.foundBy &&
					!(existing.agreedBy || []).includes(result.provider)
				) {
					existing.agreedBy = [...(existing.agreedBy || []), result.provider];
				}
			} else {
				seenSignatures.add(sig);
				finding.foundBy = result.provider;
				finding.agreedBy = [];
				allFindings.push(finding);
			}
		}
	}

	return allFindings;
}

function collectCriticFindings(criticResults) {
	const findings = [];
	for (const result of criticResults) {
		if (!result.ok || result.criticNoOutput) continue;
		const parsed = parseJsonFindings(result.output) ?? extractStructuredFindings(result.output);
		for (const finding of parsed) {
			if (isVerdictSummary(finding)) continue;
			findings.push({ ...finding, foundBy: result.provider, agreedBy: [] });
		}
	}
	return findings;
}

function normalizeDiffPath(filePath) {
	return filePath
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/\\/g, "/")
		.replace(/^(?:a|b)\//, "");
}

function parseDiffForGrounding(diffText) {
	const oldFiles = new Set();
	const newFiles = new Set();
	const oldHunksByFile = new Map();
	const hunksByFile = new Map();
	let currentOldFile = null;
	let currentNormFile = null;
	let currentIsOldOnly = false;

	for (const line of diffText.split("\n")) {
		if (line.startsWith("--- ")) {
			const match = line.match(/^--- (?:a\/)?(.+)$/);
			if (match && match[1] !== "/dev/null") {
				currentOldFile = normalizeDiffPath(match[1]);
				oldFiles.add(currentOldFile);
			} else {
				currentOldFile = null;
			}
			continue;
		}
		if (line.startsWith("+++ ")) {
			const match = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
			if (match && match[1] !== "/dev/null") {
				currentNormFile = normalizeDiffPath(match[1]);
				newFiles.add(currentNormFile);
				currentIsOldOnly = false;
			} else if (match && match[1] === "/dev/null") {
				currentIsOldOnly = true;
			}
			continue;
		}
		if (line.startsWith("@@ ")) {
			const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
			if (hunkMatch && currentOldFile) {
				const oldStart = Number.parseInt(hunkMatch[1], 10);
				const oldCount = Number.parseInt(hunkMatch[2] || "1", 10);
				if (!oldHunksByFile.has(currentOldFile)) {
					oldHunksByFile.set(currentOldFile, []);
				}
				oldHunksByFile
					.get(currentOldFile)
					.push({ start: oldStart, end: oldStart + oldCount - 1 });
			}
			if (hunkMatch && currentNormFile && !currentIsOldOnly) {
				const newStart = Number.parseInt(hunkMatch[3], 10);
				const newCount = Number.parseInt(hunkMatch[4] || "1", 10);
				if (!hunksByFile.has(currentNormFile)) {
					hunksByFile.set(currentNormFile, []);
				}
				hunksByFile.get(currentNormFile).push({ start: newStart, end: newStart + newCount - 1 });
			}
			continue;
		}
		if (line.startsWith("diff --git ")) {
			currentOldFile = null;
			currentNormFile = null;
			currentIsOldOnly = false;
		}
	}

	return { oldFiles, newFiles, oldHunksByFile, hunksByFile };
}

function resolveCitedFilePath(citedFile, oldFiles, newFiles) {
	const norm = normalizeDiffPath(citedFile);
	if (newFiles.has(norm) || oldFiles.has(norm)) return norm;
	for (const ref of newFiles) {
		if (norm.endsWith(`/${ref}`) || ref.endsWith(`/${norm}`)) return ref;
	}
	for (const ref of oldFiles) {
		if (norm.endsWith(`/${ref}`) || ref.endsWith(`/${norm}`)) return ref;
	}
	return norm;
}

function lineWithinHunks(lineNumber, hunkRanges) {
	const GROUNDING_SLACK = 3;
	for (const hunk of hunkRanges) {
		if (lineNumber >= hunk.start - GROUNDING_SLACK && lineNumber <= hunk.end + GROUNDING_SLACK) {
			return true;
		}
	}
	return false;
}

function getCachedLineCount(filePath, lineCountCache) {
	if (lineCountCache.has(filePath)) return lineCountCache.get(filePath);
	let count = -1;
	try {
		const content = readFileSync(filePath, "utf8");
		count = content.split("\n").length;
	} catch {
		count = -1;
	}
	lineCountCache.set(filePath, count);
	return count;
}

function runGroundingPass(findings, diffText) {
	const { oldFiles, newFiles, oldHunksByFile, hunksByFile } = parseDiffForGrounding(diffText);
	const lineCountCache = new Map();
	const counts = { grounded: 0, out_of_scope: 0, fabricated: 0 };
	const fabricatedByCritic = new Map();

	for (const finding of findings) {
		if (!finding.file) continue;
		delete finding.lineVerified;
		const resolvedFile = resolveCitedFilePath(finding.file, oldFiles, newFiles);
		const isNewSide = newFiles.has(resolvedFile);
		const isOldSide = oldFiles.has(resolvedFile);
		const fileOnDisk = existsSync(resolvedFile);

		if (!isNewSide && !isOldSide && !fileOnDisk) {
			finding.grounding = "fabricated";
			counts.fabricated++;
			if (finding.foundBy) {
				fabricatedByCritic.set(
					finding.foundBy,
					(fabricatedByCritic.get(finding.foundBy) || 0) + 1,
				);
			}
			continue;
		}

		if (isNewSide || isOldSide) {
			const hunkRanges = isNewSide
				? hunksByFile.get(resolvedFile)
				: oldHunksByFile.get(resolvedFile);
			let lineVerified =
				finding.lineStart > 0 &&
				Array.isArray(hunkRanges) &&
				lineWithinHunks(finding.lineStart, hunkRanges);
			if (lineVerified && fileOnDisk) {
				const lineCount = getCachedLineCount(resolvedFile, lineCountCache);
				lineVerified = lineCount >= 0 && finding.lineStart <= lineCount;
			}
			finding.grounding = "grounded";
			finding.lineVerified = lineVerified;
			counts.grounded++;
			continue;
		}

		if (!isNewSide && fileOnDisk) {
			finding.grounding = "out_of_scope";
			counts.out_of_scope++;
			continue;
		}

		finding.grounding = "grounded";
		counts.grounded++;
	}

	return { counts, fabricatedByCritic };
}

function buildGroundingPromptSection(findings, fabricatedByCritic) {
	const lines = [];
	const outOfScopeFindings = findings.filter((f) => f.grounding === "out_of_scope");
	const groundedFindings = findings.filter((f) => f.grounding === "grounded");

	for (const [critic, count] of fabricatedByCritic) {
		lines.push(
			`- critic ${critic} cited ${count} nonexistent file(s); its remaining findings warrant extra scrutiny.`,
		);
	}

	if (outOfScopeFindings.length > 0) {
		lines.push("");
		lines.push("The following findings cite files not changed in this diff (out-of-scope; demoted to P2):");
		for (const f of outOfScopeFindings) {
			lines.push(
				`- [${f.severity}] ${f.file}:${f.lineStart || "?"} — ${f.description} (out-of-scope)`,
			);
		}
	}

	if (groundedFindings.length > 0) {
		lines.push("");
		lines.push("Grounded findings (file verified against diff and worktree):");
		for (const f of groundedFindings) {
			const lineAnnotation =
				f.lineVerified === false
					? " (cited line does not match the worktree — treat the line as approximate, verify by content)"
					: "";
			lines.push(
				`- [${f.severity}] ${f.file}:${f.lineStart || "?"} — ${f.description}${lineAnnotation}`,
			);
		}
	}

	return lines.join("\n");
}

function attachGroundedFindings(criticResults, findings) {
	for (const result of criticResults) {
		const groundedFindings = findings.filter(
			(finding) =>
				finding.foundBy === result.provider || (finding.agreedBy || []).includes(result.provider),
		);
		if (groundedFindings.length > 0) result.groundedFindings = groundedFindings;
	}
}

function compactOneLine(value) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim();
}

function numberDebateFindings(findings) {
	return findings
		.filter((finding) => finding.grounding === "grounded" || finding.grounding === "out_of_scope")
		.map((finding, index) => ({ number: index + 1, finding }));
}

function peerDebateFindings(provider, numberedFindings) {
	return numberedFindings.filter(({ finding }) => finding.foundBy !== provider);
}

function formatDebateFinding({ number, finding }) {
	return `#${number} [${finding.severity}] ${finding.file}:${finding.lineStart || "?"} (${finding.category}) — ${compactOneLine(finding.description)}`;
}

function buildRebuttalPrompt(provider, numberedFindings) {
	const peerFindings = peerDebateFindings(provider, numberedFindings);
	return [
		"# Cross-examination round",
		"",
		"Review the surviving findings submitted by the other critics. Do not re-review the full diff.",
		"For each numbered finding below, vote endorse, refute, or unsure. Give one concrete one-line reason.",
		"",
		...peerFindings.map(formatDebateFinding),
		"",
		'The "vote" value must be exactly "endorse", "refute", or "unsure".',
		"Reply with strict JSON and nothing else:",
		'{"votes":[{"finding":1,"vote":"endorse","reason":"<one line>"}]}',
	].join("\n");
}

function parseRebuttalVotes(output, knownFindingNumbers) {
	const text = String(output || "").trim();
	if (!text) return [];
	const candidates = [text];
	for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
		candidates.push(match[1].trim());
	}
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.push(trimmed);
	}

	let values = null;
	for (let index = candidates.length - 1; index >= 0; index--) {
		try {
			const parsed = JSON.parse(candidates[index]);
			if (Array.isArray(parsed?.votes)) {
				values = parsed.votes;
				break;
			}
		} catch {}
	}
	if (!values) return [];

	const known = new Set(knownFindingNumbers);
	const seen = new Set();
	const votes = [];
	for (const value of values) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const finding = Number(value.finding);
		const vote = String(value.vote || "").toLowerCase();
		const reason = compactOneLine(value.reason);
		if (
			!Number.isInteger(finding) ||
			!known.has(finding) ||
			seen.has(finding) ||
			!["endorse", "refute", "unsure"].includes(vote) ||
			typeof value.reason !== "string" ||
			!reason
		) {
			continue;
		}
		seen.add(finding);
		votes.push({ finding, vote, reason });
	}
	return votes;
}

function aggregateDebateVotes(numberedFindings, criticVotes) {
	const byNumber = new Map(numberedFindings.map((entry) => [entry.number, entry.finding]));
	for (const { finding } of numberedFindings) {
		finding.endorsedBy = [];
		finding.refutedBy = [];
		finding.unsureBy = [];
		finding.voteReasons = {};
	}

	for (const response of criticVotes) {
		for (const vote of response.votes || []) {
			const finding = byNumber.get(vote.finding);
			if (!finding || finding.foundBy === response.critic) continue;
			const field =
				vote.vote === "endorse"
					? "endorsedBy"
					: vote.vote === "refute"
						? "refutedBy"
						: "unsureBy";
			if (!finding[field].includes(response.critic)) finding[field].push(response.critic);
			finding.voteReasons[response.critic] = vote.reason;
		}
	}
	return numberedFindings.map(({ finding }) => finding);
}

function mergeDebateSignalsIntoAggregatedFindings(aggregatedFindings, criticFindings) {
	for (const finding of aggregatedFindings) {
		if (finding.grounding === "fabricated") continue;
		const signature = `${normalizeDiffPath(finding.file)}:${Math.floor(finding.lineStart / 20)}`;
		const matches = criticFindings.filter(
			(candidate) =>
				candidate.grounding !== "fabricated" &&
				`${normalizeDiffPath(candidate.file)}:${Math.floor(candidate.lineStart / 20)}` === signature,
		);
		finding.endorsedBy = [...new Set(matches.flatMap((candidate) => candidate.endorsedBy || []))];
		finding.refutedBy = [...new Set(matches.flatMap((candidate) => candidate.refutedBy || []))];
		finding.unsureBy = [...new Set(matches.flatMap((candidate) => candidate.unsureBy || []))];
		finding.voteReasons = Object.assign(
			{},
			...matches.map((candidate) => candidate.voteReasons || {}),
		);
	}
}

function tallyDebateFindings(findings) {
	return {
		endorsed: findings.filter((finding) => (finding.endorsedBy || []).length > 0).length,
		refuted: findings.filter((finding) => (finding.refutedBy || []).length > 0).length,
		unsureOnly: findings.filter(
			(finding) =>
				(finding.unsureBy || []).length > 0 &&
				(finding.endorsedBy || []).length === 0 &&
				(finding.refutedBy || []).length === 0,
		).length,
	};
}

function formatDebateVoters(critics, voteReasons, includeReasons = false) {
	return critics
		.map((critic) => {
			const reason = includeReasons ? compactOneLine(voteReasons?.[critic]).replaceAll('"', "'") : "";
			return reason ? `${critic} ("${reason}")` : critic;
		})
		.join(", ");
}

function buildDebateJudgeSection(numberedFindings) {
	const lines = [
		"## Cross-examination evidence",
		"",
		"Cross-family endorsement is strong corroboration. A refute with a concrete reason deserves a direct check. Votes are evidence pointers, not a ballot; independently verify every finding and render the final verdict yourself.",
		"",
	];
	let rendered = 0;
	for (const entry of numberedFindings) {
		const { finding } = entry;
		const signals = [];
		if ((finding.endorsedBy || []).length > 0) {
			signals.push(`endorsed by: ${formatDebateVoters(finding.endorsedBy, finding.voteReasons)}`);
		}
		if ((finding.refutedBy || []).length > 0) {
			signals.push(
				`refuted by: ${formatDebateVoters(finding.refutedBy, finding.voteReasons, true)}`,
			);
		}
		if ((finding.unsureBy || []).length > 0) {
			signals.push(`unsure: ${formatDebateVoters(finding.unsureBy, finding.voteReasons)}`);
		}
		if (signals.length === 0) continue;
		lines.push(`- ${formatDebateFinding(entry)} · ${signals.join(" · ")}`);
		rendered++;
	}
	if (rendered === 0) lines.push("No critic returned a parseable peer vote.");
	return lines.join("\n");
}

async function runDebateRound(criticResults, criticFindings, tier, debateOverride) {
	const numberedFindings = numberDebateFindings(criticFindings);
	const producingCritics = new Set(numberedFindings.map(({ finding }) => finding.foundBy));
	const participants = criticResults.filter(
		(result) => result.ok && !result.criticNoOutput && result.output?.trim(),
	);
	const emptyTallies = { endorsed: 0, refuted: 0, unsureOnly: 0 };
	if (!shouldRunDebate(tier, debateOverride, producingCritics.size)) {
		return { enabled: false, tallies: emptyTallies, numberedFindings: [] };
	}

	process.stderr.write(
		`  [debate] cross-examining ${numberedFindings.length} findings across ${participants.length} critics\n`,
	);
	const settled = await Promise.allSettled(
		participants.map(async ({ provider }) => {
			const peerFindings = peerDebateFindings(provider, numberedFindings);
			const config = getProviderConfig(provider, "consult");
			if (!config) {
				return {
					critic: provider,
					result: { ok: false, output: "", error: `Unknown provider: ${provider}`, durationMs: 0 },
					votes: [],
				};
			}
			const result = normalizeProviderFailure(
				await spawnCriticOnce(
					provider,
					{ ...config, minTimeout: DEBATE_TIMEOUT_MS, twoPass: false },
					buildRebuttalPrompt(provider, numberedFindings),
					DEBATE_TIMEOUT_MS,
				),
			);
			const votes = result.ok
				? parseRebuttalVotes(
						result.output,
						peerFindings.map((entry) => entry.number),
					)
				: [];
			return { critic: provider, result, votes };
		}),
	);

	const responses = settled.map((entry, index) =>
		entry.status === "fulfilled"
			? entry.value
			: {
					critic: participants[index]?.provider || "unknown",
					result: {
						ok: false,
						output: "",
						error: entry.reason?.message || String(entry.reason),
						durationMs: 0,
					},
					votes: [],
				},
	);
	for (const response of responses) {
		const duration = ((response.result.durationMs || 0) / 1000).toFixed(1);
		if (!response.result.ok) {
			process.stderr.write(
				`  [debate:${response.critic}] FAIL ${duration}s → no votes (${compactOneLine(response.result.error).slice(0, 200)})\n`,
			);
		} else if (response.votes.length === 0) {
			process.stderr.write(
				`  [debate:${response.critic}] OK ${duration}s → no parseable votes\n`,
			);
		} else {
			process.stderr.write(
				`  [debate:${response.critic}] OK ${duration}s → ${response.votes.length} votes\n`,
			);
		}
	}

	aggregateDebateVotes(numberedFindings, responses);
	const tallies = tallyDebateFindings(numberedFindings.map(({ finding }) => finding));
	process.stderr.write(
		`  [debate] ${tallies.endorsed} endorsed, ${tallies.refuted} refuted, ${tallies.unsureOnly} unsure-only\n`,
	);
	return { enabled: true, tallies, numberedFindings };
}

function summarizeCurrentRunReliability(findings) {
	const records = [];
	for (const finding of findings) {
		for (const critic of new Set([finding.foundBy, ...(finding.agreedBy || [])])) {
			if (!critic) continue;
			records.push({
				runId: "current-run",
				critic,
				category: finding.category || "other",
				judgeDisposition: null,
				grounding: finding.grounding,
			});
		}
	}
	return summarizeCriticReliability(records);
}

function buildReliabilityPromptSection(
	reliability,
	{
		lastRuns = RELIABILITY_LAST_RUNS,
		minSamples = RELIABILITY_MIN_SAMPLES,
		quarantineWarnings = [],
	} = {},
) {
	if (
		!hasSufficientReliabilityData(reliability, minSamples) &&
		quarantineWarnings.length === 0
	) {
		return "";
	}
	let table = formatReliabilityTable(reliability, { minSamples });
	if (!table && quarantineWarnings.length > 0) {
		table = [
			"critic | all",
			"--- | ---",
			...quarantineWarnings.map((critic) => `${critic} | insufficient data`),
		].join("\n");
	}
	const degraded =
		quarantineWarnings.length > 0
			? `\nDegraded seat(s): ${quarantineWarnings.join(", ")} exceeded the fabrication threshold over the last ${QUARANTINE_LAST_RUNS} runs.`
			: "";
	return [
		`## Critic reliability (last ${lastRuns} runs, this repository)`,
		"",
		table,
		degraded,
		"Weigh critics accordingly: a critic with a low confirmation rate in a category has often been wrong in exactly this way before. This is context, not a verdict — a low-reliability critic can still be right today.",
	].join("\n");
}

function addLineRef(lineRefs, filePath, lineNumber) {
	const normalizedFile = normalizeDiffPath(filePath);
	if (
		!normalizedFile ||
		normalizedFile === "/dev/null" ||
		!Number.isFinite(lineNumber) ||
		lineNumber <= 0
	) {
		return;
	}
	if (!lineRefs.has(normalizedFile)) {
		lineRefs.set(normalizedFile, new Set());
	}
	lineRefs.get(normalizedFile).add(lineNumber);
}

function extractLineRefsFromCritics(criticResults, aggregatedFindings = []) {
	const lineRefs = new Map();

	for (const finding of aggregatedFindings || []) {
		if (finding.file && finding.lineStart > 0) {
			addLineRef(lineRefs, finding.file, finding.lineStart);
		}
	}

	const fileLinePattern = /([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]{1,8})(?::|#L|\s+L|\s+line\s+)(\d+)/gi;
	const fileNearLinePattern =
		/([a-zA-Z0-9_\-/.]+\.[a-zA-Z0-9]{1,8}).{0,80}?\b(?:line|L)\s*:?\s*(\d+)/gi;

	for (const result of criticResults) {
		if (!result.ok || result.criticNoOutput || !result.output) continue;

		for (const finding of extractStructuredFindings(result.output)) {
			if (finding.file && finding.lineStart > 0) {
				addLineRef(lineRefs, finding.file, finding.lineStart);
			}
		}

		for (const line of result.output.split("\n")) {
			for (const match of line.matchAll(fileLinePattern)) {
				addLineRef(lineRefs, match[1], Number.parseInt(match[2], 10));
			}
			for (const match of line.matchAll(fileNearLinePattern)) {
				addLineRef(lineRefs, match[1], Number.parseInt(match[2], 10));
			}
		}
	}

	return lineRefs;
}

function refsForFile(lineRefs, filePath) {
	const normalizedFile = normalizeDiffPath(filePath);
	return (
		lineRefs.get(normalizedFile) ||
		[...lineRefs.entries()].find(
			([refFile]) =>
				normalizedFile.endsWith(`/${refFile}`) || refFile.endsWith(`/${normalizedFile}`),
		)?.[1] ||
		null
	);
}

function lineWithinRefs(lineNumber, refs) {
	for (const ref of refs) {
		if (Math.abs(lineNumber - ref) <= OPUS_DIFF_CONTEXT_LINES) {
			return true;
		}
	}
	return false;
}

function truncateHunkToRefs(header, hunkLines, refs) {
	const headerMatch = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!headerMatch) return [];

	let oldLine = Number.parseInt(headerMatch[1], 10);
	let newLine = Number.parseInt(headerMatch[2], 10);
	const selected = [];
	let skippedBefore = false;

	for (const line of hunkLines) {
		const marker = line[0];
		const comparableLine =
			marker === "-" ? oldLine : marker === "+" || marker === " " ? newLine : null;
		const includeLine = comparableLine !== null && lineWithinRefs(comparableLine, refs);

		if (includeLine) {
			if (skippedBefore && selected[selected.length - 1] !== "[... hunk trimmed ...]") {
				selected.push("[... hunk trimmed ...]");
			}
			selected.push(line);
			skippedBefore = false;
		} else if (selected.length > 0) {
			skippedBefore = true;
		}

		if (marker === " " || marker === "-") oldLine++;
		if (marker === " " || marker === "+") newLine++;
	}

	if (skippedBefore && selected[selected.length - 1] !== "[... hunk trimmed ...]") {
		selected.push("[... hunk trimmed ...]");
	}

	return selected.length > 0 ? [header, ...selected] : [];
}

function truncateDiffToLineRefs(diff, lineRefs) {
	const lines = diff.split("\n");
	const output = [];
	let currentFile = null;
	let fileHeader = [];
	let hunkHeader = null;
	let hunkLines = [];
	let fileHadOutput = false;

	const flushHunk = () => {
		if (!hunkHeader || !currentFile) return;
		const refs = refsForFile(lineRefs, currentFile);
		if (!refs) {
			hunkHeader = null;
			hunkLines = [];
			return;
		}

		const truncatedHunk = truncateHunkToRefs(hunkHeader, hunkLines, refs);
		if (truncatedHunk.length === 0) {
			hunkHeader = null;
			hunkLines = [];
			return;
		}

		if (!fileHadOutput) {
			if (output.length > 0 && output[output.length - 1] !== "") output.push("");
			output.push(...fileHeader);
			fileHadOutput = true;
		}
		output.push(...truncatedHunk);
		hunkHeader = null;
		hunkLines = [];
	};

	const startFile = (line) => {
		flushHunk();
		currentFile = null;
		fileHeader = [line];
		fileHadOutput = false;
	};

	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			startFile(line);
			continue;
		}

		if (fileHeader.length > 0 && line.startsWith("+++ ")) {
			fileHeader.push(line);
			const match = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
			if (match) {
				if (match[1] === "/dev/null") {
					const minusLine = fileHeader.find((l) => l.startsWith("--- "));
					if (minusLine) {
						const minusMatch = minusLine.match(/^--- (?:a\/)?(.+)$/);
						if (minusMatch && minusMatch[1] !== "/dev/null")
							currentFile = normalizeDiffPath(minusMatch[1]);
					}
				} else {
					currentFile = normalizeDiffPath(match[1]);
				}
			}
			continue;
		}

		if (fileHeader.length > 0 && !hunkHeader && !line.startsWith("@@ ")) {
			fileHeader.push(line);
			if (!currentFile) {
				const diffMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/);
				if (diffMatch) currentFile = normalizeDiffPath(diffMatch[2]);
			}
			continue;
		}

		if (line.startsWith("@@ ")) {
			flushHunk();
			hunkHeader = line;
			hunkLines = [];
			continue;
		}

		if (hunkHeader) {
			hunkLines.push(line);
			continue;
		}

		if (fileHeader.length === 0) {
			fileHeader.push(line);
		}
	}

	flushHunk();
	return output.join("\n").trim();
}

function getOpusDiffForContext(diff, criticResults, aggregatedFindings = []) {
	const criticOutputChars = criticResults
		.filter((result) => result.ok)
		.reduce(
			(sum, result) => sum + Math.min(result.output?.length || 0, MAX_CRITIC_OUTPUT_CHARS),
			0,
		);

	if (criticOutputChars + diff.length <= OPUS_CONTEXT_CHAR_LIMIT) {
		return diff;
	}

	const lineRefs = extractLineRefsFromCritics(criticResults, aggregatedFindings);
	if (lineRefs.size === 0) {
		return diff;
	}

	const truncatedDiff = truncateDiffToLineRefs(diff, lineRefs);
	if (!truncatedDiff) {
		return diff;
	}

	const refCount = [...lineRefs.values()].reduce((sum, refs) => sum + refs.size, 0);
	return [
		`TRUNCATED — showing only critic-flagged regions (±${OPUS_DIFF_CONTEXT_LINES} lines around ${refCount} referenced line${refCount === 1 ? "" : "s"})`,
		`Full diff exceeded ${OPUS_CONTEXT_CHAR_LIMIT} characters when combined with critic outputs.`,
		"",
		truncatedDiff,
	].join("\n");
}

function buildOpusContext(diff, criticResults, aggregatedFindings, groundingSummary) {
	const maxCriticChars = MAX_CRITIC_OUTPUT_CHARS;
	const diffForContext = getOpusDiffForContext(diff, criticResults, aggregatedFindings);
	const criticSummaries = criticResults
		.filter((r) => r.ok)
		.map((r) => {
			const verdict = tallyCriticVerdict(r);
			const providerName = r.provider;
			const specialtyLabel = getSpecialization(r.provider)?.label;
			const specialty = specialtyLabel ? ` (Specialty: ${specialtyLabel})` : "";
			const output =
				r.output.length > maxCriticChars
					? `${r.output.slice(0, maxCriticChars)}\n[... output truncated for context budget ...]`
					: r.output;
			return [
				`=== ${providerName}${specialty} — ${verdict.decision.toUpperCase()} ===`,
				`Time: ${(r.durationMs / 1000).toFixed(1)}s`,
				``,
				output,
			].join("\n");
		})
		.join("\n\n");

	const groundingSection = groundingSummary
		? [
				``,
				`## Grounding Verification`,
				``,
				`Findings were mechanically verified against the diff and worktree before this review.`,
				groundingSummary,
				``,
				`---`,
				``,
			].join("\n")
		: "";

	return [
		`# Code Review — Phase 2: Deep Analysis`,
		``,
		`## Your Role`,
		`Independent reviewers examined the diff below. Their findings follow.`,
		`Your job is threefold:`,
		``,
		`1. **VERIFY each finding** — Is it a real issue or a false positive?`,
		`   Cross-reference against the actual diff. If a reviewer claims a bug at line X,`,
		`   check line X. Dismiss false positives with a one-line explanation.`,
		``,
		`2. **DEEP-DIVE into flagged areas** — The reviewers identified suspicious code areas.`,
		`   Investigate those vicinities for RELATED issues they may have missed.`,
		`   This is where you add the most value — use their findings as attention pointers.`,
		``,
		`3. **GAP-SCAN** — After reviewing all flagged areas, scan for issues all reviewers`,
		`   missed. Apply the configured project concerns and architecture rules, plus common`,
		`   security, correctness, reliability, and API-contract risks.`,
		``,
		`## Response Format`,
		``,
		`Your response MUST begin with exactly one of:`,
		`  ALLOW: <one-line reason>`,
		`  BLOCK: <one-line reason>`,
		``,
		`Then provide:`,
		``,
		`### Verified Findings`,
		`For each Phase 1 finding, state: CONFIRMED, DISMISSED (with reason), or ESCALATED (severity upgrade).`,
		``,
		`### Deep-Dive Discoveries`,
		`Any new issues you found by investigating the areas the critics flagged. Include file, line, severity, category.`,
		``,
		`### Gap-Scan Results`,
		`Any issues you found that no critic flagged. Include file, line, severity, category.`,
		`If none found, say "No additional issues found."`,
		groundingSection,
		`---`,
		``,
		`## Phase 1 Reviewer Outputs`,
		``,
		criticSummaries,
		``,
		`---`,
		``,
		`## Diff Under Review`,
		``,
		"```diff",
		diffForContext,
		"```",
	].join("\n");
}

function buildJudgeInstructions(
	diffFile,
	criticFiles,
	groundingFile,
	bashTier = false,
	reliabilityContext = "",
) {
	const fileList = criticFiles
		.map((c) => `  - **${c.name}** (Specialty: ${c.specialty}) — ${c.verdict}: \`${c.file}\``)
		.join("\n");
	const groundingLine = groundingFile
		? `\n**Grounding and cross-examination evidence:** \`${groundingFile}\`\n`
		: "";

	const bashSuggestions = bashTier
		? [
				"",
				"## Verification Tools (Bash tier — execution enabled)",
				"",
				"You have access to Bash. Use it to verify findings concretely:",
				"- Run the project's test command on the affected files: `npm test -- path/to/file`",
				"- Execute a small repro snippet to confirm a logic bug.",
				"- Grep for the pattern the critic claims exists: `grep -n pattern file`.",
				"- Search for other callers that share the same defect.",
				"",
				"Every VERIFIED finding you uphold must cite the command you ran and the result.",
			].join("\n")
		: "";

	const toolSearch = !bashTier
		? [
				"",
				"## Verification Tools (STANDARD tier — search enabled)",
				"",
				"You have Grep and Glob tools. Use them to find the actual code paths,",
				"trace callers, and confirm the files and line numbers a critic cites are real.",
				"Read the referenced files and search for patterns to verify or dismiss each finding.",
			].join("\n")
		: "";

	return [
		"# Code Review — Phase 2: Deep Analysis",
		"",
		"## Your Role",
		"Independent specialized reviewers examined a code diff. Their review outputs are in separate files.",
		"Each reviewer has a labeled specialty — weight their findings higher in their domain.",
		"",
		...(reliabilityContext ? [reliabilityContext, ""] : []),
		"## Files to Read",
		"",
		`**Diff under review:** \`${diffFile}\``,
		groundingLine,
		"**Reviewer outputs:**",
		fileList,
		"",
		"IMPORTANT: Use your Read tool to read ALL files listed above before proceeding.",
		"Read all files in your first turn to minimize round-trips.",
		toolSearch,
		bashSuggestions,
		"",
		"## Your Task",
		"",
		"1. **VERIFY each finding** — Is it a real issue or a false positive?",
		"   Cross-reference against the actual diff. If a reviewer claims a bug at line X,",
		"   check line X. Dismiss false positives with a one-line explanation.",
		"",
		"2. **DEEP-DIVE into flagged areas** — The reviewers identified suspicious code areas.",
		"   Investigate those vicinities for RELATED issues they may have missed.",
		"   This is where you add the most value — use their findings as attention pointers.",
		"",
		"3. **GAP-SCAN** — After reviewing all flagged areas, scan for issues all reviewers",
		"   missed. Apply the configured project concerns and architecture rules, plus common",
		"   security, correctness, reliability, and API-contract risks.",
		"",
		"## Finding Verification Labels (REQUIRED)",
		"",
		"For every blocking finding (P0/P1) you uphold, you MUST label it:",
		"- **VERIFIED** — You read the actual code path, searched the repo, or ran a command",
		"  that demonstrates the issue. Include the one-line evidence: the command run or the",
		"  file:line trace.",
		"- **UNVERIFIED** — Upheld on plausibility alone (the critic's description sounds",
		"  plausible but you could not independently confirm with an actual code trace).",
		"",
		"DISMISSED findings do not need a VERIFIED/UNVERIFIED label.",
		"",
		"## Verdict Format",
		"",
		"The verdict line MUST carry a split count when P0/P1 findings are present,",
		'e.g. `BLOCK: cache refresh can overwrite newer data [2 verified, 1 unverified]`.',
		"When no blocking findings exist, a bare `ALLOW: <reason>` is sufficient.",
		"",
		"## Response Format",
		"",
		"You MAY open with a one-line synthesis preamble. Regardless of any preamble, your verdict MUST appear in BOTH canonical, machine-readable forms below — this is exactly how the gate reads your decision:",
		"",
		"1. A verdict HEADING line, exactly one of (note the required `## ` markdown prefix):",
		"     ## ALLOW: <one-line reason>",
		"     ## BLOCK: <one-line reason>",
		"   A bare `ALLOW:`/`BLOCK:` line WITHOUT the `## ` prefix (e.g. after a preamble) will NOT be recognized and the gate will fail CLOSED (treated as BLOCK).",
		"",
		"2. The VERY LAST line of your entire response: a standalone JSON object on its own line, NOT inside a code fence, with nothing after it:",
		'     {"decision":"allow","reason":"<one-line reason>"}',
		'   or {"decision":"block","reason":"<one-line reason>"}',
		"   No sign-off, prose, or code fence may follow this final JSON line.",
		"",
		"The `## ` heading and the final JSON line MUST agree (both allow, or both block). If they disagree the gate fails CLOSED and treats it as BLOCK.",
		"",
		"Between the heading and the final JSON line, provide:",
		"",
		"### Verified Findings",
		"For each Phase 1 finding, state: CONFIRMED, DISMISSED (with reason), or ESCALATED (severity upgrade).",
		"For every P0/P1 finding you CONFIRM, append the VERIFIED or UNVERIFIED label with evidence.",
		"",
		"### Deep-Dive Discoveries",
		"Any new issues you found by investigating the areas the critics flagged. Include file, line, severity, category.",
		"",
		"### Gap-Scan Results",
		"Any issues you found that no critic flagged. Include file, line, severity, category.",
		'If none found, say "No additional issues found."',
	].join("\n");
}

function createDisposableWorkspace() {
	const tmpDir = path.join(tmpdir(), `council-judge-${Date.now()}`);
	try {
		execFileSync("git", ["worktree", "add", "--detach", tmpDir], {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			stdio: "pipe",
		});
	} catch (err) {
		process.stderr.write(
			`  [judge] Disposable workspace creation failed (git worktree): ${err.message}; falling back to STANDARD tool set.\n`,
		);
		return null;
	}

	const repoNodeModules = path.join(process.cwd(), "node_modules");
	if (existsSync(repoNodeModules)) {
		const workspaceNodeModules = path.join(tmpDir, "node_modules");
		try {
			if (process.platform === "win32") {
				execFileSync("cmd", ["/c", "mklink", "/J", workspaceNodeModules, repoNodeModules], {
					stdio: "pipe",
				});
		} else {
			symlinkSync(repoNodeModules, workspaceNodeModules, "dir");
		}
		} catch {
			// Non-fatal: the judge can still search files but can't run npm-dependent commands.
		}
	}

	return tmpDir;
}

function removeDisposableWorkspace(workspacePath) {
	try {
		execFileSync("git", ["worktree", "remove", "--force", workspacePath], {
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			stdio: "pipe",
		});
	} catch (err) {
		process.stderr.write(
			`  [judge] Warning: failed to remove disposable workspace ${workspacePath}: ${err.message}\n`,
		);
	}
}

async function spawnJudgeWithFiles(diff, criticResults, judgeEffort = "high", groundingContext, judgeOptions = {}) {
	const judgeTools = Array.isArray(judgeOptions.judgeTools) && judgeOptions.judgeTools.length > 0
		? judgeOptions.judgeTools
		: ["Read"];

	let effectiveTools = [...judgeTools];
	let workspacePath = null;
	let usedWorkspace = false;

	if (effectiveTools.includes("Bash")) {
		workspacePath = createDisposableWorkspace();
		if (!workspacePath) {
			effectiveTools = ["Read", "Grep", "Glob"];
		} else {
			usedWorkspace = true;
		}
	}

	const tempFiles = [];
	try {
		const diffFile = writeTempFile(diff, ".diff");
		tempFiles.push(diffFile);

		let groundingFile;
		if (groundingContext) {
			groundingFile = writeTempFile(groundingContext, ".md");
			tempFiles.push(groundingFile);
		}

		const criticFiles = [];
		for (const r of criticResults.filter((r) => r.ok && !r.criticNoOutput)) {
			const name = r.provider;
			const specialty = getSpecialization(r.provider)?.label || "General";
			const verdict = tallyCriticVerdict(r);
			const header = [
				`# ${name} Review`,
				`Specialty: ${specialty}`,
				`Verdict: ${verdict.decision.toUpperCase()}`,
				`Duration: ${(r.durationMs / 1000).toFixed(1)}s`,
				"",
				"---",
				"",
			].join("\n");
			const file = writeTempFile(header + r.output, ".md");
			tempFiles.push(file);
			criticFiles.push({ name, specialty, verdict: verdict.decision.toUpperCase(), file });
		}

		const judgeTimeoutSeconds = usedWorkspace
			? JUDGE_TIMEOUT_SECONDS * 2
			: JUDGE_TIMEOUT_SECONDS;
		const prompt = buildJudgeInstructions(
			diffFile,
			criticFiles,
			groundingFile,
			usedWorkspace,
			judgeOptions.reliabilityContext || "",
		);
		const result = await spawnCritic(
			"opusjudge",
			prompt,
			judgeTimeoutSeconds * 1000,
			"review",
			{
				judgeEffort,
				judgeTools: effectiveTools,
				judgeTimeoutSeconds,
				...(workspacePath ? { judgeCwd: workspacePath } : {}),
			},
		);
		return { ...result, provider: "judge", judgeTools: effectiveTools, judgeExecuted: usedWorkspace };
	} finally {
		for (const f of tempFiles) {
			try {
				unlinkSync(f);
			} catch {}
		}
		if (workspacePath) {
			removeDisposableWorkspace(workspacePath);
		}
	}
}

// Deterministic fallback verdict derived directly from the Phase 1 critics' own
// ALLOW/BLOCK lines. Used only when the judge fails to render a usable verdict
// (empty output or spawn failure) so a judge hiccup degrades to the critics' consensus
// instead of a false "Empty council output" block. Returns null if no critic succeeded.
function synthesizeFromCritics(criticResults) {
	const successful = criticResults.filter((r) => r.ok && !r.criticNoOutput && r.output?.trim());
	if (successful.length === 0) {
		return null;
	}
	const blockers = [];
	for (const r of successful) {
		const verdict = tallyCriticVerdict(r);
		if (verdict.decision === "block") {
			blockers.push(`[${r.provider}] ${verdict.reason}`);
		}
	}
	if (blockers.length > 0) {
		return {
			decision: "block",
			reason: `BLOCK (judge unavailable — critic fallback): ${blockers.length} critic(s) flagged blockers`,
			details: blockers.join("\n"),
		};
	}
	return {
		decision: "allow",
		reason: `ALLOW (judge unavailable — critic fallback): ${successful.length} critic(s) found no blockers`,
	};
}

function hasSuccessfulCriticReview(criticResults) {
	return criticResults.some(
		(result) => result.ok && !result.criticNoOutput && result.output?.trim(),
	);
}

async function runCouncilReview(diff, branchInfo, critics = PHASE1_CRITICS, judgeEffort = "high", judgeOptions = {}) {
	const memory = loadRelevantMemory(diff);

	const criticResults = await runCriticsParallel(
		critics,
		branchInfo,
		diff,
		TIMEOUT_SECONDS * 1000,
		memory,
	);
	for (const result of criticResults.filter(
		(result) => result.ok && !result.criticNoOutput && result.output?.trim(),
	)) {
		tallyCriticVerdict(result, true);
	}

	const aggregated = aggregateFindings(criticResults);
	const criticFindings = collectCriticFindings(criticResults);

	// Grounding pass: validate finding citations against diff and worktree
	const { counts: groundingCounts, fabricatedByCritic } = runGroundingPass(aggregated, diff);
	runGroundingPass(criticFindings, diff);
	const groundingSummary = buildGroundingPromptSection(aggregated, fabricatedByCritic);
	process.stderr.write(
		`  [grounding] ${groundingCounts.grounded} grounded, ${groundingCounts.out_of_scope} out-of-scope, ${groundingCounts.fabricated} fabricated` +
			(fabricatedByCritic.size > 0
				? ` (${[...fabricatedByCritic].map(([c, n]) => `${c}:${n}`).join(", ")})`
				: "") +
			"\n",
	);
	const debate = await runDebateRound(
		criticResults,
		criticFindings,
		judgeOptions.tier,
		judgeOptions.debate,
	);
	if (debate.enabled) {
		mergeDebateSignalsIntoAggregatedFindings(aggregated, criticFindings);
	}
	attachGroundedFindings(criticResults, criticFindings);

	// Exclude fabricated findings from the judge's view
	const judgeEvidenceSections = [];
	const hasUnverifiedLines = aggregated.some(
		(finding) => finding.grounding === "grounded" && finding.lineVerified === false,
	);
	if (groundingCounts.fabricated > 0 || groundingCounts.out_of_scope > 0 || hasUnverifiedLines) {
		judgeEvidenceSections.push(
			`## Grounding Verification\n\nFindings were mechanically verified against the diff and worktree before this review.\n${groundingSummary}`,
		);
	}
	if (debate.enabled) {
		judgeEvidenceSections.push(buildDebateJudgeSection(debate.numberedFindings));
	}
	const judgeGroundingContext = judgeEvidenceSections.join("\n\n") || undefined;
	const ledgerPath = path.join(getMainWorktreeRoot(), LOG_DIR, "ledger.jsonl");
	const reliability = computeCriticReliability(ledgerPath, {
		lastRuns: RELIABILITY_LAST_RUNS,
	});
	const quarantineReliability = mergeCriticReliability(
		computeCriticReliability(ledgerPath, { lastRuns: QUARANTINE_LAST_RUNS - 1 }),
		summarizeCurrentRunReliability(criticFindings),
	);
	const activeCritics = new Set(criticResults.map((result) => result.provider));
	const quarantineCandidates = findQuarantinedCritics(quarantineReliability).filter((candidate) =>
		activeCritics.has(candidate.critic),
	);
	const quarantineWarnings = quarantineCandidates.map((candidate) => candidate.critic);
	for (const candidate of quarantineCandidates) {
		process.stderr.write(
			`  [reliability] WARNING: critic ${candidate.critic} fabricated ${candidate.fabricated}/${candidate.findings} citations over the last ${QUARANTINE_LAST_RUNS} runs — seat is degraded; consider removing it from the roster\n`,
		);
	}
	const reliabilityContext = buildReliabilityPromptSection(reliability, {
		quarantineWarnings,
	});

	let opusResult = await spawnJudgeWithFiles(diff, criticResults, judgeEffort, judgeGroundingContext, {
		...judgeOptions,
		reliabilityContext,
	});
	let finalVerdict = parseVerdict(opusResult.output);
	let judgeUnavailableInfra = false;
	let judgeRetried = false;

	// A transient judge failure (529/unparseable) is retried once after 60 seconds.
	if (isJudgeTransientFailure(opusResult)) {
		judgeRetried = true;
		console.error(
			`  [judge] transient failure (${opusResult.error || "empty/unparseable output"}); retrying once after ${JUDGE_TRANSIENT_RETRY_DELAY_MS / 1000}s...`,
		);
		await delay(JUDGE_TRANSIENT_RETRY_DELAY_MS);
		opusResult = await spawnJudgeWithFiles(diff, criticResults, judgeEffort, judgeGroundingContext, {
			...judgeOptions,
			reliabilityContext,
		});
		finalVerdict = parseVerdict(opusResult.output);
	}

	if (judgeRetried && isJudgeTransientFailure(opusResult)) {
		judgeUnavailableInfra = true;
		finalVerdict = {
			decision: "block",
			reason: `judge_unavailable (infra): ${opusResult.error || "judge produced no usable verdict after retry"}`,
			details: "Council judge did not produce a review. Resolve the infra error before merging.",
		};
	} else if (!opusResult.ok || !opusResult.output?.trim()) {
		// The judge can fail to render a verdict (spawn failure, or empty output from a
		// disrupted turn). Rather than emit a useless "Empty council output" block that
		// discards the critics' work, fall back to a deterministic verdict synthesized
		// from the critics' own ALLOW/BLOCK lines.
		const fallback = synthesizeFromCritics(criticResults);
		if (fallback) {
			console.error(
				`  [judge] No usable verdict (${opusResult.ok ? "empty output" : opusResult.error || "spawn failure"}); using deterministic critic fallback → ${fallback.decision.toUpperCase()}`,
			);
			finalVerdict = fallback;
		} else if (!opusResult.ok) {
			judgeUnavailableInfra = true;
			finalVerdict = {
				decision: "block",
				reason: `judge_unavailable (infra): ${opusResult.error || "judge spawn failure"}`,
				details: "Council judge did not produce a review. Resolve the infra error before merging.",
			};
		}
	} else if (isJudgeTransientFailure(opusResult)) {
		judgeUnavailableInfra = true;
		finalVerdict = {
			decision: "block",
			reason: `judge_unavailable (infra): judge verdict unparseable after retry`,
			details: finalVerdict.details || "Inspect the raw council log before merging.",
		};
	}

	if (judgeUnavailableInfra) {
		console.error("  [judge] judge_unavailable (infra)");
	}

	// A reduced tier must never turn one flaky/no-output critic into an unreviewed ALLOW.
	// The judge still runs and its receipt is preserved, but zero usable Phase-1 reviews
	// fail closed regardless of the judge's prose verdict.
	if (!hasSuccessfulCriticReview(criticResults)) {
		finalVerdict = {
			decision: "block",
			reason: "BLOCK: no council critic produced a usable review",
			details: "At least one configured critic must complete before the council can allow a diff.",
		};
	}

	// A permanent judge auth failure keeps the critic fallback verdict (it has served us well) but
	// is flagged so main() can exit with a distinct code and the receipt can mark the verdict as a
	// degraded fallback rather than a judge sign-off.
	const judgeAuthFailed = isJudgeAuthFailure(opusResult);
	if (judgeAuthFailed) {
		console.error(
			`  [judge] judge_auth_failed — verdict below is a critic-only fallback (${finalVerdict.decision.toUpperCase()}); re-authenticate and re-run`,
		);
	}

	writeCouncilMemory(opusResult.output, criticResults);

	return {
		phase1: criticResults,
		phase2: opusResult,
		verdict: finalVerdict,
		aggregatedFindings: aggregated,
		debate,
		quarantineWarnings,
		judgeAuthFailed,
	};
}

// Classify a single candidate verdict line: strip leading markdown heading
// markers ("## ") and surrounding whitespace, then match a "BLOCK:" / "ALLOW:"
// prefix case-insensitively. Returns { decision, text } or null. Shared by the
// review_summary, drafts, and prose-heading collectors so every verdict source
// is normalized identically.
function classifyVerdictText(value) {
	if (typeof value !== "string") {
		return null;
	}
	const heading = value.trim().replace(/^#+\s*/, "");
	if (/^BLOCK:/i.test(heading)) {
		return { decision: "block", text: heading };
	}
	if (/^ALLOW:/i.test(heading)) {
		return { decision: "allow", text: heading };
	}
	return null;
}

function parseVerdict(output) {
	if (!output?.trim()) {
		return {
			decision: "block",
			reason: "Empty council output — blocking until judge produces a verdict.",
		};
	}

	let parsed = null;
	try {
		parsed = JSON.parse(output);
	} catch {
		// Not JSON — look for ALLOW/BLOCK in raw text
	}

	if (parsed && parsed.success === false) {
		const providerErrors = parsed.provider_errors
			? Object.entries(parsed.provider_errors)
					.map(([p, e]) => `${p}: ${e}`)
					.join("; ")
			: parsed.error || "unknown failure";
		return {
			decision: "block",
			reason: `BLOCK: Council failed — ${providerErrors}`,
			details: "Council did not produce a review. Fix provider errors before merging.",
		};
	}

	// Unambiguous explicit-reject envelopes always block.
	if (parsed?.output?.verdict === "reject") {
		return {
			decision: "block",
			reason: `Council verdict: reject (confidence: ${parsed.output.confidence ?? "?"})`,
			details: parsed.output.blocking_issues?.join("\n") || "",
		};
	}

	// Collect EVERY verdict signal from every source, tagged with origin, then
	// resolve heading-vs-structured disagreements before deciding block-first.
	// Some critics have written ALLOW prose under BLOCK headings, so a heading
	// alone is NOT authoritative. The structured decision (JSON decision line,
	// first-content-line prose lead, or envelope field) is the real signal.
	// On mismatch, log `verdict_mismatch` and use the structured decision.
	/** @type {Array<{decision: string, reason: string, details?: string, source: string}>} */
	const signals = [];

	// (a) Structured-envelope review_summary.
	/** @type {Array<{decision: string, reason: string, details?: string, source: string}>} */
	const envelopeSignals = [];
	if (parsed?.output?.review_summary) {
		const c = classifyVerdictText(String(parsed.output.review_summary));
		if (c) {
			envelopeSignals.push({
				decision: c.decision,
				reason: c.text,
				details:
					c.decision === "block" ? parsed.output.blocking_issues?.join("\n") || "" : undefined,
				source: "envelope",
			});
		}
	}

	// (b) Per-provider drafts envelope.
	if (parsed?.drafts) {
		for (const [provider, draft] of Object.entries(parsed.drafts)) {
			if (typeof draft !== "string") continue;
			const trimmedDraft = draft.trim();
			const c = classifyVerdictText(trimmedDraft);
			if (c) {
				const draftLines = trimmedDraft.split("\n");
				envelopeSignals.push({
					decision: c.decision,
					reason: `${provider}: ${draftLines[0].trim()}`,
					details: c.decision === "block" ? draftLines.slice(1).join("\n").trim() : undefined,
					source: "envelope",
				});
			}
		}
	}

	const text =
		typeof parsed?.output === "string"
			? parsed.output
			: parsed?.result?.text || parsed?.text || output;
	const lines = String(text).split("\n");

	// Mark code-fence regions so example verdicts inside ``` blocks are ignored.
	const inFence = Array.from({ length: lines.length }, () => false);
	let fenceOpen = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^(?:```|~~~)/.test(lines[i].trim())) {
			inFence[i] = true;
			fenceOpen = !fenceOpen;
			continue;
		}
		inFence[i] = fenceOpen;
	}

	// (c) Collect heading signals and prose-lead signals separately.
	/** @type {Array<{decision: string, reason: string, details?: string, source: string}>} */
	const headingSignals = [];
	/** @type {Array<{decision: string, reason: string, details?: string, source: string}>} */
	const proseLeadSignals = [];
	let sawContent = false;
	for (const [i, line] of lines.entries()) {
		if (inFence[i]) continue;
		const trimmed = line.trim();
		if (trimmed === "") continue;
		const isFirstContent = !sawContent;
		sawContent = true;

		if (trimmed.startsWith("#")) {
			// Markdown heading — a judge verdict heading or a critic section heading.
			const c = classifyVerdictText(trimmed);
			if (c) {
				headingSignals.push({
					decision: c.decision,
					reason: c.text,
					details:
						c.decision === "block"
							? lines
									.slice(i + 1)
									.join("\n")
									.trim()
							: undefined,
					source: "heading",
				});
			}
			continue;
		}

		if (isFirstContent) {
			// First non-heading, non-blank line — the prose lead that critics
			// MUST begin with ("ALLOW:" / "BLOCK:"). This is the structured
			// prose decision.
			const c = classifyVerdictText(trimmed);
			if (c) {
				proseLeadSignals.push({
					decision: c.decision,
					reason: c.text,
					details:
						c.decision === "block"
							? lines
									.slice(i + 1)
									.join("\n")
									.trim()
							: undefined,
					source: "prose_lead",
				});
			}
		}
		// Bare "BLOCK:"/"ALLOW:" buried in the body is NOT a verdict — skip.
	}

	// (d) Machine-readable JSON decision line (LAST non-fenced standalone).
	/** @type {Array<{decision: string, reason: string, details?: string, source: string}>} */
	const jsonSignals = [];
	for (let i = lines.length - 1; i >= 0; i--) {
		if (inFence[i]) continue;
		const candidate = lines[i].trim();
		if (!candidate.startsWith("{")) continue;
		let obj;
		try {
			obj = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!obj || typeof obj !== "object" || !("decision" in obj)) continue;
		const decision = String(obj.decision ?? "")
			.trim()
			.toLowerCase();
		if (decision === "block" || decision === "allow") {
			jsonSignals.push({
				decision,
				reason: obj.reason
					? `${decision.toUpperCase()}: ${obj.reason}`
					: `${decision.toUpperCase()}: judge decision=${decision}`,
				details: decision === "block" && obj.details ? String(obj.details) : undefined,
				source: "json",
			});
		}
		break;
	}

	// Assemble: structured signals (envelope + prose_lead + json) and heading
	// signals are collected separately for mismatch detection. But ALL signals
	// go into one pool for block-first resolution — a safety gate must never let
	// a structured ALLOW silently override a heading BLOCK.
	const structuredSignals = [...envelopeSignals, ...proseLeadSignals, ...jsonSignals];

	// Detect heading-vs-structured mismatch when critics write ALLOW
	// prose under BLOCK headings). Log a machine-visible warning so the
	// coordinator or judge can diagnose the conflict.
	const headingDecisions = new Set(headingSignals.map((s) => s.decision));
	const structuredDecisions = new Set(structuredSignals.map((s) => s.decision));
	if (
		headingDecisions.size > 0 &&
		structuredDecisions.size > 0 &&
		!headingDecisions.isSubsetOf(structuredDecisions) &&
		!structuredDecisions.isSubsetOf(headingDecisions)
	) {
		const hd = [...headingDecisions].join("/");
		const sd = [...structuredDecisions].join("/");
		process.stderr.write(
			`  [gate] verdict_mismatch: heading(s) say ${hd} but structured decision(s) say ${sd}\n`,
		);
	}

	// Merge ALL signals into one pool. Block-first on the union: any BLOCK wins
	// to preserve conservative resolution; else a clear ALLOW; else fail CLOSED.
	for (const s of [...structuredSignals, ...headingSignals]) signals.push(s);

	// Decide block-first on the preferred signals: any BLOCK wins; else a clear
	// ALLOW; else fail CLOSED.
	const blockSignal = signals.find((s) => s.decision === "block");
	if (blockSignal) {
		return {
			decision: "block",
			reason: blockSignal.reason,
			details: blockSignal.details || "",
		};
	}
	const allowSignal = signals.find((s) => s.decision === "allow");
	if (allowSignal) {
		return { decision: "allow", reason: allowSignal.reason };
	}

	// No recognizable verdict. Fail CLOSED — never silently ALLOW.
	return {
		decision: "block",
		reason: `BLOCK: judge verdict unparseable → failing CLOSED (treat as BLOCK). First line: ${lines[0]?.slice(0, 100)}`,
		details:
			'No recognizable "## BLOCK:"/"## ALLOW:" heading or {"decision":...} JSON line in the judge output. Inspect the raw council log before merging.',
	};
}

function toLogMetadata(logData) {
	const { criticFullOutputs, judgeFullOutput, ...meta } = logData;
	return meta;
}

function writeLog(logData) {
	try {
		const mainRoot = getMainWorktreeRoot();
		const baseDir = path.join(mainRoot, LOG_DIR);
		mkdirSync(baseDir, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const runDir = path.join(baseDir, timestamp);
		mkdirSync(runDir, { recursive: true });

		if (logData.criticFullOutputs) {
			for (const c of logData.criticFullOutputs) {
				const content = c.output || `(no output — ${c.error || "unknown error"})`;
				writeFileSync(path.join(runDir, `${c.provider}.md`), content, "utf8");
			}
		}
		if (logData.judgeFullOutput) {
			const judgeStderr = logData.judgeFullOutput.stderr || "";
			const content =
				logData.judgeFullOutput.output ||
				`(no output — ${logData.judgeFullOutput.error || "unknown error"})${judgeStderr ? `\n\nstderr:\n${judgeStderr}` : ""}`;
			writeFileSync(path.join(runDir, "judge.md"), content, "utf8");
		}

		const meta = toLogMetadata(logData);
		writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

		return runDir;
	} catch {
		return null;
	}
}

// Health dashboard over recent council runs. Reads meta.json from the log dir.
// Returns a process exit code.
function runStats(limit) {
	const baseDir = path.join(getMainWorktreeRoot(), LOG_DIR);
	let dirs = [];
	try {
		dirs = readdirSync(baseDir)
			.filter((d) => {
				try {
					return statSync(path.join(baseDir, d)).isDirectory();
				} catch {
					return false;
				}
			})
			.sort()
			.reverse()
			.slice(0, limit);
	} catch {
		// An empty installation still renders the complete dashboard shape.
	}
	const findingReliability = computeCriticReliability(path.join(baseDir, "ledger.jsonl"), {
		lastRuns: limit,
	});

	const critics = {};
	const verdicts = {};
	const judge = { healthy: 0, empty: 0, failed: 0, durations: [] };
	const findings = { total: 0, severity: {}, agreements: 0, fallbacks: 0 };
	const opencodePreflight = { passed: 0, failed: 0 };
	const rows = [];
	let first = null;
	let last = null;

	for (const d of dirs) {
		let m;
		try {
			m = JSON.parse(readFileSync(path.join(baseDir, d, "meta.json"), "utf8"));
		} catch {
			continue;
		}
		if (!first) first = m.timestamp;
		last = m.timestamp;

		const v = m.finalVerdict?.decision || "unknown";
		verdicts[v] = (verdicts[v] || 0) + 1;
		if ((m.finalVerdict?.reason || "").includes("critic fallback")) findings.fallbacks++;

		const cset = {};
		if (m.opencodePreflight === "passed") opencodePreflight.passed++;
		if (m.opencodePreflight === "failed") {
			opencodePreflight.failed++;
			cset.opencode = "EXCLUDED";
		}
		for (const c of m.phase1 || []) {
			if (!critics[c.provider]) critics[c.provider] = { ok: 0, fail: 0, durations: [], errors: {} };
			if (c.ok) {
				critics[c.provider].ok++;
				critics[c.provider].durations.push(c.durationMs);
				cset[c.provider] = `${Math.round(c.durationMs / 1000)}s`;
			} else {
				critics[c.provider].fail++;
				const key = (c.error || "unknown").slice(0, 50);
				critics[c.provider].errors[key] = (critics[c.provider].errors[key] || 0) + 1;
				cset[c.provider] = "FAIL";
			}
		}

		const p2 = m.phase2 || {};
		const empty = p2.durationMs != null && p2.durationMs < 8000;
		if (!p2.ok) judge.failed++;
		else if (empty) judge.empty++;
		else judge.healthy++;
		if (p2.durationMs != null) judge.durations.push(p2.durationMs);

		for (const f of m.aggregatedFindings || []) {
			findings.total++;
			findings.severity[f.severity] = (findings.severity[f.severity] || 0) + 1;
			if (f.agreedBy && f.agreedBy.length > 0) findings.agreements++;
		}

		rows.push({
			time: (m.timestamp || d).slice(0, 19).replace("T", " "),
			verdict: v.toUpperCase(),
			judge: empty ? "EMPTY" : !p2.ok ? "FAIL" : `${Math.round((p2.durationMs || 0) / 1000)}s`,
			diff: m.diffLines,
			critics: cset,
			n: (m.aggregatedFindings || []).length,
			branch: m.branch,
		});
	}

	const avg = (arr) =>
		arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length / 1000) : 0;
	const total = rows.length;
	const out = [];
	const dateRange = total > 0 ? ` (${last?.slice(0, 10)} → ${first?.slice(0, 10)})` : "";
	out.push(`\n=== COUNCIL STATS — last ${total} runs${dateRange} ===\n`);

	out.push("VERDICTS:");
	for (const [k, n] of Object.entries(verdicts))
		out.push(`  ${k.padEnd(8)} ${n} (${Math.round((n / total) * 100)}%)`);
	if (findings.fallbacks) out.push(`  (critic-fallback verdicts: ${findings.fallbacks})`);

	out.push("\nCRITIC HEALTH:");
	for (const [k, s] of Object.entries(critics).sort()) {
		const t = s.ok + s.fail;
		const flag = s.ok / t < 0.8 ? "  ⚠ LOW" : "";
		out.push(
			`  ${k.padEnd(10)} ${s.ok}/${t} (${Math.round((s.ok / t) * 100)}%)  avg ${avg(s.durations)}s${flag}`,
		);
		for (const [e, n] of Object.entries(s.errors)) out.push(`             ✗ x${n}: ${e}`);
	}
	if (opencodePreflight.passed || opencodePreflight.failed) {
		out.push(
			`  opencode preflight: passed ${opencodePreflight.passed}, excluded ${opencodePreflight.failed}`,
		);
	}

	out.push(`\nFINDING RELIABILITY MATRIX (last ${limit} runs):`);
	out.push("  critic      findings  confirmed  rejected  fabricated");
	const reliabilityRows = Object.entries(findingReliability).sort(([left], [right]) =>
		left.localeCompare(right),
	);
	if (reliabilityRows.length === 0) out.push("  no reliability data");
	for (const [critic, categories] of reliabilityRows) {
		const cell = categories.all;
		const confirmed = Math.round((cell.confirmed / cell.findings) * 100);
		const rejected = Math.round((cell.rejected / cell.findings) * 100);
		out.push(
			`  ${critic.padEnd(11)} ${String(cell.findings).padEnd(9)} ${`${confirmed}%`.padEnd(10)} ${`${rejected}%`.padEnd(9)} ${cell.fabricated}`,
		);
	}

	out.push("\nJUDGE:");
	out.push(
		`  healthy ${judge.healthy}  empty ${judge.empty}  failed ${judge.failed}  avg ${avg(judge.durations)}s` +
			(judge.empty || judge.failed ? "  ⚠" : ""),
	);

	out.push("\nFINDINGS:");
	out.push(
		`  total ${findings.total}  cross-critic agreements ${findings.agreements}  severity ${JSON.stringify(findings.severity)}`,
	);

	out.push("\nRUN-BY-RUN:");
	for (const r of rows) {
		const c = [
			["codex", "c"],
			["grok", "g"],
			["omp", "m"],
			["opencode", "o"],
		]
			.map(([provider, label]) => `${label}:${r.critics[provider] || "-"}`)
			.join(" ");
		out.push(
			`  ${r.time}  ${r.verdict.padEnd(5)} j=${r.judge.padEnd(5)} ${`${r.diff}L`.padEnd(6)} [${c}] n=${r.n}  ${r.branch}`,
		);
	}
	out.push("");
	process.stdout.write(out.join("\n"));
	return 0;
}

/**
 * Build the per-critic prompt for a consult run.
 * @param {string} planText
 * @param {string | null} topic
 * @param {string} provider
 * @returns {string}
 */
function buildConsultCriticPrompt(planText, topic, provider) {
	const topicLabel = topic || "(untitled plan)";
	const specBlock = getSpecializationBlock(provider, "consult");
	const specPrefix = specBlock
		? `Apply this as your area of emphasis while advising:${specBlock}\n\n`
		: "";
	return [
		`${specPrefix}You are a senior technical advisor for ${COUNCIL_CONFIG.projectName}. You are NOT reviewing code for bugs — you are reviewing a BUILD PLAN / PROPOSAL and giving the team your best strategic and technical counsel.`,
		"",
		`Topic: ${topicLabel}`,
		"",
		"Read the plan below in full, then provide:",
		"1. Risks & flaws — what could go wrong, what's underspecified, hidden assumptions, failure modes.",
		"2. Concrete improvements — specific changes that make the plan better, safer, or simpler.",
		"3. Alternative approaches & new ideas — different ways to achieve the goal the plan may have missed; novel angles worth considering.",
		"4. Gaps & sequencing — anything missing, mis-ordered, or with unaddressed dependencies.",
		"5. What's strong — what the plan gets right, so the team keeps it.",
		"",
		"Be specific and actionable; reference the plan's own sections. Prioritize (most important first). It is fine to challenge the plan's premises if you have a better idea. Do NOT produce an approval verdict — this is advisory counsel.",
		"",
		"PLAN:",
		planText,
	].join("\n");
}

/**
 * Build the chair synthesis prompt for a consult run.
 * @param {string} planFile  path to the temp plan file
 * @param {Array<{name: string, file: string}>} advisorFiles
 * @returns {string}
 */
function buildConsultChairInstructions(planFile, advisorFiles) {
	const fileList = advisorFiles.map((a) => `  - **${a.name}** — \`${a.file}\``).join("\n");
	return [
		`You are the chair for ${COUNCIL_CONFIG.projectName}, synthesizing a council's advice on a build plan. You are given the original PLAN and each advisor's review. Produce one consolidated advisory for the team:`,
		"1. Consensus recommendations — the strongest points multiple advisors agree on, prioritized.",
		"2. High-value individual ideas — the best suggestions or new ideas even if only one advisor raised them (do not lose gems to majority voting).",
		"3. Disagreements & tradeoffs — where advisors conflict, present both sides and your reasoned take.",
		"4. Concrete revisions to the plan — a prioritized, actionable checklist of changes the team should make.",
		"5. Overall assessment — is the plan sound? what is the single most important thing to address?",
		"",
		"Be decisive and specific; cite the plan's sections. This is counsel to improve the plan, not an approval verdict.",
		"",
		"## Files to Read",
		"",
		`**Original plan:** \`${planFile}\``,
		"",
		"**Advisor reviews:**",
		fileList,
		"",
		"IMPORTANT: Use your Read tool to read ALL files listed above before proceeding. Read all files in your first turn.",
	].join("\n");
}

/**
 * Spawn the chair to synthesize advisor outputs for a consult run.
 * Mirrors spawnJudgeWithFiles but without verdict parsing.
 * @param {string} planText
 * @param {Array<{provider: string, ok: boolean, output: string, durationMs: number}>} advisorResults
 * @returns {Promise<{ok: boolean, output: string, error: string | null, durationMs: number}>}
 */
async function spawnConsultChair(planText, advisorResults) {
	const tempFiles = [];
	try {
		const planFile = writeTempFile(planText, ".md");
		tempFiles.push(planFile);

		const advisorFiles = [];
		for (const r of advisorResults.filter((r) => r.ok)) {
			const specLabel = getSpecialization(r.provider)?.label || "General";
			const header = [
				`# ${r.provider} Advisory`,
				`Specialty emphasis: ${specLabel}`,
				`Duration: ${(r.durationMs / 1000).toFixed(1)}s`,
				"",
				"---",
				"",
			].join("\n");
			const file = writeTempFile(header + r.output, ".md");
			tempFiles.push(file);
			advisorFiles.push({ name: r.provider, file });
		}

		const prompt = buildConsultChairInstructions(planFile, advisorFiles);
		const result = await spawnCritic("opusjudge", prompt, JUDGE_TIMEOUT_SECONDS * 1000);
		return {
			ok: result.ok,
			output: result.output || "",
			error: result.error,
			durationMs: result.durationMs,
		};
	} finally {
		for (const f of tempFiles) {
			try {
				unlinkSync(f);
			} catch {}
		}
	}
}

/**
 * Write a consult session log directory.
 * @param {{ topic: string | null, planPath: string, critics: string[], configuredCritics?: string[], opencodePreflight?: string, timings: Record<string, number>, planCharCount: number, advisorOutputs: Array<{provider: string, ok: boolean, output: string, error: string | null}>, chairOutput: string }} logData
 * @returns {string | null} path to the log directory, or null on error
 */
function writeConsultLog(logData) {
	try {
		const mainRoot = getMainWorktreeRoot();
		const baseDir = path.join(mainRoot, CONSULT_LOG_DIR);
		mkdirSync(baseDir, { recursive: true });
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		const runDir = path.join(baseDir, timestamp);
		mkdirSync(runDir, { recursive: true });

		for (const a of logData.advisorOutputs) {
			const content = a.output || `(no output — ${a.error || "unknown error"})`;
			// Sanitize provider name: strip path separators and non-alphanumeric chars to prevent
			// a malicious CONSULT_CRITICS entry (e.g. "../x") from escaping the log directory.
			const safeProvider = (a.provider || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
			writeFileSync(path.join(runDir, `${safeProvider}.md`), content, "utf8");
		}

		writeFileSync(
			path.join(runDir, "chair-synthesis.md"),
			logData.chairOutput || "(no synthesis output)",
			"utf8",
		);

		const meta = {
			topic: logData.topic || "(untitled plan)",
			planPath: logData.planPath,
			critics: logData.critics,
			configuredCritics: logData.configuredCritics || logData.critics,
			effectiveCritics: logData.critics,
			opencodePreflight: logData.opencodePreflight || "not_run",
			timings: logData.timings,
			planCharCount: logData.planCharCount,
		};
		writeFileSync(path.join(runDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

		return runDir;
	} catch {
		return null;
	}
}

/**
 * Run the consult flow: fan-out to critics with the plan, then synthesize with the chair.
 * Exits 0 always (advisory), or 2 if the plan file is unreadable.
 * @param {{ consult: string, topic: string | null, verbose: boolean }} opts
 * @returns {Promise<void>}
 */
async function runConsult(opts) {
	// Read and validate the plan file.
	if (!existsSync(opts.consult)) {
		process.stderr.write(`council-consult: plan file not found: ${opts.consult}\n`);
		process.exit(2);
	}

	let planText;
	try {
		planText = readFileSync(opts.consult, "utf8");
	} catch (err) {
		process.stderr.write(`council-consult: cannot read plan file: ${err.message}\n`);
		process.exit(2);
	}

	if (!planText.trim()) {
		process.stderr.write(`council-consult: plan file is empty: ${opts.consult}\n`);
		process.exit(2);
	}

	let truncated = false;
	if (planText.length > CONSULT_PLAN_CHAR_LIMIT) {
		planText =
			planText.slice(0, CONSULT_PLAN_CHAR_LIMIT) +
			`\n\n[TRUNCATED: plan exceeded ${CONSULT_PLAN_CHAR_LIMIT} characters; remainder omitted]`;
		truncated = true;
	}

	const topic = opts.topic || null;
	const topicDisplay = topic || "(untitled plan)";

	process.stderr.write(
		`council-consult: topic="${topicDisplay}" plan=${opts.consult} (${planText.length} chars${truncated ? ", truncated" : ""})\n`,
	);
	if (CONSULT_CRITICS.length === 0) {
		process.stderr.write(
			"council-consult: CONSULT_CRITICS resolved to zero advisors — nothing to consult\n",
		);
		process.exit(0);
	}

	await preflightLocalModel();
	const { effectiveCritics, opencodePreflight } = await preflightActiveCritics(CONSULT_CRITICS);
	process.stderr.write(
		`council-consult: advisors=[${effectiveCritics.join(",")}] chair=${JUDGE_MODEL}\n`,
	);

	// Fan-out: each critic gets a tailored consult prompt.
	process.stderr.write("council-consult: running advisors in parallel...\n");
	const t0 = Date.now();

	const settled = await Promise.allSettled(
		effectiveCritics.map((provider) => {
			const prompt = buildConsultCriticPrompt(planText, topic, provider);
			return spawnCritic(provider, prompt, TIMEOUT_SECONDS * 1000, "consult");
		}),
	);

	const advisorResults = settled.map((r, i) =>
		r.status === "fulfilled"
			? r.value
			: {
					provider: effectiveCritics[i] ?? "unknown",
					ok: false,
					output: "",
					error: r.reason?.message ?? String(r.reason),
					durationMs: 0,
				},
	);

	const timings = {};
	for (const r of advisorResults) {
		const status = r.ok ? "OK" : "FAIL";
		timings[r.provider] = r.durationMs;
		process.stderr.write(`  [${r.provider}] ${status} ${(r.durationMs / 1000).toFixed(1)}s\n`);
		if (opts.verbose && r.output) {
			process.stderr.write(`    Preview: ${r.output.slice(0, 300)}\n`);
		}
	}

	const successCount = advisorResults.filter((r) => r.ok).length;
	if (successCount === 0) {
		process.stderr.write("council-consult: all advisors failed — no synthesis possible.\n");
		// Still write a log and exit 0 (advisory mode).
		writeConsultLog({
			topic,
			planPath: opts.consult,
			critics: effectiveCritics,
			configuredCritics: CONSULT_CRITICS,
			opencodePreflight,
			timings,
			planCharCount: planText.length,
			advisorOutputs: advisorResults,
			chairOutput: "(no advisor output — all critics failed)",
		});
		process.exit(0);
	}

	// Chair synthesis.
	process.stderr.write(
		`council-consult: chair synthesis (${successCount} advisors succeeded)...\n`,
	);
	const chairResult = await spawnConsultChair(planText, advisorResults);
	const chairDuration = Date.now() - t0;

	process.stderr.write(
		`  [chair] ${chairResult.ok ? "OK" : "FAIL"} ${(chairResult.durationMs / 1000).toFixed(1)}s\n`,
	);
	if (!chairResult.ok && chairResult.error) {
		process.stderr.write(`    Error: ${chairResult.error}\n`);
	}

	const logDir = writeConsultLog({
		topic,
		planPath: opts.consult,
		critics: effectiveCritics,
		configuredCritics: CONSULT_CRITICS,
		opencodePreflight,
		timings: { ...timings, chair: chairResult.durationMs, totalMs: chairDuration },
		planCharCount: planText.length,
		advisorOutputs: advisorResults,
		chairOutput: chairResult.output,
	});

	if (logDir) {
		process.stderr.write(`council-consult: log written to ${logDir}\n`);
	}

	// Print the synthesis to stdout.
	const synthesis =
		chairResult.output || "(chair produced no output — see advisor logs for individual counsel)";
	process.stdout.write(`${synthesis}\n`);

	process.exit(0);
}

async function main() {
	const opts = parseArgs();

	if (opts.stats) {
		process.exit(runStats(opts.statsLimit));
	}

	// One council at a time per repository prevents concurrent runs from competing for
	// local model resources. Linked worktrees share the lock. Stale or corrupt locks are taken over.
	const runLockPath = path.join(getMainWorktreeRoot(), LOG_DIR, ".council-run.lock");
	const runLock = acquireRunLock(runLockPath);
	if (!runLock.ok) {
		process.stderr.write(
			`Council review gate: another council run is active (pid ${runLock.holderPid}, started ${runLock.ageMinutes}m ago) — one council at a time.\n`,
		);
		process.stderr.write("Exit: council_already_running\n");
		process.exit(2);
	}
	process.on("exit", () => releaseRunLock(runLockPath));

	if (opts.consult) {
		await runConsult(opts);
		return; // runConsult calls process.exit; this is a safety return
	}

	const base = opts.base || detectBaseBranch();

	process.stderr.write(`Council review gate: diffing against ${base}\n`);

	const diff = getFullDiff(base);
	if (!diff.trim()) {
		process.stderr.write("Council review gate: no diff — skipping.\n");
		process.exit(0);
	}

	const branchInfo = getBranchInfo();
	const diffLines = diff.split("\n").length;

	process.stderr.write(
		`Council review gate: ${diffLines} diff lines, branch=${branchInfo.branch}\n`,
	);

	const tierRoute = getTierRoute(base, opts.tier ?? process.env.COUNCIL_TIER);
	const tierDepth = resolveTierReviewDepth(tierRoute.tier);
	process.stderr.write(`${tierDepth.header}\n`);
	if (tierRoute.warning) {
		process.stderr.write(`WARNING: ${tierRoute.warning}\n`);
	}
	for (const reason of tierRoute.reasons) {
		process.stderr.write(`  Tier reason: ${reason}\n`);
	}

	// This is a silent no-op unless LOCAL_MODEL_URL or LM_STUDIO_URL is explicitly configured.
	await preflightLocalModel();
	const { effectiveCritics, opencodePreflight } = await preflightActiveCritics(tierDepth.critics);
	const judgeToolsLabel = tierDepth.judgeTools.join(",");
	const executedLabel = tierDepth.judgeExecuted ? " (critical, execution enabled)" : "";
	process.stderr.write(
		`  [judge] tools: ${judgeToolsLabel}${executedLabel}\n`,
	);
	process.stderr.write(
		`Council review gate: critics=[${effectiveCritics.join(",")}] judge=${JUDGE_MODEL} effort=${tierDepth.judgeEffort}\n`,
	);

	// Phase 1: Parallel critic sweep
	process.stderr.write("Phase 1: Running parallel critic sweep...\n");
	const result = await runCouncilReview(diff, branchInfo, effectiveCritics, tierDepth.judgeEffort, {
		judgeTools: tierDepth.judgeTools,
		judgeExecuted: tierDepth.judgeExecuted || false,
		tier: tierRoute.tier,
		debate: opts.debate,
	});

	for (const c of result.phase1) {
		const status = c.criticNoOutput ? "NO_OUTPUT" : c.ok ? "OK" : "FAIL";
		const cVerdict = c.criticNoOutput
			? "critic_no_output"
			: c.ok
				? tallyCriticVerdict(c).decision.toUpperCase()
				: "ERROR";
		process.stderr.write(
			`  [${c.provider}] ${status} ${(c.durationMs / 1000).toFixed(1)}s → ${cVerdict}\n`,
		);
		if (opts.verbose && c.output) {
			process.stderr.write(`    Output: ${c.output.slice(0, 500)}\n`);
		}
	}

	// Phase 2: judge review
	process.stderr.write("Phase 2: judge review...\n");
	process.stderr.write(
		`  [judge] ${result.phase2.ok ? "OK" : "FAIL"} ${(result.phase2.durationMs / 1000).toFixed(1)}s → ${result.verdict.decision.toUpperCase()}\n`,
	);
	if (!result.phase2.ok && result.phase2.error) {
		process.stderr.write(`    Error: ${result.phase2.error}\n`);
	}

	const ledgerTimestamp = new Date().toISOString();
	const logFile = writeLog({
		timestamp: ledgerTimestamp,
		base,
		branch: branchInfo.branch,
		critics: tierDepth.critics.join(","),
		configuredCritics: PHASE1_CRITICS,
		effectiveCritics,
		opencodePreflight,
		judge: JUDGE_MODEL,
		judgeEffort: tierDepth.judgeEffort,
		judgeTools: result.phase2.judgeTools || tierDepth.judgeTools,
		judgeExecuted: result.phase2.judgeExecuted || tierDepth.judgeExecuted || false,
		tier: tierRoute.tier,
		tierReasons: tierRoute.reasons,
		debate: result.debate.enabled,
		debateTallies: result.debate.tallies,
		diffLines,
		phase1: result.phase1.map((c) => ({
			provider: c.provider,
			ok: c.ok,
			durationMs: c.durationMs,
			error: c.error,
			pass2Fallback: c.pass2Fallback ?? false,
		})),
		phase2: {
			provider: "judge",
			ok: result.phase2.ok,
			durationMs: result.phase2.durationMs,
			error: result.phase2.error,
		},
		finalVerdict: result.verdict,
		aggregatedFindings: result.aggregatedFindings,
		quarantineWarnings: result.quarantineWarnings,
		criticFullOutputs: result.phase1,
		judgeFullOutput: result.phase2,
	});
	if (logFile) {
		try {
			appendRunToLedger(
				{
					ts: ledgerTimestamp,
					runId: path.basename(logFile),
					branch: branchInfo.branch,
					baseSha: gitSafe("merge-base", base, "HEAD") || gitSafe("rev-parse", base) || "unknown",
					headSha: gitSafe("rev-parse", "HEAD") || "unknown",
					verdict: result.verdict,
					aggregatedFindings: result.aggregatedFindings,
					critics: result.phase1.map((critic) => ({
						provider: critic.provider,
						output: critic.output || "",
						findings: critic.groundedFindings || [],
					})),
					judgeOutput: result.phase2.output || "",
				},
				path.join(path.dirname(logFile), "ledger.jsonl"),
			);
		} catch (error) {
			process.stderr.write(
				`Ledger warning: failed to append run ${path.basename(logFile)}: ${error instanceof Error ? error.message : "unknown error"}\n`,
			);
		}
	}

	// Dump raw output for critics that produced no parsed content (diagnostic)
	if (logFile) {
		for (const c of result.phase1) {
			if (c.rawOutput && c.output?.includes("(no review output extracted")) {
				try {
					const debugFile = path.join(logFile, `${c.provider}-raw.txt`);
					writeFileSync(debugFile, c.rawOutput.slice(0, 100_000));
					process.stderr.write(
						`  [${c.provider}] Raw output dumped to ${debugFile} (${c.rawOutput.length} bytes)\n`,
					);
				} catch {}
			}
		}
	}

	const verdict = result.verdict;

	// Emit machine-readable COUNCIL_RECEIPT on stderr so automation can parse it
	// deterministically. Sanitize
	// newlines in the reason to keep it a single parseable line.
	if (logFile) {
		const runDirName = path.basename(logFile);
		const receiptVerdict = verdict.decision.toUpperCase();
		const receiptReason = verdict.reason.replace(/\r?\n/g, " // ");
		// Distinguish a judge-authenticated verdict from a degraded critic-only fallback so the
		// coordinator never mistakes a fallback ALLOW for a real judge sign-off.
		const judgeTag = result.judgeAuthFailed
			? " [FALLBACK: judge auth-failed — re-authenticate and re-run]"
			: "";
		process.stderr.write(
			`COUNCIL_RECEIPT: ${runDirName} ${receiptVerdict} ${receiptReason}${judgeTag}\n`,
		);
	}

	// The required Phase-2 judge could not authenticate: the verdict above is a critic-only
	// fallback. Exit with a distinct non-zero code — taking precedence over the ALLOW/BLOCK and
	// --no-block paths — so the coordinator re-authenticates and re-runs rather than silently
	// accepting a degraded verdict, especially a fallback ALLOW.
	if (result.judgeAuthFailed) {
		process.stderr.write(
			`\nJUDGE_AUTH_FAILED: the judge could not authenticate; the verdict below is a critic-only fallback (${verdict.decision.toUpperCase()}). Re-authenticate the judge CLI and re-run the council.\n`,
		);
		if (verdict.details) process.stderr.write(`\n${verdict.details}\n`);
		if (logFile) process.stderr.write(`Log: ${logFile}\n`);
		process.stdout.write(
			`${JSON.stringify({ decision: verdict.decision, reason: verdict.reason, judge_auth_failed: true })}\n`,
		);
		process.exit(EXIT_JUDGE_AUTH_FAILED);
	}

	if (verdict.decision === "block") {
		process.stderr.write(`\nBLOCKED: ${verdict.reason}\n`);
		if (verdict.details) {
			process.stderr.write(`\n${verdict.details}\n`);
		}
		if (logFile) process.stderr.write(`Log: ${logFile}\n`);

		if (opts.noBlock) {
			process.stderr.write("(--no-block mode: exiting 0 despite BLOCK verdict)\n");
			process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
			process.exit(0);
		}

		process.stdout.write(
			`${JSON.stringify({ decision: "block", reason: verdict.reason })}\n`,
		);
		process.exit(1);
	}

	process.stderr.write(`\nALLOWED: ${verdict.reason}\n`);
	if (logFile) process.stderr.write(`Log: ${logFile}\n`);
	process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
if (path.resolve(process.argv[1] || "") === __filename) {
	main().catch((err) => {
		process.stderr.write(`Council review gate fatal: ${err.message}\n`);
		process.exit(2);
	});
}

export {
	aggregateFindings,
	aggregateDebateVotes,
	buildConsultChairInstructions,
	buildConsultCriticPrompt,
	buildCriticPrompt,
	buildDebateJudgeSection,
	buildGroundingPromptSection,
	buildJudgeInstructions,
	buildRebuttalPrompt,
	buildReliabilityPromptSection,
	buildLocalModelHeaders,
	buildOmpArgs,
	buildOpusContext,
	buildTaskPrompt,
	claudeNeedsShell,
	CONSULT_CRITICS,
	CONSULT_LOG_DIR,
	CONSULT_PLAN_CHAR_LIMIT,
	createDisposableWorkspace,
	DEBATE_TIMEOUT_MS,
	extractStructuredFindings,
	FULL_COUNCIL_CRITICS,
	getBranchInfo,
	getFullDiff,
	getMainWorktreeRoot,
	getOpenCodePreflightConfig,
	getProviderConfig,
	getSpecializationBlock,
	getTierRoute,
	git,
	gitSafe,
	hasCriticFindingsJsonBlock,
	hasCriticVerdictHeading,
	hasSuccessfulCriticReview,
	isCriticNoVerdict,
	isJudgeAuthFailure,
	isJudgeTransientFailure,
	isVerdictSummary,
	JUDGE_TIMEOUT_SECONDS,
	killTree,
	loadRelevantMemory,
	MAX_CRITIC_OUTPUT_CHARS,
	MAX_DIFF_BYTES,
	normalizeOpenCodeRetryFailure,
	normalizeProviderFailure,
	numberDebateFindings,
	OPENCODE_PREFLIGHT_TIMEOUT_MS,
	OPENCODE_RETRY_DELAY_MS,
	PHASE1_CRITICS,
	parseCriticVerdict,
	parseArgs,
	parseDiffForGrounding,
	parseJsonFindings,
	parseRebuttalVotes,
	parseVerdict,
	preflightLocalModel,
	probeCriticAuth,
	reanchorCriticVerdict,
	removeDisposableWorkspace,
	resolveBuiltInBinary,
	resolveJudgeTools,
	resolveLocalModelConfig,
	resolveTierReviewDepth,
	runCouncilReview,
	runGroundingPass,
	runCriticsParallel,
	shouldRunDebate,
	shouldRetryOpenCodeResult,
	spawnConsultChair,
	spawnCritic,
	spawnJudgeWithFiles,
	SPECIALIZATIONS,
	synthesizeFromCritics,
	tallyDebateFindings,
	TIMEOUT_SECONDS,
	toLogMetadata,
	writeConsultLog,
	writeCouncilMemory,
	writeTempFile,
};
