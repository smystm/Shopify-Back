var express = require('express');
var router = express.Router();
const yup = require('yup');
const authMiddleware = require('./middlewares/auth');
const validate = require('./middlewares/validate');
const wishlistRepo = require('../app/db/repos/wishlist');

// Nested under `body` to match what the validate middleware actually validates.
const wishlistSchema = yup.object({
    body: yup.object({
        product_id: yup.number().required().positive(),
        target_price: yup.number().nullable().transform((v) => (isNaN(v) ? null : v)),
    }),
});

// GET /wishlist — saved products joined with their live price.
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const items = await wishlistRepo.allForUser(req.user.id);
        res.json({ status: 'success', items, count: items.length });
    } catch (err) {
        next(err);
    }
});

// POST /wishlist — save a product, or update its price alert if already saved.
router.post('/', authMiddleware, validate(wishlistSchema), async (req, res, next) => {
    try {
        const { product_id, target_price } = req.body;
        await wishlistRepo.add(req.user.id, product_id, target_price ?? null);

        const items = await wishlistRepo.allForUser(req.user.id);
        res.status(201).json({ status: 'success', items, count: items.length });
    } catch (err) {
        next(err);
    }
});

// DELETE /wishlist/:productId
router.delete('/:productId', authMiddleware, async (req, res, next) => {
    try {
        const removed = await wishlistRepo.remove(req.user.id, req.params.productId);

        if (!removed) {
            return res.status(404).json({ status: 'fail', message: 'Item is not on your wishlist' });
        }

        const items = await wishlistRepo.allForUser(req.user.id);
        res.json({ status: 'success', items, count: items.length });
    } catch (err) {
        next(err);
    }
});

module.exports = router;