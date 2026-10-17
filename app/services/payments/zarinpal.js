/**
 * Zarinpal, shaped but not connected.
 *
 * The shop has no merchant account yet, so `isConfigured()` is false and
 * `app/services/payments/index.js` keeps this adapter on the shelf. Everything
 * below is the real integration, written against Zarinpal's v4 REST API, so
 * connecting it is a matter of filling in `PAYMENT_MERCHANT_ID` - not of writing
 * this file later under pressure.
 *
 * Two things are worth stating plainly:
 *
 *   - **Amounts are Toman and are never converted.** Zarinpal v4 takes a
 *     `currency` field, so the shop's Toman figures are sent as `IRT` rather than
 *     being multiplied by ten into Rial and hoping the two stay in step. This is
 *     the same rule the entire codebase follows: the digits are the price.
 *
 *   - **The browser's word is never taken for anything.** The callback only tells
 *     us which authority to look at; whether money moved, and how much, is decided
 *     by `verify()` talking to Zarinpal server-to-server against the amount stored
 *     on our own intent row.
 *
 * Zarinpal answers HTTP 200 even for failures, with the real outcome in `data.code`
 * and `errors`. So "did it work" is read out of the body, never out of the status.
 */

// Zarinpal's own hosts. Sandbox is a full mirror, so only the host changes.
const LIVE_HOST = 'https://payment.zarinpal.com';
const SANDBOX_HOST = 'https://sandbox.zarinpal.com';

// Codes Zarinpal can return, for the ones a shopkeeper might actually hit. The
// raw code is always logged; this is only here so a log line reads as a sentence.
const ERROR_MESSAGES = {
    '-9': 'validation error',
    '-10': 'merchant/IP mismatch',
    '-11': 'merchant is not active',
    '-12': 'too many attempts, try again later',
    '-15': 'merchant is blocked',
    '-16': 'merchant level is too low for this amount',
    '-17': 'merchant has no access to the requested facility',
    '-30': 'merchant is not enabled for this payment method',
    '-31': 'the submitted amount does not match the payment',
    '-32': 'no payment was found for that authority',
    '-33': 'the payment was not successful',
    '-34': 'the amount is below the minimum',
    '-35': 'the amount is above the maximum',
    '-50': 'the settlement amount does not match the verified amount',
    '-51': 'the settlement failed',
    '-52': 'no settlement found for this payment',
    '-53': 'the amount exceeds what was settled',
    '-54': 'the authority does not belong to this merchant',
};

// 100 is the normal success. 101 means "already verified", which is what a
// replayed callback looks like - it is a success, not a failure.
const ALREADY_VERIFIED = 101;

function host() {
    return sandbox() ? SANDBOX_HOST : LIVE_HOST;
}

function sandbox() {
    return String(process.env.PAYMENT_SANDBOX ?? '').trim().toLowerCase() === 'true';
}

function merchantId() {
    return String(process.env.PAYMENT_MERCHANT_ID ?? '').trim();
}

function describeCode(code) {
    return ERROR_MESSAGES[String(code)] ?? 'unknown error';
}

/**
 * Zarinpal reports failure inside a 200 body, so a transport-level throw here
 * means the gateway was genuinely unreachable rather than that the payment failed.
 */
async function post(path, body) {
    const response = await fetch(`${host()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
    });

    const text = await response.text();

    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Zarinpal returned a non-JSON reply (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }
}

function failure(payload, fallbackMessage) {
    const code = payload?.errors?.code ?? payload?.data?.code;

    return {
        ok: false,
        code: 'PAYMENT_FAILED',
        provider_code: code ?? null,
        message: payload?.errors?.message ?? fallbackMessage ?? describeCode(code),
    };
}

module.exports = {
    id: 'zarinpal',

    /** A merchant id is the one thing that cannot be defaulted. */
    isConfigured: () => merchantId().length > 0,

    isSandbox: sandbox,

    /**
     * Open a payment and hand back where to send the customer.
     *
     * `callbackUrl` is ours, configured rather than derived from the request, so a
     * spoofed Host header cannot redirect somebody else's payment receipt.
     */
    async request({ amount, description, callbackUrl }) {
        const merchant = merchantId();

        if (!merchant || !callbackUrl) {
            return { ok: false, code: 'PAYMENT_NOT_CONFIGURED', message: 'Zarinpal is not fully configured' };
        }

        const payload = await post('/pg/v4/payment/request.json', {
            merchant_id: merchant,
            amount,
            currency: 'IRT',
            callback_url: callbackUrl,
            description,
        });

        const authority = payload?.data?.authority;

        if (payload?.data?.code !== 100 || !authority) {
            return failure(payload, 'Zarinpal refused the payment request');
        }

        return {
            ok: true,
            authority,
            redirectUrl: `${host()}/pg/StartPay/${authority}`,
        };
    },

    /**
     * Ask Zarinpal, server to server, whether this payment really happened.
     *
     * `amount` is the figure stored on our own intent row - never one that came
     * back through the browser - so a tampered callback cannot inflate a top-up.
     */
    async verify({ authority, amount }) {
        const merchant = merchantId();

        if (!merchant) {
            return { ok: false, code: 'PAYMENT_NOT_CONFIGURED', message: 'Zarinpal is not fully configured' };
        }

        const payload = await post('/pg/v4/payment/verify.json', {
            merchant_id: merchant,
            amount,
            currency: 'IRT',
            authority,
        });

        const code = payload?.data?.code;
        const referenceId = payload?.data?.ref_id;

        if (code !== 100 && code !== ALREADY_VERIFIED) {
            return failure(payload, 'Zarinpal did not confirm this payment');
        }

        return {
            ok: true,
            // 101 means this payment was verified before - a retried callback, not
            // a second payment.
            alreadyVerified: code === ALREADY_VERIFIED,
            referenceId: referenceId ? String(referenceId) : null,
        };
    },
};
