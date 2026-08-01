import { describe, expect, it } from "vitest";
import {
	FULL_COUNCIL_CRITICS,
	getProviderConfig,
	hasSuccessfulCriticReview,
	resolveJudgeTools,
	resolveTierReviewDepth,
} from "../council-review-gate.mjs";
import { DEFAULT_CONFIG } from "./config.mjs";
import {
	applyTierOverride,
	routeTier,
	TIER_CRITICAL,
	TIER_DOCS,
	TIER_STANDARD,
	totalChangedLines,
} from "./tier-router.mjs";

const STANDARD_STAT = { insertions: 10, deletions: 5 };
const STANDARD_DIFF = "+const value = 1;";
const SECURITY_DEFINER = ["SECURITY", "DEFINER"].join(" ");
const KEY_FIELD = ["private", "_key"].join("");
const SIGN_CALL = ["sign", "(payload)"].join("");
const CHECK_CLAUSE = ["CHECK", " (amount_minor >= 0)"].join("");
const ADD_CONSTRAINT = ["ADD", " CONSTRAINT"].join("");
const CUSTOM_RULES = [
	{
		pattern: "services/identity/**",
		tier: TIER_CRITICAL,
		reason: "Identity boundary.",
	},
	{
		pattern: "docs/**",
		tier: TIER_DOCS,
		reason: "Documentation.",
	},
];

describe("routeTier configured path rules", () => {
	it("routes a configured sensitive path to CRITICAL", () => {
		const result = routeTier(
			STANDARD_STAT,
			["services/identity/session.ts"],
			STANDARD_DIFF,
			CUSTOM_RULES,
		);

		expect(result.tier).toBe(TIER_CRITICAL);
		expect(result.reasons.join("\n")).toContain("Identity boundary");
	});

	it("normalizes Windows path separators before matching", () => {
		const result = routeTier(
			STANDARD_STAT,
			["services\\identity\\session.ts"],
			STANDARD_DIFF,
			CUSTOM_RULES,
		);

		expect(result.tier).toBe(TIER_CRITICAL);
	});

	it("keeps an unmatched source path at STANDARD", () => {
		expect(routeTier(STANDARD_STAT, ["src/widgets/card.ts"], STANDARD_DIFF, CUSTOM_RULES).tier).toBe(
			TIER_STANDARD,
		);
	});

	it("supports the generic default routing table", () => {
		const result = routeTier(
			STANDARD_STAT,
			["db/migrations/20260728_add_sessions.sql"],
			STANDARD_DIFF,
			DEFAULT_CONFIG.pathTierRules,
		);

		expect(result.tier).toBe(TIER_CRITICAL);
		expect(result.reasons.join("\n")).toContain("Database migrations");
	});
});

describe("routeTier generic diff-text rules", () => {
	it.each([
		[SECURITY_DEFINER, `+LANGUAGE plpgsql ${SECURITY_DEFINER};`, SECURITY_DEFINER],
		["private key", `+const ${KEY_FIELD} = config.key;`, "private key reference"],
		["sign call", `+const signature = ${SIGN_CALL};`, "sign(...) call"],
		["CHECK constraint", `+  amount_minor bigint ${CHECK_CLAUSE}`, "CHECK constraint"],
		[
			"named CHECK constraint",
			[
				`+ALTER TABLE accounts ${ADD_CONSTRAINT} accounts_state_check `,
				"CHECK",
				" (state <> 'bad');",
			].join(""),
			"CHECK constraint",
		],
	])("%s routes to CRITICAL", (_name, diffText, reasonFragment) => {
		const result = routeTier(STANDARD_STAT, ["scripts/tool.mjs"], diffText, CUSTOM_RULES);

		expect(result.tier).toBe(TIER_CRITICAL);
		expect(result.reasons.join("\n")).toContain(reasonFragment);
	});

	it("does not treat an unchanged CHECK context line as a constraint change", () => {
		const unchangedConstraint = [" amount CHECK", " (amount >= 0)"].join("");
		const result = routeTier(
			STANDARD_STAT,
			["scripts/tool.mjs"],
			unchangedConstraint,
			CUSTOM_RULES,
		);

		expect(result.tier).toBe(TIER_STANDARD);
	});
});

describe("routeTier documentation purity", () => {
	it.each([
		[["README.md"], TIER_DOCS],
		[["docs/guide.mdx", "notes/release.txt"], TIER_DOCS],
		[["README.MD", "packages/docs/content/intro.MDX"], TIER_DOCS],
		[["README.md", "scripts/tool.ts"], TIER_STANDARD],
		[[], TIER_STANDARD],
	])("routes %j to %s", (files, expectedTier) => {
		expect(
			routeTier(STANDARD_STAT, files, STANDARD_DIFF, DEFAULT_CONFIG.pathTierRules).tier,
		).toBe(expectedTier);
	});
});

describe("council critic floor", () => {
	it("requires at least one usable critic review", () => {
		expect(
			hasSuccessfulCriticReview([
				{ ok: false, criticNoOutput: false, output: "" },
				{ ok: true, criticNoOutput: true, output: "ALLOW: ignored" },
			]),
		).toBe(false);
		expect(
			hasSuccessfulCriticReview([
				{ ok: false, criticNoOutput: false, output: "" },
				{ ok: true, criticNoOutput: false, output: "ALLOW: reviewed" },
			]),
		).toBe(true);
	});
});

describe("routeTier size threshold", () => {
	it.each([
		[{ insertions: 1000, deletions: 500 }, TIER_STANDARD],
		[{ insertions: 1000, deletions: 501 }, TIER_CRITICAL],
		[{ total: 1500 }, TIER_STANDARD],
		[{ total: 1501 }, TIER_CRITICAL],
		[1500, TIER_STANDARD],
		[1501, TIER_CRITICAL],
	])("routes %j to %s", (stat, expectedTier) => {
		expect(routeTier(stat, ["scripts/tool.mjs"], STANDARD_DIFF, CUSTOM_RULES).tier).toBe(
			expectedTier,
		);
	});

	it("parses git numstat and shortstat representations", () => {
		expect(totalChangedLines("1000\t501\tscripts/tool.mjs")).toBe(1501);
		expect(totalChangedLines("2 files changed, 1,000 insertions(+), 501 deletions(-)")).toBe(1501);
	});
});

describe("applyTierOverride", () => {
	it.each([
		[TIER_DOCS, "standard", TIER_STANDARD],
		[TIER_DOCS, "critical", TIER_CRITICAL],
		[TIER_STANDARD, "critical", TIER_CRITICAL],
	])("raises %s with %s to %s", (computedTier, override, expectedTier) => {
		const result = applyTierOverride({ tier: computedTier, reasons: ["computed"] }, override);

		expect(result.tier).toBe(expectedTier);
		expect(result.warning).toBeNull();
	});

	it.each([
		[TIER_STANDARD, "docs"],
		[TIER_CRITICAL, "docs"],
		[TIER_CRITICAL, "standard"],
	])("ignores downward %s -> %s overrides loudly", (computedTier, override) => {
		const result = applyTierOverride({ tier: computedTier, reasons: ["computed"] }, override);

		expect(result.tier).toBe(computedTier);
		expect(result.warning).toContain("review-depth floor");
	});

	it("rejects invalid override values", () => {
		expect(() =>
			applyTierOverride({ tier: TIER_STANDARD, reasons: ["computed"] }, "maximum"),
		).toThrow('Invalid council tier "maximum"');
	});
});

describe("council gate tier depth mapping", () => {
	it("uses the first configured critic for DOCS", () => {
		expect(resolveTierReviewDepth(TIER_DOCS, ["review-a", "review-b"])).toMatchObject({
			critics: ["review-a"],
			judgeEffort: "high",
			header: "TIER: DOCS — reduced bench",
		});
	});

	it("preserves the configured roster for STANDARD and CRITICAL", () => {
		const roster = ["review-a", "review-b"];
		expect(resolveTierReviewDepth(TIER_STANDARD, roster).critics).toEqual(roster);
		expect(resolveTierReviewDepth(TIER_CRITICAL, roster).critics).toEqual(roster);
		expect(resolveTierReviewDepth(TIER_CRITICAL, roster).judgeEffort).toBe("xhigh");
		expect(getProviderConfig("opusjudge", "review", { judgeEffort: "xhigh" }).args).toContain(
			"xhigh",
		);
		expect(FULL_COUNCIL_CRITICS.length).toBeGreaterThan(0);
	});
});

describe("resolveJudgeTools", () => {
	it("returns Read only for DOCS", () => {
		expect(resolveJudgeTools(TIER_DOCS)).toEqual(["Read"]);
	});

	it("returns Read,Grep,Glob for STANDARD", () => {
		expect(resolveJudgeTools(TIER_STANDARD)).toEqual(["Read", "Grep", "Glob"]);
	});

	it("returns Read,Grep,Glob,Bash for CRITICAL with judgeCanExecute=true", () => {
		expect(resolveJudgeTools(TIER_CRITICAL, true)).toEqual(["Read", "Grep", "Glob", "Bash"]);
	});

	it("returns Read,Grep,Glob for CRITICAL with judgeCanExecute=false", () => {
		expect(resolveJudgeTools(TIER_CRITICAL, false)).toEqual(["Read", "Grep", "Glob"]);
	});

	it("defaults judgeCanExecute to true", () => {
		expect(resolveJudgeTools(TIER_CRITICAL)).toEqual(["Read", "Grep", "Glob", "Bash"]);
	});
});

describe("resolveTierReviewDepth judge tools", () => {
	it("DOCS tier carries judgeTools Read only", () => {
		const depth = resolveTierReviewDepth(TIER_DOCS);
		expect(depth.judgeTools).toEqual(["Read"]);
		expect(depth.judgeExecuted).toBeUndefined();
	});

	it("STANDARD tier carries judgeTools Read,Grep,Glob", () => {
		const depth = resolveTierReviewDepth(TIER_STANDARD);
		expect(depth.judgeTools).toEqual(["Read", "Grep", "Glob"]);
	});

	it("CRITICAL tier carries judgeTools with Bash and judgeExecuted true", () => {
		const depth = resolveTierReviewDepth(TIER_CRITICAL);
		expect(depth.judgeTools).toEqual(["Read", "Grep", "Glob", "Bash"]);
		expect(depth.judgeExecuted).toBe(true);
	});
});

describe("getProviderConfig opusjudge tool assembly", () => {
	it("passes Read only when no judgeTools option", () => {
		const config = getProviderConfig("opusjudge");
		const allowedTools = config.args[config.args.indexOf("--allowedTools") + 1];
		expect(allowedTools).toBe("Read");
	});

	it("passes Read,Grep,Glob for STANDARD tool set", () => {
		const config = getProviderConfig("opusjudge", "review", {
			judgeTools: ["Read", "Grep", "Glob"],
		});
		const allowedTools = config.args[config.args.indexOf("--allowedTools") + 1];
		expect(allowedTools).toBe("Read,Grep,Glob");
	});

	it("passes Read,Grep,Glob,Bash for CRITICAL with execution", () => {
		const config = getProviderConfig("opusjudge", "review", {
			judgeTools: ["Read", "Grep", "Glob", "Bash"],
		});
		const allowedTools = config.args[config.args.indexOf("--allowedTools") + 1];
		expect(allowedTools).toBe("Read,Grep,Glob,Bash");
	});

	it("honors custom judgeTimeoutSeconds for Bash tier", () => {
		const config = getProviderConfig("opusjudge", "review", {
			judgeTools: ["Read", "Grep", "Glob", "Bash"],
			judgeTimeoutSeconds: 720,
		});
		expect(config.minTimeout).toBe(720 * 1000);
	});
});
