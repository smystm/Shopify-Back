var express = require('express');
var router = express.Router();
const yup = require('yup');
const authMiddleware = require('./middlewares/auth');
const validate = require('./middlewares/validate');
const cartService = require('../app/services/cart');

/**
 * The cart is the unpaid, mutable half of buying: it can be edited freely and
 * carries no status. Orders - the immutable, priced half - live in routes/orders.js.
 *
 * Every response reports the whole cart back rather than just the line that
 * changed, so the client never has to patch its own copy: one request, one state.
 * Prices are resolved live on every read, which is also what checkout will charge.
 */

// `service` and `variant` are machine values matched against service_prices. They
// are not enumerated here, because the service layer already answers "no such
// service" with a 404 and a new service should not need a route edit.
const addSchema = yup.object({
    body: yup.object({
        product_id: yup.number().positive().integer().nullable(),
        service: yup.string().trim().matches(/^[a-z0-9_]+$/, 'service must be a machine value').nullable(),
        variant: yup.string().trim().max(64).nullable(),
        quantity: yup.number().integer().positive().max(999),
    }).test('one-kind-of-line', function (value) {
        const isProduct = value.product_id !== null && value.product_id !== undefined;
        const isService = Boolean(value.service);

        if (isProduct && isService) {
            return this.createError({ message: 'Send either product_id or service, not both' });
        }

        if (!isProduct && !isService) {
            return this.createError({ message: 'Send either product_id or service' });
        }

        if (isService && !value.variant) {
            return this.createError({ message: 'A service line also needs a variant' });
        }

        return true;
    }),
});

const quantitySchema = yup.object({
    body: yup.object({
        quantity: yup.number().required().integer().positive().max(999),
    }),
});

/** Turns a CartError into its own status code; everything else behaves as usual. */
function handler(fn) {
    return async (req, res, next) => {
        try {
            await fn(req, res, next);
        } catch (err) {
            if (err instanceof cartService.CartError) {
                return res.status(err.status).json({ status: 'fail', code: err.code, message: err.message });
            }

            next(err);
        }
    };
}

// GET /cart — every line priced against its live listing, plus the totals.
router.get('/', authMiddleware, handler(async (req, res) => {
    const cart = await cartService.summarize(req.user.id);
    res.json({ status: 'success', ...cart });
}));

// GET /cart/count — the header badge, without pricing a single line.
router.get('/count', authMiddleware, handler(async (req, res) => {
    const count = await cartService.count(req.user.id);
    res.json({ status: 'success', count });
}));

// POST /cart — add a skin or a service.
router.post('/', authMiddleware, validate(addSchema), handler(async (req, res) => {
    const { product_id, service, variant, quantity } = req.body;

    const cart = product_id
        ? await cartService.addProduct(req.user.id, product_id, quantity ?? 1)
        : await cartService.addService(req.user.id, service, variant ?? null, quantity ?? 1);

    res.status(201).json({ status: 'success', ...cart });
}));

// PATCH /cart/:lineId — change one line's quantity. Works for both kinds; the
// service clamps to what is left of that line's stock or per-order cap.
router.patch('/:lineId', authMiddleware, validate(quantitySchema), handler(async (req, res) => {
    const cart = await cartService.setQuantity(req.user.id, Number(req.params.lineId), req.body.quantity);
    res.json({ status: 'success', ...cart });
}));

// DELETE /cart/:lineId — drop one line.
router.delete('/:lineId', authMiddleware, handler(async (req, res) => {
    const cart = await cartService.remove(req.user.id, Number(req.params.lineId));
    res.json({ status: 'success', ...cart });
}));

// DELETE /cart — empty it. Checkout does not use this: it clears inside its own
// transaction, which is what makes a double submission harmless.
router.delete('/', authMiddleware, handler(async (req, res) => {
    const cart = await cartService.clear(req.user.id);
    res.json({ status: 'success', ...cart });
}));

module.exports = router;
