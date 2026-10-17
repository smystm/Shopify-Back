var express = require('express');
var router = express.Router();
const yup = require('yup');
const authMiddleware = require('./middlewares/auth');
const validate = require('./middlewares/validate');
const payments = require('../app/services/payments');

/**
 * The gateway rail.
 *
 * A gateway can only ever credit the wallet - it never pays for an order - so
 * everything here is about top-ups. Nothing in this file knows what an order is.
 *
 * While no gateway is connected, `POST /payments/intents` answers 503 with a
 * machine code and `GET /payments/config` says so plainly, so the storefront can
 * hide or disable its top-up button instead of sending somebody to a dead page.
 * The demo top-up in `routes/wallet.js` keeps working exactly as before.
 */

const topupSchema = yup.object({
    body: yup.object({
        amount: yup.number().required().positive().integer(),
    }),
});

// Where the customer lands after the gateway is done with them. The gateway's own
// redirect carries no Authorization header, so it cannot land anywhere that needs
// a session - it lands on the wallet page, which handles being signed out.
function frontendUrl() {
    return String(process.env.FRONTEND_URL ?? '').trim().replace(/\/+$/, '') || 'http://localhost:3000';
}

function walletLanding(params) {
    return `${frontendUrl()}/panel/wallet?${new URLSearchParams(params).toString()}`;
}

// GET /payments/config — whether a gateway is connected, and the top-up bounds.
router.get('/config', authMiddleware, (req, res) => {
    res.json({ status: 'success', payment: payments.state() });
});

// GET /payments/intents — the customer's own top-up attempts.
router.get('/intents', authMiddleware, async (req, res, next) => {
    try {
        const intents = await payments.historyForUser(req.user.id);
        res.json({ status: 'success', intents });
    } catch (err) {
        next(err);
    }
});

// POST /payments/intents — open a top-up and get somewhere to send the customer.
router.post('/intents', authMiddleware, validate(topupSchema), async (req, res, next) => {
    try {
        const result = await payments.startTopUp({ userId: req.user.id, amount: req.body.amount });

        if (!result.ok) {
            // 503 rather than 400: the request was fine, the shop is not wired up.
            const status = result.code === payments.PAYMENT_ISSUE.NOT_CONFIGURED ? 503 : 400;

            return res.status(status).json({ status: 'fail', code: result.code, message: result.message });
        }

        res.status(201).json({ status: 'success', intent_id: result.intentId, redirect_url: result.redirectUrl });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /payments/callback — where the gateway sends the customer back.
 *
 * Deliberately unauthenticated: the gateway knows nothing about our sessions, so
 * the only thing this endpoint will trust is the authority in the query string,
 * and that is used purely to look up a row we wrote ourselves. Whether money
 * moved, and how much, is decided server-to-server in `settleTopUp` against the
 * amount stored on that row - never against anything in this request.
 *
 * It answers with a redirect rather than JSON, because a browser is navigating
 * here. The customer ends up on their wallet page, which is where they would have
 * been looking anyway.
 */
router.get('/callback', async (req, res, next) => {
    // Zarinpal sends `Authority` and `Status`; accept either casing so a manual
    // test is not defeated by a query-string convention.
    const authority = req.query.Authority ?? req.query.authority;
    const status = req.query.Status ?? req.query.status;

    if (!authority) {
        return res.redirect(302, walletLanding({ topup: 'failed', reason: payments.PAYMENT_ISSUE.UNKNOWN_INTENT }));
    }

    try {
        const result = await payments.settleTopUp({ authority: String(authority), status: status ? String(status) : null });

        if (!result.ok) {
            return res.redirect(302, walletLanding({ topup: 'failed', reason: result.code }));
        }

        res.redirect(302, walletLanding({ topup: 'ok', amount: String(result.amount ?? '') }));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
