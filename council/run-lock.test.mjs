import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { acquireRunLock, releaseRunLock } from "./run-lock.mjs";

describe("acquireRunLock", () => {
	/** @type {string} */
	let tmpDir;
	/** @type {string} */
	let lockPath;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "run-lock-"));
		lockPath = path.join(tmpDir, ".council-run.lock");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("acquire on empty dir → ok:true and the file exists with a pid and token", () => {
		const result = acquireRunLock(lockPath);
		expect(result.ok).toBe(true);
		const raw = fs.readFileSync(lockPath, "utf8");
		const parsed = JSON.parse(raw);
		expect(typeof parsed.pid).toBe("number");
		expect(typeof parsed.startedAt).toBe("string");
		expect(typeof parsed.token).toBe("string");
	});

	test("exclusive create makes a pre-created race winner contended", () => {
		const existing = JSON.stringify({
			pid: 12345,
			startedAt: new Date().toISOString(),
			token: "foreign",
		});
		fs.writeFileSync(lockPath, existing, { encoding: "utf8", flag: "wx" });
		expect(() =>
			fs.writeFileSync(lockPath, "second claimant", { encoding: "utf8", flag: "wx" }),
		).toThrow(expect.objectContaining({ code: "EEXIST" }));

		expect(acquireRunLock(lockPath)).toEqual({
			ok: false,
			holderPid: 12345,
			ageMinutes: 0,
		});
		expect(fs.readFileSync(lockPath, "utf8")).toBe(existing);
	});

	test("acquire twice → second returns ok:false with holderPid", () => {
		acquireRunLock(lockPath);
		const second = acquireRunLock(lockPath);
		expect(second.ok).toBe(false);
		expect(second.holderPid).toBe(process.pid);
		expect(second.ageMinutes).toBe(0);
	});

	test("stale lock is removed and exclusively acquired on the single retry", () => {
		const staleStartedAt = new Date(Date.now() - 46 * 60 * 1_000).toISOString();
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: 12345, startedAt: staleStartedAt, token: "stale" }),
		);

		expect(acquireRunLock(lockPath)).toEqual({ ok: true });
		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
		expect(fs.existsSync(`${lockPath}.guard`)).toBe(false);
	});

	test("stale takeover leaves a replacement with the same pid but a new token", () => {
		const stale = JSON.stringify({
			pid: process.pid,
			startedAt: new Date(Date.now() - 46 * 60 * 1_000).toISOString(),
			token: "stale-owner",
		});
		const replacement = JSON.stringify({
			pid: process.pid,
			startedAt: new Date().toISOString(),
			token: "replacement-owner",
		});
		fs.writeFileSync(lockPath, stale);
		vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
			fs.writeFileSync(lockPath, replacement);
			return stale;
		});

		expect(acquireRunLock(lockPath)).toEqual({
			ok: false,
			holderPid: process.pid,
			ageMinutes: 0,
		});
		expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
	});

	test("corrupt lock is removed and exclusively acquired on the single retry", () => {
		fs.writeFileSync(lockPath, "this is not json {{{", "utf8");

		expect(acquireRunLock(lockPath)).toEqual({ ok: true });
		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
		expect(fs.existsSync(`${lockPath}.guard`)).toBe(false);
	});

	test("a legacy foreign guard does not block stale takeover", () => {
		const staleStartedAt = new Date(Date.now() - 46 * 60 * 1_000).toISOString();
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: 12345, startedAt: staleStartedAt, token: "stale" }),
		);
		fs.writeFileSync(
			`${lockPath}.guard`,
			JSON.stringify({ pid: process.pid, startedAt: staleStartedAt, token: "foreign-guard" }),
		);

		expect(acquireRunLock(lockPath)).toEqual({ ok: true });
		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
		expect(fs.existsSync(`${lockPath}.guard`)).toBe(true);
	});

	test("release then acquire → ok:true", () => {
		acquireRunLock(lockPath);
		releaseRunLock(lockPath);
		const result = acquireRunLock(lockPath);
		expect(result.ok).toBe(true);
	});

	test("release with a foreign pid leaves the lock file", () => {
		const foreign = JSON.stringify({
			pid: process.pid + 1,
			startedAt: new Date().toISOString(),
			token: "foreign",
		});
		fs.writeFileSync(lockPath, foreign);

		expect(() => releaseRunLock(lockPath)).not.toThrow();
		expect(fs.readFileSync(lockPath, "utf8")).toBe(foreign);
	});

	test("release with the current pid removes the lock file", () => {
		acquireRunLock(lockPath);

		releaseRunLock(lockPath);

		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.existsSync(`${lockPath}.guard`)).toBe(false);
	});

	test("release removes a legacy guard carrying the owner's token", () => {
		acquireRunLock(lockPath);
		const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
		fs.writeFileSync(
			`${lockPath}.guard`,
			JSON.stringify({
				pid: process.pid,
				startedAt: new Date().toISOString(),
				token: record.token,
			}),
		);

		releaseRunLock(lockPath);

		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.existsSync(`${lockPath}.guard`)).toBe(false);
	});

	test("release ignores a recycled pid with a different token", () => {
		acquireRunLock(lockPath);
		const replacement = JSON.stringify({
			pid: process.pid,
			startedAt: new Date().toISOString(),
			token: "recycled-pid-owner",
		});
		fs.writeFileSync(lockPath, replacement);

		releaseRunLock(lockPath);

		expect(fs.readFileSync(lockPath, "utf8")).toBe(replacement);
	});

	test("a live foreign guard cannot wedge owner release or immediate reacquire", () => {
		acquireRunLock(lockPath);
		const foreignGuard = JSON.stringify({
			pid: process.pid,
			startedAt: new Date().toISOString(),
			token: "live-foreign-guard",
		});
		fs.writeFileSync(`${lockPath}.guard`, foreignGuard);

		releaseRunLock(lockPath);

		expect(fs.existsSync(lockPath)).toBe(false);
		expect(fs.readFileSync(`${lockPath}.guard`, "utf8")).toBe(foreignGuard);
		expect(acquireRunLock(lockPath)).toEqual({ ok: true });
	});

	test("release read errors never throw and ownership can be retried", () => {
		acquireRunLock(lockPath);
		const error = Object.assign(new Error("read denied"), { code: "EPERM" });
		vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
			throw error;
		});

		expect(() => releaseRunLock(lockPath)).not.toThrow();
		expect(fs.existsSync(lockPath)).toBe(true);

		vi.restoreAllMocks();
		releaseRunLock(lockPath);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test("release unlink errors never throw and ownership can be retried", () => {
		acquireRunLock(lockPath);
		const error = Object.assign(new Error("unlink denied"), { code: "EPERM" });
		vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
			throw error;
		});

		expect(() => releaseRunLock(lockPath)).not.toThrow();
		expect(fs.existsSync(lockPath)).toBe(true);

		vi.restoreAllMocks();
		releaseRunLock(lockPath);
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test("release treats an unlink ENOENT race as successful cleanup", () => {
		acquireRunLock(lockPath);
		const unlinkSync = fs.unlinkSync.bind(fs);
		const error = Object.assign(new Error("already removed"), { code: "ENOENT" });
		vi.spyOn(fs, "unlinkSync").mockImplementationOnce((filePath) => {
			unlinkSync(filePath);
			throw error;
		});

		expect(() => releaseRunLock(lockPath)).not.toThrow();
		expect(fs.existsSync(lockPath)).toBe(false);
	});

	test("release on missing file → does not throw", () => {
		expect(() => releaseRunLock(lockPath)).not.toThrow();
	});
});
