/**
 * Payments, as one thing the rest of the app can talk to.
 *
 * The shape of the rail is worth restating here, because everything below depends
 * on it: **a gateway can only ever credit the wallet.** It never pays an order.
 * A customer tops up, the money lands in their balance, and checkout spends from
 * there. That is why an intent references a top-up and why nothing in this file
 * knows what an order is.
 *
 * A provider is a plain object:
 *
 *     id             machine name, stored on the intent row
 *     isConfigured() whether the shop has actually plugged it in
 *     isSandbox()    whether it is pointed at a test environment
 *     request({ amount, description, callbackUrl })
 *                    -> { ok: true, authority, redirectUrl } | { ok: false, code, message }
 *     verify({ authority, amount })
 *                    -> { ok: true, referenceId, alreadyVerified } | { ok: false, code, message }
 *
 * Providers report failure as a value rather than by throwing, so a declined
 * payment and a broken gateway are both ordinary answers. Only a genuinely
 * unreachable gateway throws.
 */
const transaction = require('../../db/transaction');
const paymentIntentRepo = require('../../db/repos/paymentIntent');
const { WALLET_TRANSACTION } = require('../orders');
const unconfigured = require('./unconfigured');
const zarinpal = require('./zarinpal');

const PROVIDERS = {
    [zarinpal.id]: zarinpal,
    [unconfigured.id]: unconfigured,
};

/** Why a top-up could not be started or settled. Machine values; copy lives in fa.ts. */
const PAYMENT_ISSUE = {
    NOT_CONFIGURED: 'PAYMENT_NOT_CONFIGURED',
    UNKNOWN_INTENT: 'PAYMENT_UNKNOWN_INTENT',
    CANCELLED: 'PAYMENT_CANCELLED',
    FAILED: 'PAYMENT_FAILED',
};

// A top-up smaller than this is not worth a gateway round trip, and one larger
// than this is a typo rather than an intention.
const MIN_TOPUP = 10000;
const MAX_TOPUP = 500000000;

/**
 * The provider the shop is actually using.
 *
 * Falls back to the refusing adapter whenever the configured name is unknown or
 * the provider is missing the credentials it needs, so a half-filled `.env`
 * produces a clear "not configured" answer instead of a crash on the first
 * payment request.
 */
function activeProvider() {
    const name = String(process.env.PAYMENT_PROVIDER ?? '').trim().toLowerCase();
    const provider = PROVIDERS[name];

    if (provider && provider.isConfigured()) {
        return provider;
    }

    return unconfigured;
}

/** What the wallet page needs to decide whether to offer a top-up at all. */
function state() {
    const provider = activeProvider();

    return {
        provider: provider.id,
        configured: provider.isConfigured(),
        sandbox: provider.isSandbox(),
        minTopup: MIN_TOPUP,
        maxTopup: MAX_TOPUP,
    };
}

function callbackUrl() {
    return String(process.env.PAYMENT_CALLBACK_URL ?? '').trim();
}

function isValidTopup(amount) {
    return Number.isFinite(amount) && amount >= MIN_TOPUP && amount <= MAX_TOPUP;
}

/**
 * Start a top-up: record the intent, then ask the provider to open a payment.
 *
 * The intent is written *before* the provider is called, because the authority it
 * hands back is meaningless unless there is a row to attach it to - and the
 * callback arrives with nothing but that authority to identify the customer.
 *
 * An unconfigured shop refuses here rather than creating an intent that could
 * never be settled, so the table only ever holds attempts that really happened.
 */
async function startTopUp({ userId, amount }) {
    const provider = activeProvider();

    if (!provider.isConfigured()) {
        return { ok: false, code: PAYMENT_ISSUE.NOT_CONFIGURED, message: 'No payment gateway is connected yet' };
    }

    if (!isValidTopup(amount)) {
        return { ok: false, code: 'PAYMENT_INVALID_AMOUNT', message: 'That amount cannot be topped up' };
    }

    const { id } = await paymentIntentRepo.create({ userId, provider: provider.id, amount });

    const result = await provider.request({
        amount,
        description: `Wallet top-up #${id}`,
        callbackUrl: callbackUrl(),
    });

    if (!result.ok) {
        await paymentIntentRepo.markFailed(id);
        return result;
    }

    await paymentIntentRepo.setAuthority(id, result.authority);

    return { ok: true, intentId: id, redirectUrl: result.redirectUrl };
}

/**
 * Settle a top-up the gateway has sent the customer back from.
 *
 * The browser supplies only an authority. Everything that decides whether money
 * moved - that the authority is one of ours, what it was for, and how much -
 * comes from our own row, and the provider is asked server-to-server to confirm
 * it. A callback that named a larger amount than the intent holds would change
 * nothing, because the amount verified is the amount we stored.
 *
 * Crediting the wallet and marking the intent paid happen in one transaction.
 * The `status = 'pending'` guard inside it means a replayed or refreshed callback
 * cannot credit twice: the second arrival finds a paid intent and stops.
 */
async function settleTopUp({ authority, status }) {
    const provider = activeProvider();
    const intent = await paymentIntentRepo.findByAuthority(provider.id, authority);

    if (!intent) {
        return { ok: false, code: PAYMENT_ISSUE.UNKNOWN_INTENT, message: 'That payment is not one of ours' };
    }

    if (intent.status === 'paid') {
        return { ok: true, alreadyPaid: true, intentId: intent.id };
    }

    // The customer cancelled at the gateway, or the gateway reported a failure.
    if (status && status !== 'OK') {
        await paymentIntentRepo.markFailed(intent.id, PAYMENT_ISSUE.CANCELLED);

        return { ok: false, code: PAYMENT_ISSUE.CANCELLED, message: 'The payment was not completed' };
    }

    let verification;

    try {
        verification = await provider.verify({ authority, amount: intent.amount });
    } catch (err) {
        // The gateway was unreachable. Leave the intent pending so the callback can
        // be retried rather than writing off a payment that may well have happened.
        return { ok: false, code: PAYMENT_ISSUE.FAILED, message: err.message };
    }

    if (!verification.ok) {
        await paymentIntentRepo.markFailed(intent.id, PAYMENT_ISSUE.FAILED);
        return verification;
    }

    const credited = await transaction.withTransaction(async ({ run }) => {
        const marked = await run(
            `UPDATE payment_intents SET status = 'paid', reference_id = ?, paid_at = ?
             WHERE id = ? AND status = 'pending'`,
            [verification.referenceId ?? null, Date.now(), intent.id]
        );

        // Somebody else already settled this one - leave the wallet alone.
        if (marked.changes === 0) {
            return false;
        }

        await run(
            `INSERT INTO wallet_transactions (user_id, type, amount, reference, created_at) VALUES (?,?,?,?,?)`,
            [intent.user_id, WALLET_TRANSACTION.TOPUP, intent.amount, `intent-${intent.id}`, Date.now()]
        );

        return true;
    });

    return { ok: true, alreadyPaid: !credited, intentId: intent.id, amount: intent.amount };
}

/** The customer's own top-up attempts, for the wallet page. */
async function historyForUser(userId) {
    return paymentIntentRepo.allForUser(userId);
}

module.exports = {
    PAYMENT_ISSUE,
    state,
    activeProvider,
    startTopUp,
    settleTopUp,
    historyForUser,
};
