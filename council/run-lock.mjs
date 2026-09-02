/**
 * One-council-at-a-time lock.
 *
 * Acquires a JSON lock file so that only one council review harness runs at a
 * time. A corrupt lock or one older than 45 min is silently taken over.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// 45 minutes: a CRITICAL-tier run carrying a security-specialty seat can legitimately hold the
// lock for ~25-35 min (1200s seat wall + judge). The earlier 30-min calibration came from
// pre-security-seat history (measured max 16.0 min over 818 runs) and was observed too tight
// live on 2026-07-27 — a healthy security-bearing run crossed 30 min while still working.
const STALE_THRESHOLD_MS = 45 * 60 * 1_000; // 45 minutes

// A lock whose holder process no longer exists is stale regardless of age (a killed run must not block
// the next one for 45 minutes). kill(pid, 0) probes existence; EPERM means alive-but-not-ours.
function _pidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}
const ownedRunLockTokens = new Map();

/**
 * Try to acquire the run lock.
 *
 * @param {string} lockPath - Absolute or relative path to the lock file.
 * @returns {{ ok: true } | { ok: false, holderPid: number, ageMinutes: number }}
 */
export function acquireRunLock(lockPath) {
	const dir = path.dirname(lockPath);
	if (dir && dir !== "." && !fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	const claim = _makeClaim();
	if (_claim(lockPath, claim.payload)) {
		_rememberOwnership(lockPath, claim.token);
		return { ok: true };
	}

	const existing = _readLockSnapshot(lockPath);
	if (existing?.record) {
		const ageMs = Date.now() - Date.parse(existing.record.startedAt);
		if (ageMs < STALE_THRESHOLD_MS && _pidAlive(existing.record.pid)) {
			return {
				ok: false,
				holderPid: existing.record.pid,
				ageMinutes: Math.round(ageMs / 60_000),
			};
		}
	}

	// The lock file's wx create is the exclusivity primitive. Before the one
	// stale/corrupt takeover retry, only unlink the exact token/content observed.
	// If another claimant replaced it first, their record is left untouched.
	if (!_removeObservedLock(lockPath, existing)) return _describeContention(lockPath);

	if (_claim(lockPath, claim.payload)) {
		_rememberOwnership(lockPath, claim.token);
		return { ok: true };
	}
	return _describeContention(lockPath);
}

/**
 * Release the run lock (idempotent — missing file is fine).
 *
 * @param {string} lockPath
 * @returns {void}
 */
export function releaseRunLock(lockPath) {
	const ownershipKey = path.resolve(lockPath);
	const token = ownedRunLockTokens.get(ownershipKey);
	if (!token) return;

	// Release the primary lock regardless of a live foreign legacy guard. Each
	// cleanup is independent and token-owned; pid is never proof of ownership.
	const lockSettled = _releaseOwnedFile(lockPath, token);
	const guardSettled = _releaseOwnedFile(`${lockPath}.guard`, token);
	if (lockSettled && guardSettled) ownedRunLockTokens.delete(ownershipKey);
}

// -- private ------------------------------------------------------------------

/**
 * Exclusively write a fresh lock record.
 *
 * @param {string} lockPath
 * @param {string} payload
 * @returns {boolean}
 */
function _claim(lockPath, payload) {
	try {
		fs.writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
		return true;
	} catch (err) {
		if (err.code === "EEXIST") return false;
		throw err;
	}
}

/**
 * Create a process-owned lock claim.
 *
 * @returns {{ payload: string; token: string }}
 */
function _makeClaim() {
	const token = randomUUID();
	return {
		payload: JSON.stringify({
			pid: process.pid,
			startedAt: new Date().toISOString(),
			token,
		}),
		token,
	};
}

/**
 * Remember the random token that proves this process created the lock.
 *
 * @param {string} lockPath
 * @param {string} token
 * @returns {void}
 */
function _rememberOwnership(lockPath, token) {
	ownedRunLockTokens.set(path.resolve(lockPath), token);
}

/**
 * Remove a lock/legacy guard only when its random token belongs to this process.
 * Every filesystem operation is isolated so cleanup never throws.
 *
 * @param {string} filePath
 * @param {string} token
 * @returns {boolean}
 */
function _releaseOwnedFile(filePath, token) {
	let record;
	try {
		record = _readLock(filePath);
	} catch {
		return false;
	}
	if (!record || record.token !== token) return true;

	try {
		fs.unlinkSync(filePath);
		return true;
	} catch (err) {
		return err.code === "ENOENT";
	}
}

/**
 * Read and validate a lock record.
 *
 * @param {string} lockPath
 * @returns {{ pid: number; startedAt: string; token: string } | undefined}
 */
function _readLock(lockPath) {
	let raw;
	try {
		raw = fs.readFileSync(lockPath, "utf8");
	} catch (err) {
		if (err.code === "ENOENT") return undefined;
		throw err;
	}
	return _parseLock(raw);
}

/**
 * @param {string} raw
 * @returns {{ pid: number; startedAt: string; token: string } | undefined}
 */
function _parseLock(raw) {
	let record;
	try {
		record = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (
		!record ||
		typeof record.pid !== "number" ||
		typeof record.startedAt !== "string" ||
		typeof record.token !== "string"
	) {
		return undefined;
	}
	if (Number.isNaN(Date.parse(record.startedAt))) return undefined;
	return record;
}

/**
 * @param {string} lockPath
 * @returns {{ raw: string; record: { pid: number; startedAt: string; token: string } | undefined } | undefined}
 */
function _readLockSnapshot(lockPath) {
	try {
		const raw = fs.readFileSync(lockPath, "utf8");
		return { raw, record: _parseLock(raw) };
	} catch (err) {
		if (err.code === "ENOENT") return undefined;
		throw err;
	}
}

/**
 * Remove only the lock token/content observed before takeover. Read and unlink
 * failures are treated as a lost retry rather than escaping cleanup.
 *
 * @param {string} lockPath
 * @param {{ raw: string; record: { token: string } | undefined } | undefined} observed
 * @returns {boolean}
 */
function _removeObservedLock(lockPath, observed) {
	if (!observed) return true;

	let currentRaw;
	try {
		currentRaw = fs.readFileSync(lockPath, "utf8");
	} catch (err) {
		return err.code === "ENOENT";
	}

	if (observed.record) {
		if (_parseLock(currentRaw)?.token !== observed.record.token) return false;
	} else if (currentRaw !== observed.raw) {
		return false;
	}

	try {
		fs.unlinkSync(lockPath);
		return true;
	} catch (err) {
		return err.code === "ENOENT";
	}
}

/**
 * Describe the winner after losing the single stale-lock retry race.
 *
 * @param {string} lockPath
 * @returns {{ ok: false; holderPid: number; ageMinutes: number }}
 */
function _describeContention(lockPath) {
	const record = _readLock(lockPath);
	if (!record) return { ok: false, holderPid: 0, ageMinutes: 0 };
	return {
		ok: false,
		holderPid: record.pid,
		ageMinutes: Math.round((Date.now() - Date.parse(record.startedAt)) / 60_000),
	};
}
