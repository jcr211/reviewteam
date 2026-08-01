import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizeCouncilConfig } from "./config.mjs";

describe("normalizeCouncilConfig", () => {
	it("provides a runnable generic default", () => {
		const config = normalizeCouncilConfig();

		expect(config.critics).toEqual(DEFAULT_CONFIG.critics);
		expect(config.pathTierRules.length).toBeGreaterThan(0);
		expect(config.timeoutSeconds).toBeGreaterThan(0);
	});

	it("preserves project criteria and CLI critic definitions", () => {
		const config = normalizeCouncilConfig({
			projectName: "ParcelHub",
			description: "A delivery coordination service.",
			reviewConcerns: ["account isolation"],
			architectureRules: ["HTTP handlers call services, not storage adapters"],
			critics: ["local-reviewer"],
			criticSpecialties: {
				"local-reviewer": {
					label: "Boundary reviewer",
					prompt: "Focus on authorization boundaries.",
				},
			},
			criticCommands: {
				"local-reviewer": {
					command: "review-cli",
					args: ["--input", "{promptFile}"],
					promptMode: "file",
				},
			},
		});

		expect(config.projectName).toBe("ParcelHub");
		expect(config.critics).toEqual(["local-reviewer"]);
		expect(config.criticCommands["local-reviewer"].command).toBe("review-cli");
	});

	it("rejects the removed qwencode adapter with migration guidance", () => {
		expect(() => normalizeCouncilConfig({ critics: ["qwencode"] })).toThrow(
			'unknown critic id(s): "qwencode". Valid built-in adapters: claude, codex, grok, omp, opencode. Define custom CLIs in "criticCommands".',
		);
	});

	it("rejects invalid tiers", () => {
		expect(() =>
			normalizeCouncilConfig({
				pathTierRules: [{ pattern: "src/**", tier: "MAXIMUM", reason: "Invalid." }],
			}),
		).toThrow("must be DOCS, STANDARD, or CRITICAL");
	});

	it("requires every path rule to define a pattern and tier", () => {
		expect(() =>
			normalizeCouncilConfig({
				pathTierRules: [{ tier: "CRITICAL", reason: "Important." }],
			}),
		).toThrow(/pathTierRules\[0\]\.pattern/);
		expect(() =>
			normalizeCouncilConfig({
				pathTierRules: [{ pattern: "src/**", reason: "Important." }],
			}),
		).toThrow(/pathTierRules\[0\]\.tier/);
	});

	it("judgeCanExecute defaults to true", () => {
		const config = normalizeCouncilConfig();
		expect(config.judgeCanExecute).toBe(true);
	});

	it("preserves explicit judgeCanExecute false", () => {
		const config = normalizeCouncilConfig({ judgeCanExecute: false });
		expect(config.judgeCanExecute).toBe(false);
	});

	it("rejects non-boolean judgeCanExecute", () => {
		expect(() => normalizeCouncilConfig({ judgeCanExecute: "yes" })).toThrow(
			/must be a boolean/,
		);
		expect(() => normalizeCouncilConfig({ judgeCanExecute: 1 })).toThrow(
			/must be a boolean/,
		);
	});
});
