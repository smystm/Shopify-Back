var express = require('express');
var router = express.Router();
const authMiddleware = require('./middlewares/auth');
const orderRepo = require('../app/db/repos/order');
const orderAdmin = require('../app/services/orderAdmin');
const { OrderAdminError } = require('../app/services/orderAdmin');
const { PERMISSIONS, canViewUsers } = require('../app/services/permissions');
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

// ---- Back office ----
// These three are declared before GET /orders/:id below. Express matches in
// registration order, so a literal path registered after a parameter path
// would be captured by it - /orders/all would become "order 404, user-scoped".

// GET /orders/all — every order in the shop with its buyer attached.
// Visible at the same level as the users list (ReadOnly and up):
// reading the book is how a viewer answers "what happened here".
router.get('/all', authMiddleware, async (req, res, next) => {
    try {
        if (!canViewUsers(req.user.permission)) {
            return res.status(403).json({ status: 'fail', message: 'You do not have permission to view the order book' });
        }

        const result = await orderAdmin.listOrders();
        res.json({ status: 'success', ...result });
    } catch (err) {
        next(err);
    }
});

// GET /orders/admin/:id — one order with buyer details for the admin detail view.
router.get('/admin/:id', authMiddleware, async (req, res, next) => {
    try {
        if (!canViewUsers(req.user.permission)) {
            return res.status(403).json({ status: 'fail', message: 'You do not have permission to view the order book' });
        }

        const order = await orderAdmin.getOrder(req.params.id);
        if (!order) {
            return res.status(404).json({ status: 'fail', message: 'Order not found' });
        }

        res.json({ status: 'success', order });
    } catch (err) {
        next(err);
    }
});

// PATCH /orders/:id/status — move an order through its lifecycle.
// FullAcc only: the status ledger is also the money ledger here, because
// refunding/cancelling restores the wallet and the stock.
router.patch('/:id/status', authMiddleware, async (req, res, next) => {
    try {
        if (req.user.permission !== PERMISSIONS.FULL_ACC) {
            return res.status(403).json({ status: 'fail', message: 'Only FullAcc users can manage orders' });
        }

        const { status } = req.body;
        const order = await orderAdmin.applyTransition(req.params.id, status);
        res.json({ status: 'success', order });
    } catch (err) {
        if (err instanceof OrderAdminError) {
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