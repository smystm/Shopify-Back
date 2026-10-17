/**
 * The provider that is used until a gateway is actually connected.
 *
 * This is a real provider object rather than a handful of `if (!process.env...)`
 * checks, so the rest of the app - the route, the wallet page - talks to exactly
 * one shape whether or not a gateway exists. Connecting Zarinpal later is then a
 * change of one environment variable, not a change of code path.
 *
 * It refuses everything. A placeholder that returned a fake authority and a
 * plausible-looking redirect URL would be far worse than a hard failure: the
 * customer would be sent to a dead page, and if any part of the callback were
 * written loosely, a "successful" payment that never happened could credit a
 * wallet. The failure is deliberate and explicit.
 */
const CODE = 'PAYMENT_NOT_CONFIGURED';

const MESSAGE = 'No payment gateway is connected yet';

module.exports = {
    id: 'unconfigured',

    isConfigured: () => false,

    isSandbox: () => false,

    /** Would start a payment. Returns the refusal the route turns into a 503. */
    async request() {
        return { ok: false, code: CODE, message: MESSAGE };
    },

    /** Would confirm one. Same refusal - nothing can ever be settled here. */
    async verify() {
        return { ok: false, code: CODE, message: MESSAGE };
    },
};
