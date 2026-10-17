var express = require('express');
var router = express.Router();
const authMiddleware = require('./middlewares/auth');
const orderRepo = require('../app/db/repos/order');
const { checkout, CheckoutError } = require('../app/services/checkout');

// GET /orders — the signed-in customer's orders, newest first.
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const orders = await orderRepo.allForUser(req.user.id);
        const byStatus = await orderRepo.countsForUser(req.user.id);

        res.json({
            status: 'success',
            orders,
            summary: {
                total: orders.length,
                byStatus: byStatus.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {}),
            },
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /orders — buy the cart.
 *
 * The one endpoint that moves money. It takes no body: what is being bought is
 * whatever the cart holds, priced live at this moment, which is exactly what the
 * customer was looking at. Letting a client post its own item list would mean
 * trusting it with prices.
 *
 * Failures carry a machine `code` so the UI can answer each one specifically -
 * "top up your wallet" reads very differently from "somebody else just bought
 * that skin".
 */
router.post('/', authMiddleware, async (req, res, next) => {
    try {
        const { order } = await checkout(req.user);
        res.status(201).json({ status: 'success', order });
    } catch (err) {
        if (err instanceof CheckoutError) {
            return res.status(err.status).json({
                status: 'fail',
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
            });
        }

        next(err);
    }
});

// GET /orders/:id — a single order, scoped to the owner so a guessed id 404s.
router.get('/:id', authMiddleware, async (req, res, next) => {
    try {
        const order = await orderRepo.findForUser(req.params.id, req.user.id);

        if (!order) {
            return res.status(404).json({ status: 'fail', message: 'Order not found' });
        }

        res.json({ status: 'success', order });
    } catch (err) {
        next(err);
    }
});

module.exports = router;