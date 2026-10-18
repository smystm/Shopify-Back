var express = require('express');
var router = express.Router();
const authMiddleware = require('./middlewares/auth');
const tradeOfferRepo = require('../app/db/repos/tradeOffer');
const orderRepo = require('../app/db/repos/order');
const orderAdmin = require('../app/services/orderAdmin');
const { OrderAdminError } = require('../app/services/orderAdmin');
const { PERMISSIONS } = require('../app/services/permissions');
const { TRADE_OFFER_STATUS, TRADE_OFFER_STATUSES, ORDER_STATUS, canTransition } = require('../app/services/orders');

// GET /trade-offers — incoming and outgoing offers for the signed-in user.
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const offers = await tradeOfferRepo.allForUser(req.user.id);
        const pendingCount = offers.filter((o) => o.status === TRADE_OFFER_STATUS.PENDING).length;

        res.json({
            status: 'success',
            offers,
            pendingCount,
            incoming: offers.filter((o) => o.direction === 'incoming'),
            outgoing: offers.filter((o) => o.direction === 'outgoing'),
        });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /trade-offers — register the trade offer the shop has sent for an order.
 *
 * FullAcc only, because the URL recorded here is what the buyer will be told
 * to open to receive goods that have already been paid for. The service does
 * the real work atomically: one incoming pending offer, the order flipped to
 * `trade_sent`, or nothing.
 */
router.post('/', authMiddleware, async (req, res, next) => {
    try {
        if (req.user.permission !== PERMISSIONS.FULL_ACC) {
            return res.status(403).json({ status: 'fail', message: 'Only FullAcc users can send trade offers' });
        }

        const { order_id, steam_offer_url } = req.body;
        const orderId = Number(order_id);

        if (!Number.isInteger(orderId) || orderId <= 0) {
            return res.status(400).json({ status: 'fail', message: 'order_id is required' });
        }

        const order = await orderAdmin.registerTradeOffer(orderId, steam_offer_url);
        res.status(201).json({ status: 'success', order });
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

// PATCH /trade-offers/:id — accept or decline an incoming offer.
router.patch('/:id', authMiddleware, async (req, res, next) => {
    try {
        const { status } = req.body;

        if (![TRADE_OFFER_STATUS.ACCEPTED, TRADE_OFFER_STATUS.DECLINED].includes(status)) {
            return res.status(400).json({
                status: 'fail',
                message: `status must be one of: ${TRADE_OFFER_STATUS.ACCEPTED}, ${TRADE_OFFER_STATUS.DECLINED}`,
            });
        }

        const offer = await tradeOfferRepo.findForUser(req.params.id, req.user.id);

        if (!offer) {
            return res.status(404).json({ status: 'fail', message: 'Trade offer not found' });
        }

        // Only an incoming offer can be answered by the buyer.
        if (offer.direction !== 'incoming') {
            return res.status(400).json({ status: 'fail', message: 'Only incoming offers can be accepted or declined' });
        }

        // False means it was already answered — reject so the UI can refetch.
        const changed = await tradeOfferRepo.respond(offer.id, req.user.id, status);
        if (!changed) {
            return res.status(409).json({ status: 'fail', message: 'This offer has already been answered' });
        }

        // Accepting completes the linked order; declining sends it to review.
        let order = null;
        if (offer.order_id) {
            const target = status === TRADE_OFFER_STATUS.ACCEPTED ? ORDER_STATUS.COMPLETED : ORDER_STATUS.DISPUTED;
            const linked = await orderRepo.findForUser(offer.order_id, req.user.id);

            if (linked && canTransition(linked.status, target)) {
                await orderRepo.setStatus(linked.id, req.user.id, target);
                order = await orderRepo.findForUser(linked.id, req.user.id);
            }
        }

        const updated = await tradeOfferRepo.findForUser(offer.id, req.user.id);
        res.json({ status: 'success', offer: updated, order });
    } catch (err) {
        next(err);
    }
});

module.exports = router;