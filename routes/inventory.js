var express = require('express');
var router = express.Router();
const authMiddleware = require('./middlewares/auth');
const orderRepo = require('../app/db/repos/order');

// GET /inventory — items from the customer's completed orders.
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const items = await orderRepo.inventoryForUser(req.user.id);
        res.json({ status: 'success', items });
    } catch (err) {
        next(err);
    }
});

module.exports = router;