
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { BUILT_IN_CRITICS, DEFAULT_CONFIG } from "./council/config.mjs";
import {
	extractStructuredFindings,
	parseJsonFindings,
	probeCriticAuth,
	resolveBuiltInBinary,
	runGroundingPass,
	spawnCritic,
} from "./council-review-gate.mjs";

const AUDITION_CLASSES = [
	"correctness",
	"security",
	"error-handling",
	"data-integrity",
	"api-contract",
	"performance",
];

const DEFAULT_MODELS = {
	codex: process.env.CODEX_COUNCIL_MODEL || "gpt-6-sol",
	claude: process.env.CLAUDE_CRITIC_MODEL || DEFAULT_CONFIG.judgeModel,
	grok: process.env.GROK_COUNCIL_MODEL || "grok-4.7",
	opencode: process.env.OPENCODE_COUNCIL_MODEL || "opencode-go/deepseek-v4.1-flash",
	omp: process.env.OMP_COUNCIL_MODEL || "CLI configured default",
};

const VENDORS = {
	codex: "OpenAI",
	claude: "Anthropic",
	grok: "xAI",
	opencode: "OpenCode provider",
	omp: "omp provider",
};

const SPECIALTY_TEMPLATES = {
	correctness: {
		label: "Correctness",
		prompt:
			"Trace boundary conditions, state transitions, and observable behavior for correctness defects.",
	},
	security: {
		label: "Security",
		prompt:
			"Trace authorization, untrusted input, secret handling, and trust-boundary bypasses.",
	},
	"error-handling": {
		label: "Error handling",
		prompt:
			"Trace rejected promises, retries, timeouts, cleanup, and partial-failure behavior.",
	},
	"data-integrity": {
		label: "Data integrity",
		prompt:
			"Trace transaction boundaries, atomicity, idempotency, and data-loss or duplication risks.",
	},
	"api-contract": {
		label: "API contracts",
		prompt:
			"Compare public response shapes, documented types, compatibility promises, and callers.",
	},
	performance: {
		label: "Performance",
		prompt:
			"Inspect hot paths for avoidable repeated work, poor asymptotics, and load-sensitive behavior.",
	},
};

const AUDITION_COST_NOTICE =
	"The audition runs one review per candidate seat. Expect a few minutes wall-clock because seats run in parallel; only metered seats incur token cost.";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FIXTURE_DIR = path.join(moduleDir, "test-fixtures", "audition");

function parseSetupArgs(argv) {
	const options = { yes: false, json: false, noAudition: false };
	for (const arg of argv) {
		if (arg === "--yes") options.yes = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--no-audition") options.noAudition = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function processInvocation(binary, args) {
	if (process.platform === "win32" && /\.ps1$/i.test(binary)) {
		return {
			command: "pwsh",
			args: ["-NoProfile", "-File", binary, ...args],
			shell: false,
		};
	}
	return {
		command: binary,
		args,
		shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(binary),
	};
}

function runProcess(binary, args, timeoutMs = 10_000) {
	return new Promise((resolve) => {
		const invocation = processInvocation(binary, args);
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child;

		function finish(result) {
			if (settled) return;
			settled = true;
			resolve(result);
		}

		try {
			child = spawn(invocation.command, invocation.args, {
				stdio: ["ignore", "pipe", "pipe"],
				shell: invocation.shell,
				windowsHide: true,
			});
		} catch (error) {
			finish({
				ok: false,
				stdout,
				stderr,
				error: error.message,
				notFound: error.code === "ENOENT",
			});
			return;
		}

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({
				ok: false,
				stdout,
				stderr,
				error: `timed out after ${timeoutMs}ms`,
				notFound: false,
			});
		}, timeoutMs);

		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			finish({
				ok: false,
				stdout,
				stderr,
				error: error.message,
				notFound: error.code === "ENOENT",
			});
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({
				ok: code === 0,
				stdout,
				stderr,
				error: code === 0 ? null : `exited with code ${code}`,
				notFound: false,
			});
		});
	});
}

function errorTail(...values) {
	const lines = values
		.filter(Boolean)
		.join("\n")
		.trim()
		.split(/\r?\n/)
		.filter(Boolean);
	return lines.slice(-5).join("\n");
}

async function probeVersion(binary) {
	const hasPathSeparator = binary.includes("/") || binary.includes("\\");
	if (hasPathSeparator && !existsSync(binary)) {
		return {
			ok: false,
			stdout: "",
			stderr: "",
			error: `${binary} does not exist`,
			notFound: true,
		};
	}
	if (process.platform === "win32" && !hasPathSeparator) {
		const lookup = await runProcess("where.exe", [binary], 3_000);
		if (!lookup.ok) return { ...lookup, notFound: true };
		const resolved = lookup.stdout.split(/\r?\n/).find(Boolean) || binary;
		return runProcess(resolved, ["--version"]);
	}
	return runProcess(binary, ["--version"]);
}

async function discoverHarnesses({
	providers = BUILT_IN_CRITICS,
	resolveBinary = resolveBuiltInBinary,
	versionProbe = probeVersion,
	authProbe = probeCriticAuth,
} = {}) {
	return Promise.all(
		providers.map(async (id) => {
			const binary = resolveBinary(id);
			if (!binary) {
				return makeDiscoveryRow(
					id,
					null,
					"NOT FOUND",
					"",
					"Binary resolution failed.",
				);
			}

			const versionResult = await versionProbe(binary, id);
			if (versionResult.notFound) {
				return makeDiscoveryRow(
					id,
					binary,
					"NOT FOUND",
					"",
					errorTail(versionResult.error),
				);
			}

			const version =
				errorTail(versionResult.stdout, versionResult.stderr) || "unknown";
			const authResult = await authProbe(
				id,
				"Reply with exactly: READY",
				60_000,
			);
			if (!authResult.ok) {
				return makeDiscoveryRow(
					id,
					binary,
					"INSTALLED-BUT-FAILED",
					version,
					errorTail(authResult.error, authResult.output),
				);
			}

			return makeDiscoveryRow(id, binary, "READY", version, "");
		}),
	);
}

function makeDiscoveryRow(id, binary, status, version, error) {
	return {
		id,
		vendor: VENDORS[id] || id,
		binary,
		status,
		version,
		defaultModel: DEFAULT_MODELS[id] || "CLI configured default",
		errorTail: error,
		judgeRequired: id === "claude",
	};
}

function normalizeFixturePath(file) {
	return String(file || "")
		.replace(/\\/g, "/")
		.replace(/^(?:a|b)\//, "");
}

function findingMatchesPlant(finding, plant, slack = 5) {
	if (normalizeFixturePath(finding.file) !== normalizeFixturePath(plant.file))
		return false;
	return (
		finding.lineStart >= plant.lineStart - slack &&
		finding.lineStart <= plant.lineEnd + slack
	);
}

function scoreAuditionResult(result, manifest, diffText) {
	const parsed = parseJsonFindings(result.output || "");
	const contractCompliant = parsed !== null;
	const findings = parsed ?? extractStructuredFindings(result.output || "");
	runGroundingPass(findings, diffText);
	const grounded = findings.filter(
		(finding) => finding.grounding === "grounded",
	);
	const classRecall = Object.fromEntries(
		AUDITION_CLASSES.map((className) => {
			const plants = manifest.plants.filter(
				(plant) => plant.class === className,
			);
			return [
				className,
				plants.length > 0 &&
					plants.every((plant) =>
						grounded.some((finding) => findingMatchesPlant(finding, plant)),
					),
			];
		}),
	);
	const falsePositives = grounded.filter(
		(finding) =>
			!manifest.plants.some((plant) => findingMatchesPlant(finding, plant)),
	).length;

	return {
		id: result.provider,
		vendor: result.vendor || VENDORS[result.provider] || result.provider,
		model:
			result.model ||
			DEFAULT_MODELS[result.provider] ||
			"CLI configured default",
		ok: result.ok,
		classRecall,
		overallRecall: Object.values(classRecall).filter(Boolean).length,
		falsePositives,
		latencyMs: result.durationMs,
		metered: result.metered ?? false,
		contractCompliant,
		error: result.error || null,
		findingCount: grounded.length,
	};
}

function buildAuditionPrompt(diffText) {
	return `You are auditioning as a GENERALIST code reviewer. You have no assigned specialty.

Review only the synthetic diff below. Find concrete defects across correctness, security, error handling, data integrity, API contracts, and performance. Do not assume that every category contains a defect.

End with exactly one machine-readable JSON block in this shape:
\`\`\`json
{"findings":[{"severity":"p1","category":"correctness","file":"src/file.mjs","line":12,"description":"Concrete defect and impact"}]}
\`\`\`

SYNTHETIC DIFF:
${diffText}`;
}

function loadAuditionFixture(fixtureDir = DEFAULT_FIXTURE_DIR) {
	return {
		diffText: readFileSync(
			path.join(fixtureDir, "audition.diff"),
			"utf8",
		).replace(/\r\n/g, "\n"),
		manifest: JSON.parse(
			readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"),
		),
	};
}

async function runAudition(
	seats,
	models,
	{ fixture = loadAuditionFixture(), spawnSeat = spawnCritic } = {},
) {
	const prompt = buildAuditionPrompt(fixture.diffText);
	const results = await Promise.all(
		seats.map(async (seat) => {
			const result = await spawnSeat(seat.id, prompt, 300_000, "review", {
				modelOverride:
					models[seat.id] === "CLI configured default"
						? undefined
						: models[seat.id],
			});
			return scoreAuditionResult(
				{ ...result, vendor: seat.vendor, model: models[seat.id] },
				fixture.manifest,
				fixture.diffText,
			);
		}),
	);
	return results;
}

function compareScores(left, right) {
	return (
		right.overallRecall - left.overallRecall ||
		left.falsePositives - right.falsePositives ||
		left.latencyMs - right.latencyMs ||
		left.id.localeCompare(right.id)
	);
}

function selectFamilyFirst(ranking) {
	const selected = [];
	const selectedFamilies = new Set();

	for (const seat of ranking) {
		if (selectedFamilies.has(seat.vendor)) continue;
		selected.push(seat);
		selectedFamilies.add(seat.vendor);
		if (selected.length === 4) return selected;
	}

	if (selectedFamilies.size < 3) {
		for (const seat of ranking) {
			if (selected.includes(seat)) continue;
			selected.push(seat);
			if (selected.length === 3) break;
		}
	}

	return selected;
}

function buildSpecialties(assignments, generalistId, strongestClass) {
	const specialties = Object.fromEntries(
		Object.entries(assignments)
			.filter(([id, classes]) => id !== generalistId && classes.length > 0)
			.map(([id, classes]) => [
				id,
				{
					label: classes
						.map((className) => SPECIALTY_TEMPLATES[className].label)
						.join(" and "),
					prompt: classes
						.map((className) => SPECIALTY_TEMPLATES[className].prompt)
						.join(" "),
				},
			]),
	);
	if (generalistId) {
		const emphasis = strongestClass
			? ` Give light extra attention to ${SPECIALTY_TEMPLATES[strongestClass].label.toLowerCase()}, while treating it as emphasis rather than an exclusive scope.`
			: "";
		specialties[generalistId] = {
			label: strongestClass
				? `Generalist backstop — ${SPECIALTY_TEMPLATES[strongestClass].label} emphasis`
				: "Generalist backstop",
			prompt: `Review the whole diff and look for defects or failure modes that specialist lenses may miss.${emphasis}`,
		};
	}
	return specialties;
}

function exclusionNotes(ranking, roster) {
	if (roster.length === 0) return [];
	const selectedFamilies = new Set(roster.map((seat) => seat.vendor));
	const fastestSelectedLatency = Math.min(
		...roster.map((seat) => seat.latencyMs),
	);
	return ranking
		.filter(
			(seat) =>
				!roster.includes(seat) &&
				!selectedFamilies.has(seat.vendor) &&
				seat.metered !== true &&
				seat.latencyMs < fastestSelectedLatency,
		)
		.map(
			(seat) =>
				`${seat.id} was excluded by rank; consider adding it for cross-family redundancy at near-zero cost.`,
		);
}

function recommendSeats(scoreboard) {
	const ranking = [...scoreboard].sort(compareScores);
	const passing = ranking.filter((seat) => seat.ok);
	const roster = selectFamilyFirst(passing);
	const assignments = Object.fromEntries(roster.map((seat) => [seat.id, []]));
	const gaps = [];
	const generalist = roster[0];

	if (roster.length > 0) {
		const strongestBestClass = AUDITION_CLASSES.find(
			(className) => generalist.classRecall[className],
		);
		if (strongestBestClass) assignments[generalist.id].push(strongestBestClass);

		for (const className of AUDITION_CLASSES) {
			if (className === strongestBestClass) continue;
			const caughtByAny = passing.some((seat) => seat.classRecall[className]);
			if (!caughtByAny) {
				gaps.push(
					`no seat caught the ${className} plant — findings in that class will rely on the judge`,
				);
				continue;
			}
			const eligible = roster
				.filter(
					(seat) => seat.id !== generalist.id && seat.classRecall[className],
				)
				.sort(
					(left, right) =>
						assignments[left.id].length - assignments[right.id].length ||
						ranking.indexOf(left) - ranking.indexOf(right),
				);
			if (eligible[0]) assignments[eligible[0].id].push(className);
		}
	}

	return {
		ranking: ranking.map((seat) => seat.id),
		roster: roster.map((seat) => seat.id),
		assignments,
		generalistBackstop: generalist?.id || null,
		criticSpecialties: buildSpecialties(
			assignments,
			generalist?.id,
			AUDITION_CLASSES.find((className) => generalist?.classRecall[className]),
		),
		gaps,
		notes: exclusionNotes(passing, roster),
		compositionRule:
			"Family-first: select the best audition-passing seat from each model family before adding another seat from any family.\nBackstop: the highest-recall selected seat reviews as a generalist with light emphasis on its strongest class.",
	};
}

function recommendDefaults(seats) {
	const selected = selectFamilyFirst(seats);
	const roster = selected.map((seat) => seat.id);
	const generalistId = roster[0];
	const assignments = Object.fromEntries(roster.map((id) => [id, []]));
	if (generalistId) {
		assignments[generalistId].push(AUDITION_CLASSES[0]);
		const specialists = roster.slice(1);
		AUDITION_CLASSES.forEach((className, index) => {
			if (index === 0 || specialists.length === 0) return;
			assignments[specialists[(index - 1) % specialists.length]].push(
				className,
			);
		});
	}
	return {
		ranking: roster,
		roster,
		assignments,
		generalistBackstop: generalistId || null,
		criticSpecialties: buildSpecialties(
			assignments,
			generalistId,
			generalistId ? AUDITION_CLASSES[0] : undefined,
		),
		gaps: roster.length === 0 ? ["no READY critic seat was discovered"] : [],
		notes: [],
		compositionRule:
			"Family-first: defaults select one READY seat per model family before using a second seat from a family.\nBackstop: the first selected seat reviews as a generalist; remaining seats divide the specialty emphases.",
	};
}

function buildProposedConfig(recommendation, cwd = process.cwd()) {
	return {
		projectName: path.basename(cwd),
		description: "Repository reviewed by ReviewTeam.",
		reviewConcerns: [],
		architectureRules: [],
		pathTierRules: DEFAULT_CONFIG.pathTierRules.map((rule) => ({ ...rule })),
		critics: recommendation.roster,
		criticSpecialties: recommendation.criticSpecialties,
		criticCommands: {},
		judgeModel: DEFAULT_CONFIG.judgeModel,
		judgeCanExecute: DEFAULT_CONFIG.judgeCanExecute,
		timeoutSeconds: DEFAULT_CONFIG.timeoutSeconds,
		judgeTimeoutSeconds: DEFAULT_CONFIG.judgeTimeoutSeconds,
		maxDiffBytes: DEFAULT_CONFIG.maxDiffBytes,
		logDir: DEFAULT_CONFIG.logDir,
		memoryDir: DEFAULT_CONFIG.memoryDir,
	};
}

function writeConfigFile(
	config,
	{
		configPath = path.join(process.cwd(), "council.config.json"),
		overwrite = false,
		fileExists = existsSync,
		writeFile = writeFileSync,
	} = {},
) {
	if (fileExists(configPath) && !overwrite) {
		throw new Error(
			`Refusing to overwrite existing ${configPath} without explicit confirmation.`,
		);
	}
	writeFile(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	return configPath;
}

function table(rows, columns) {
	const widths = columns.map(({ label, value }) =>
		Math.max(label.length, ...rows.map((row) => String(value(row)).length)),
	);
	const render = (values) =>
		values
			.map((value, index) => String(value).padEnd(widths[index]))
			.join(" | ");
	return [
		render(columns.map((column) => column.label)),
		widths.map((width) => "-".repeat(width)).join("-+-"),
		...rows.map((row) => render(columns.map((column) => column.value(row)))),
	].join("\n");
}

function renderDiscovery(discovery) {
	return table(discovery, [
		{ label: "Seat", value: (row) => row.id },
		{ label: "Status", value: (row) => row.status },
		{ label: "Version", value: (row) => row.version || "—" },
		{ label: "Default model", value: (row) => row.defaultModel },
	]);
}

function renderScoreboard(scoreboard) {
	if (scoreboard.length === 0)
		return "Audition skipped; no scoreboard was produced.";
	return table(scoreboard, [
		{ label: "Seat", value: (row) => row.id },
		{ label: "Recall", value: (row) => `${row.overallRecall}/6` },
		{ label: "False +", value: (row) => row.falsePositives },
		{
			label: "Latency",
			value: (row) => `${(row.latencyMs / 1000).toFixed(1)}s`,
		},
		{ label: "JSON", value: (row) => (row.contractCompliant ? "yes" : "no") },
	]);
}

async function defaultPrompt(question) {
	const input = createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	try {
		return await input.question(question);
	} finally {
		input.close();
	}
}

function isYes(answer, defaultYes = false) {
	const normalized = answer.trim().toLowerCase();
	if (!normalized) return defaultYes;
	return normalized === "y" || normalized === "yes";
}

async function runSetup(
	options,
	{
		discover = discoverHarnesses,
		audition = runAudition,
		prompt = defaultPrompt,
		stdout = (text) => process.stdout.write(text),
		cwd = process.cwd(),
		configPath = path.join(cwd, "council.config.json"),
		fileExists = existsSync,
		writeConfig = writeConfigFile,
	} = {},
) {
	const discovery = await discover();
	const ready = discovery.filter((seat) => seat.status === "READY");
	const judge = discovery.find((seat) => seat.id === "claude");

	if (!options.json) {
		stdout(`\nStep 1 — discovery\n${renderDiscovery(discovery)}\n`);
		for (const seat of discovery.filter((row) => row.errorTail)) {
			stdout(`\n${seat.id} error tail (verbatim):\n${seat.errorTail}\n`);
		}
		stdout(
			judge?.status === "READY"
				? "\nJudge requirement: READY — the Claude CLI is installed and authenticated.\n"
				: "\nJudge requirement: NOT READY — reviews require an installed and authenticated Claude CLI.\n",
		);
	}

	const models = Object.fromEntries(
		ready.map((seat) => [seat.id, seat.defaultModel]),
	);
	if (!options.json && !options.yes) {
		stdout("\nStep 2 — model selection\n");
		for (const seat of ready) {
			const answer = await prompt(`${seat.id} model [${seat.defaultModel}]: `);
			if (answer.trim()) models[seat.id] = answer.trim();
		}
	}

	let shouldAudition = !options.noAudition && ready.length > 0;
	if (shouldAudition && !options.json && !options.yes) {
		stdout(`\nStep 3 — audition\n${AUDITION_COST_NOTICE}\n`);
		shouldAudition = isYes(
			await prompt("Run the synthetic audition? [Y/n] "),
			true,
		);
	} else if (!options.json) {
		stdout(`\nStep 3 — audition\n${AUDITION_COST_NOTICE}\n`);
		if (!shouldAudition)
			stdout("Audition skipped; using default specialty assignments.\n");
	}

	const scoreboard = shouldAudition ? await audition(ready, models) : [];
	const recommendation = shouldAudition
		? recommendSeats(scoreboard)
		: recommendDefaults(ready);
	const proposedConfig = buildProposedConfig(recommendation, cwd);
	const report = {
		discovery,
		judgeRequirement: {
			cli: "claude",
			ready: judge?.status === "READY",
			message:
				judge?.status === "READY"
					? "Claude CLI is ready for the required judge seat."
					: "Claude CLI must be installed and authenticated before reviews can run.",
		},
		selectedModels: models,
		audition: {
			skipped: !shouldAudition,
			costNotice: AUDITION_COST_NOTICE,
			scoreboard,
		},
		recommendation,
		proposedConfig,
	};

	if (options.json) {
		stdout(`${JSON.stringify(report, null, 2)}\n`);
		return { ...report, wroteConfig: false };
	}

	stdout(`\nStep 4 — recommendation\n${renderScoreboard(scoreboard)}\n`);
	stdout(`Roster: ${recommendation.roster.join(", ") || "none"}\n`);
	stdout(`${recommendation.compositionRule}\n`);
	for (const gap of recommendation.gaps) stdout(`GAP: ${gap}\n`);
	for (const note of recommendation.notes) stdout(`NOTE: ${note}\n`);
	stdout(
		`\nStep 5 — proposed council.config.json\n${JSON.stringify(proposedConfig, null, "\t")}\n`,
	);

	let overwrite = options.yes;
	if (fileExists(configPath) && !options.yes) {
		overwrite = isYes(
			await prompt(`${configPath} already exists. Overwrite it? [y/N] `),
		);
		if (!overwrite) {
			stdout("Existing config left unchanged.\n");
			return { ...report, wroteConfig: false };
		}
	}
	if (!options.yes && !isYes(await prompt("Write this config? [Y/n] "), true)) {
		stdout("Config not written.\n");
		return { ...report, wroteConfig: false };
	}

	const writtenPath = writeConfig(proposedConfig, {
		configPath,
		overwrite,
		fileExists,
	});
	stdout(`Wrote ${writtenPath}\n`);
	return { ...report, wroteConfig: true, writtenPath };
}

function printHelp() {
	process.stdout.write(`Usage: npm run setup -- [options]

Options:
  --no-audition  Skip the synthetic seat audition and use default specialties
  --yes          Accept defaults, run the audition, and confirm config writing
  --json         Emit discovery, scoreboard, recommendation, and config as JSON; do not write
  --help         Show this help
`);
}

async function main() {
	const options = parseSetupArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	await runSetup(options);
}

const isMain =
	path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`Setup failed: ${error.message}\n`);
		process.exitCode = 1;
	});
}

export {
	AUDITION_CLASSES,
	AUDITION_COST_NOTICE,
	buildAuditionPrompt,
	buildProposedConfig,
	discoverHarnesses,
	findingMatchesPlant,
	loadAuditionFixture,
	parseSetupArgs,
	recommendDefaults,
	recommendSeats,
	renderDiscovery,
	renderScoreboard,
	runAudition,
	runSetup,
	scoreAuditionResult,
	writeConfigFile,
};
