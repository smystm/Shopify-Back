var express = require('express');
var router = express.Router();
const authMiddleware = require('./middlewares/auth');
const walletRepo = require('../app/db/repos/wallet');
const { WALLET_TRANSACTION, WALLET_TRANSACTIONS } = require('../app/services/orders');

// GET /wallet — derived balance plus the ledger behind it.
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const [balance, transactions] = await Promise.all([
            walletRepo.balanceForUser(req.user.id),
            walletRepo.transactionsForUser(req.user.id),
        ]);

        res.json({ status: 'success', balance, transactions });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /wallet/topup — records a credit.
 *
 * In production this is driven by the payment gateway's callback, never by the
 * browser. Until that gateway is wired up this endpoint exists so the panel can
 * be exercised; it is clearly marked and only accepts small demo amounts.
 */
router.post('/topup', authMiddleware, async (req, res, next) => {
    try {
        const { amount, reference } = req.body;
        const value = Number(amount);

        if (!Number.isFinite(value) || value <= 0) {
            return res.status(400).json({ status: 'fail', message: 'amount must be a positive number' });
        }

        if (value > 100000) {
            return res.status(400).json({ status: 'fail', message: 'amount is above the demo top-up limit' });
        }

        await walletRepo.add({
            userId: req.user.id,
            type: WALLET_TRANSACTION.TOPUP,
            amount: value,
            reference: typeof reference === 'string' ? reference.slice(0, 120) : null,
        });

        const balance = await walletRepo.balanceForUser(req.user.id);
        const transactions = await walletRepo.transactionsForUser(req.user.id);

        res.status(201).json({ status: 'success', balance, transactions });
    } catch (err) {
        next(err);
    }
});

module.exports = router;