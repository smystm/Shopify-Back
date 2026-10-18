/**
 * The back office over the order book.
 *
 * Checkout is the one place money moves hands-first; this is the one place it
 * can move back. Everything here is written against the same three invariants
 * checkout guards:
 *
 *   1. A status change is always checked against `canTransition` under a write
 *      lock, so two admins acting at once cannot walk an order somewhere
 *      illegal, and a terminal order can never move again.
 *
 *   2. A refund or cancellation restores *everything* in one transaction: the
 *      wallet credit, the claimed skin units and the drawn-down service stock
 *      all land together or not at all. Half-refunding a customer - money
 *      back, item gone - is exactly the kind of hole that ends up in disputes.
 *
 *   3. A refund is unrepeatable. The wallet ledger row carries the order
 *      reference, and a second attempt with the same reference is refused
 *      before anything is written.
 *
 * These functions write with raw statements inside `transaction.withTransaction`
 * because the shared repos run on the shared connection, which would fold other
 * requests' writes into (or out of) the block. See app/db/transaction.js.
 */
const transaction = require('../db/transaction');
const orderRepo = require('../db/repos/order');
const {
    ORDER_STATUS,
    isValidOrderStatus,
    isTerminal,
    canTransition,
    WALLET_TRANSACTION,
} = require('./orders');

class OrderAdminError extends Error {
    constructor(code, message, status = 409, details = null) {
        super(message);
        this.name = 'OrderAdminError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

/**
 * The admin order list: every order with its buyer attached, plus the same
 * by-status summary shape the customer panel already renders.
 */
async function listOrders() {
    const orders = await orderRepo.allForAdmin();
    const byStatus = await orderRepo.countsForAdmin();

    return {
        orders,
        summary: {
            total: orders.length,
            byStatus: byStatus.reduce((acc, row) => ({ ...acc, [row.status]: row.count }), {}),
        },
    };
}

/** One order for the admin detail view, or null when it does not exist. */
async function getOrder(orderId) {
    return orderRepo.findForAdmin(orderId);
}

/**
 * Move an order to `status`.
 *
 * Simple moves (delivered, disputed, trade-sent bookkeeping) change nothing but
 * the status. Refunds and cancellations additionally restore money and stock,
 * which is why they take the transaction path.
 */
async function applyTransition(orderId, status) {
    if (!isValidOrderStatus(status)) {
        throw new OrderAdminError('INVALID_STATUS', 'Unknown order status', 400, { status });
    }

    const current = await orderRepo.findForAdmin(orderId);
    if (!current) {
        throw new OrderAdminError('ORDER_NOT_FOUND', 'Order not found', 404);
    }

    if (isTerminal(current.status)) {
        throw new OrderAdminError(
            'ORDER_TERMINAL',
            `This order is already ${current.status} and cannot change again`,
            409,
            { status: current.status }
        );
    }

    if (!canTransition(current.status, status)) {
        throw new OrderAdminError(
            'ILLEGAL_TRANSITION',
            `An order cannot move from ${current.status} to ${status}`,
            409,
            { from: current.status, to: status }
        );
    }

    if (status === ORDER_STATUS.REFUNDED || status === ORDER_STATUS.CANCELLED) {
        await restoreOrder(orderId, status);
    } else {
        await orderRepo.setStatusAdmin(orderId, status);
    }

    return orderRepo.findForAdmin(orderId);
}

/**
 * Restore an order's money and goods inside one transaction, then set its
 * terminal status.
 *
 * The refund ledger row is the lock against repeats: `reference` is
 * `order-<id>`, so a second refund attempt for the same order finds the row
 * and stops before a second credit lands. The stock release gives each skin
 * unit back (`sold_count` down, `sold_order_id` cleared only where it points
 * at this order - a later order may legitimately own that pointer now) and
 * puts drawn-down service stock back, but only where stock was counted at
 * all: a NULL stock row is uncounted, not infinite.
 */
async function restoreOrder(orderId, status) {
    await transaction.withTransaction(async ({ run, get, all }) => {
        // The authoritative read: the status on the shared connection could
        // have moved since the caller looked, and under the lock nothing can.
        const row = await get(`SELECT id, user_id, status, total FROM orders WHERE id = ?`, [orderId]);
        if (!row) {
            throw new OrderAdminError('ORDER_NOT_FOUND', 'Order not found', 404);
        }
        if (isTerminal(row.status) || !canTransition(row.status, status)) {
            throw new OrderAdminError(
                'ILLEGAL_TRANSITION',
                `An order cannot move from ${row.status} to ${status}`,
                409,
                { from: row.status, to: status }
            );
        }

        // One refund per order, ever.
        const refunded = await get(
            `SELECT id FROM wallet_transactions WHERE user_id = ? AND type = ? AND reference = ?`,
            [row.user_id, WALLET_TRANSACTION.REFUND, `order-${orderId}`]
        );
        if (refunded) {
            throw new OrderAdminError('ALREADY_REFUNDED', 'This order has already been refunded', 409);
        }

        const now = Date.now();

        // The money back. The reference ties the credit to the debit checkout
        // wrote with the same string, so the ledger reads as one story.
        await run(
            `INSERT INTO wallet_transactions (user_id, type, amount, reference, created_at) VALUES (?,?,?,?,?)`,
            [row.user_id, WALLET_TRANSACTION.REFUND, row.total, `order-${orderId}`, now]
        );

        const items = await all(
            `SELECT product_id, service, variant, quantity FROM order_items WHERE order_id = ?`,
            [orderId]
        );

        // The skins back on the shelf.
        for (const item of items) {
            if (item.product_id) {
                const release = await run(
                    `UPDATE products SET
                        sold_count = MAX(COALESCE(sold_count, 0) - ?, 0),
                        sold_order_id = CASE WHEN sold_order_id = ? THEN NULL ELSE sold_order_id END
                     WHERE id = ?`,
                    [item.quantity, orderId, item.product_id]
                );
                if (release.changes === 0) {
                    // The product row is gone - deleted by an admin after the
                    // sale. Nothing to restock; the refund still stands.
                    continue;
                }
            }

            // The service stock back in the pool, when it was ever counted.
            if (item.service && item.variant) {
                await run(
                    `UPDATE service_prices SET stock = stock + ?, updated_at = ?
                     WHERE service = ? AND variant = ? AND stock IS NOT NULL`,
                    [item.quantity, now, item.service, item.variant]
                );
            }
        }

        await run(`UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?`, [status, now, orderId, row.status]);
    });
}

/**
 * Record the trade offer the shop has just sent for an order.
 *
 * Trading itself happens in Steam: the admin sends the offer from their own
 * client (or the shop's bot does), then registers the offer's share URL here.
 * Recording it is what the whole customer side is built on - the buyer sees the
 * incoming offer in /panel/offers, follows the URL, and their answer is what
 * completes or disputes the order (routes/tradeOffers.js PATCH).
 *
 * The offer row and the status move land in one transaction, so a buyer can
 * never observe "a pending offer that isn't attached to a trade_sent order",
 * and a crash in between cannot strand either half.
 */
async function registerTradeOffer(orderId, steamOfferUrl) {
    // Steam's own share links for one specific offer, e.g.
    // https://steamcommunity.com/tradeoffer/1234567890/ - which is a different
    // shape from the *trade URL* a profile holds (/tradeoffer/new/?partner=...),
    // and catching that mix-up here is friendlier than showing a buyer a link
    // that opens Steam's "make an offer" page instead of the real one.
    if (typeof steamOfferUrl !== 'string' || !/^https:\/\/steamcommunity\.com\/tradeoffer\/[0-9]+\/?$/.test(steamOfferUrl.trim())) {
        throw new OrderAdminError(
            'INVALID_OFFER_URL',
            'steam_offer_url must be the share link Steam shows for the sent offer (https://steamcommunity.com/tradeoffer/<id>)',
            400
        );
    }

    await transaction.withTransaction(async ({ run, get }) => {
        const row = await get(`SELECT id, user_id, status FROM orders WHERE id = ?`, [orderId]);
        if (!row) {
            throw new OrderAdminError('ORDER_NOT_FOUND', 'Order not found', 404);
        }

        // One unanswered offer per order - checked before the transition rules,
        // because a re-recording attempt usually means the operator double-tapped,
        // and that deserves its own message rather than a generic "illegal move".
        // (An order that reached trade_sent directly, with no offer behind it,
        // falls through to the transition check below and is refused there.)
        const pending = await get(
            `SELECT id FROM trade_offers WHERE order_id = ? AND direction = 'incoming' AND status = 'pending'`,
            [orderId]
        );
        if (pending) {
            throw new OrderAdminError('TRADE_ALREADY_PENDING', 'This order already has a pending trade offer', 409);
        }

        if (!canTransition(row.status, ORDER_STATUS.TRADE_SENT)) {
            throw new OrderAdminError(
                'ILLEGAL_TRANSITION',
                `An order cannot move from ${row.status} to ${ORDER_STATUS.TRADE_SENT}`,
                409,
                { from: row.status, to: ORDER_STATUS.TRADE_SENT }
            );
        }

        await run(
            `INSERT INTO trade_offers (order_id, user_id, direction, status, steam_offer_url, created_at) VALUES (?,?,?,?,?,?)`,
            [orderId, row.user_id, 'incoming', 'pending', steamOfferUrl.trim(), Date.now()]
        );

        await run(
            `UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
            [ORDER_STATUS.TRADE_SENT, Date.now(), orderId, row.status]
        );
    });

    return orderRepo.findForAdmin(orderId);
}

module.exports = {
    OrderAdminError,
    listOrders,
    getOrder,
    applyTransition,
    registerTradeOffer,
};
