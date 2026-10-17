/**
 * The one place phone verification codes are issued and consumed.
 *
 * Both flows use this:
 *   login        — proves the caller controls the number already on the account
 *   phone change — proves the caller controls the number they are switching to,
 *                  and binds the code to the signed-in user so one user cannot
 *                  confirm another's pending change
 *
 * Two rules this module exists to enforce:
 *
 *  1. A code is never returned from an HTTP endpoint. It is written to the
 *     backend terminal only. An endpoint that hands back the code it is asking
 *     the user to prove proves nothing.
 *  2. Every row has a TTL and a bounded number of guesses, so a 6-digit code
 *     cannot be brute-forced inside its own lifetime.
 */
const crypto = require('crypto');
const phoneVerifyRepo = require('../db/repos/phoneVerify');

/** 10 minutes, the same lifetime the auth flow has always implied. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Wrong guesses allowed before the challenge is destroyed. */
const MAX_ATTEMPTS = 5;

/** How often expired rows are cleared. */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Delivery seam.
 *
 * In development the code goes to the backend terminal so a human can complete
 * the flow. This is the single line to replace with a real SMS provider
 * (Kavenegar / Melipayamak / SMS.ir) — the rest of the module never touches the
 * code, so nothing else has to change when that happens.
 *
 * Printed in the same object shape the login route used to dump
 * (`console.log(phoneVerifyData)` -> `{ id, phone, code }`), so the code stays
 * exactly where you were looking for it in the terminal.
 */
function deliver(phone, code, context) {
    console.log({
        id: context.id,
        phone,
        code,
        purpose: context.purpose,
        ...(context.userId ? { user: context.userId } : {}),
    });
}

/**
 * Creates a pending challenge and returns only its id.
 *
 * Any previous pending challenge for the same phone is dropped first, so a code
 * can be re-requested and the newest request is the only one that works.
 */
async function issueCode({ phone, userId = null, purpose, ttlMs = DEFAULT_TTL_MS }) {
    if (!phone) throw new Error('issueCode requires a phone');
    if (!purpose) throw new Error('issueCode requires a purpose');

    const now = Date.now();
    const expiresAt = now + ttlMs;

    await phoneVerifyRepo.deletePendingFor(phone, userId);

    const code = await phoneVerifyRepo.getUniqueCode(now);
    const id = crypto.randomUUID();

    await phoneVerifyRepo.create({ id, phone, code, userId, expiresAt });

    deliver(phone, code, { id, userId, purpose });

    return { id, expiresAt };
}

/**
 * Validates a challenge and consumes it.
 *
 * Returns `{ ok: true, row }` or `{ ok: false, reason }`. Every failure looks
 * the same to the caller on purpose — a distinct reason per failure would let
 * someone probe which ids exist or which codes are close.
 *
 * Pass `userId` for a phone change so a challenge issued to one account cannot
 * be confirmed by another.
 *
 * `userId` decides which flow may consume the row, and the two stay strictly
 * apart:
 *
 *   userId === null    login        — only a challenge with no user_id
 *   userId === <id>    phone change — only a challenge issued to that user
 *
 * Without that, a login challenge could be burned through the phone-change
 * endpoint (and vice versa), because a login row has no user_id to compare and
 * would otherwise sail through as "belongs to nobody, which is fine".
 */
async function consumeCode({ id, code, userId = null }) {
    const invalid = { ok: false, reason: 'invalid' };

    if (!id || !code) return invalid;

    const row = await phoneVerifyRepo.findBy('id', id);
    if (!row) return invalid;

    const rowUserId = row.user_id === undefined ? null : row.user_id;

    // Checked BEFORE anything is consumed, so a challenge rejected here is not
    // deleted as a side effect of being rejected.
    if (userId === null) {
        if (rowUserId !== null) return invalid;
    } else if (rowUserId === null || Number(rowUserId) !== Number(userId)) {
        return invalid;
    }

    if (!row.expires_at || Number(row.expires_at) < Date.now()) {
        await phoneVerifyRepo.delete(id);
        return invalid;
    }

    if (String(row.code) !== String(code)) {
        const attempts = await phoneVerifyRepo.recordFailedAttempt(id);
        // Burn the challenge once it runs out of guesses, so an attacker cannot
        // keep trying against the same code.
        if (attempts >= MAX_ATTEMPTS) await phoneVerifyRepo.delete(id);
        return invalid;
    }

    await phoneVerifyRepo.delete(id);
    return { ok: true, row };
}

/**
 * Deletes expired rows on a timer.
 *
 * Without this the table only ever grows: a challenge that is requested and
 * never confirmed stays forever, and `getUniqueCode` has to keep dodging it.
 */
function startSweeper() {
    const sweep = async () => {
        try {
            const removed = await phoneVerifyRepo.deleteExpired();
            if (removed > 0) console.log(`[phone-verification] swept ${removed} expired row(s)`);
        } catch (err) {
            console.error('[phone-verification] sweep failed', err.message);
        }
    };

    sweep();

    // unref so a pending timer never keeps the process alive on its own.
    const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();

    return timer;
}

module.exports = {
    issueCode,
    consumeCode,
    startSweeper,
    DEFAULT_TTL_MS,
    MAX_ATTEMPTS,
    SWEEP_INTERVAL_MS,
};