/**
 * Turning a cart into an order.
 *
 * This is the one place a customer's money leaves their wallet, so it is one of
 * only two places in the app that needs a database transaction. The sequence is:
 *
 *   read the cart live -> refuse anything undeliverable -> check the balance ->
 *   open a write transaction -> confirm the money under the lock -> claim every
 *   item -> debit the wallet -> drain the cart -> commit
 *
 * Three properties matter more than the rest:
 *
 *   1. **Nothing is half-bought.** Every write happens inside one transaction, so
 *      a failure at any point - a skin claimed by somebody else in the meantime, a
 *      service that just sold out - rolls the whole thing back and leaves the
 *      wallet untouched.
 *
 *   2. **A double submission cannot charge twice.** Draining the cart is part of
 *      the same transaction, so the second request finds an empty cart and stops
 *      at the first check. The cart is only emptied if the customer actually got
 *      the goods.
 *
 *   3. **The balance is re-read under the write lock.** The check before the
 *      transaction is only there so the common "not enough money" case gets a
 *      fast, precise answer. The authoritative one happens after `BEGIN
 *      IMMEDIATE`, where no top-up or other purchase can land in between.
 *
 * The order is created `in_escrow`, not `pending_payment`: by the time the row
 * exists the money really has moved and the goods really are being held.
 */
const transaction = require('../db/transaction');
const cartService = require('./cart');
const orderRepo = require('../db/repos/order');
const walletRepo = require('../db/repos/wallet');
const { ORDER_STATUS, WALLET_TRANSACTION } = require('./orders');

/** The same derived balance the wallet page shows, as SQL we can run under the lock. */
const BALANCE_SQL = `
    SELECT COALESCE(SUM(CASE
            WHEN type = 'topup'    THEN  amount
            WHEN type = 'purchase' THEN -amount
            WHEN type = 'refund'   THEN  amount
            ELSE 0 END), 0) AS balance
    FROM wallet_transactions WHERE user_id = ?`;

class CheckoutError extends Error {
    constructor(code, message, status = 409, details = null) {
        super(message);
        this.name = 'CheckoutError';
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

function insufficient(balance, required) {
    return new CheckoutError('INSUFFICIENT_FUNDS', 'Not enough wallet balance', 402, {
        balance,
        required,
    });
}

/**
 * Buy everything in the cart.
 *
 * `user` is the authenticated row from the auth middleware - `trade_url` is read
 * off it, because a skin cannot be delivered to somebody with no Steam trade link
 * on file. That check happens before any money is involved, so the customer gets a
 * "finish your profile first" answer rather than a failed order.
 */
async function checkout(user) {
    const cart = await cartService.summarize(user.id);

    if (cart.lines.length === 0) {
        throw new CheckoutError('CART_EMPTY', 'Your cart is empty', 400);
    }

    if (cart.totals.unavailableCount > 0) {
        throw new CheckoutError(
            'CART_UNAVAILABLE',
            'Some items in your cart are no longer available',
            409,
            { lines: cart.lines.filter((line) => line.unavailable).length }
        );
    }

    /**
     * A verified phone number, before any money is involved.
     *
     * Signing in no longer needs one - Steam proves who someone is - but paying
     * does. It is how the shop reaches a human when a trade goes wrong, and it is
     * the only contact route an account has.
     *
     * `phone` is absent from the profile's editable fields and is only ever
     * written by consuming a verified code (see routes/profile.js), so a row that
     * has one has *proven* one. There is no separate "verified" flag because there
     * has never been a way to set an unverified one.
     */
    if (!user.phone) {
        throw new CheckoutError(
            'PHONE_REQUIRED',
            'Verify a phone number on your profile before checking out',
            409
        );
    }

    if (!user.trade_url) {
        throw new CheckoutError(
            'NO_TRADE_URL',
            'Add a Steam trade link to your profile before checking out',
            409
        );
    }

    const total = cart.totals.subtotal;
    const balance = await walletRepo.balanceForUser(user.id);

    if (balance < total) {
        throw insufficient(balance, total);
    }

    const orderId = await transaction.withTransaction(async ({ run, get }) => {
        const locked = await get(BALANCE_SQL, [user.id]);
        const lockedBalance = Number(locked?.balance ?? 0);

        if (lockedBalance < total) {
            throw insufficient(lockedBalance, total);
        }

        const now = Date.now();

        const order = await run(
            `INSERT INTO orders (user_id, status, total, created_at, updated_at) VALUES (?,?,?,?,?)`,
            [user.id, ORDER_STATUS.IN_ESCROW, total, now, now]
        );

        const id = order.lastID;

        // Snapshot every line. A service line keeps its machine values and its
        // quantity; a skin line keeps its title and is one unit. Both keep the
        // artwork, so a past order still renders if the source image moves.
        for (const line of cart.lines) {
            await run(
                `INSERT INTO order_items (order_id, product_id, title, price, quantity, service, variant, image, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                [
                    id,
                    line.product_id,
                    line.title,
                    line.price,
                    line.quantity,
                    line.service,
                    line.variant,
                    line.image,
                    now,
                ]
            );
        }

        // Claim the units of each product.
        //
        // The whole claim is one statement on purpose. `sold_count + ? <= count` is
        // evaluated by SQLite inside the write transaction, so two customers
        // checking out the last copies at the same moment cannot both win: the
        // second UPDATE matches no rows and the whole order rolls back with the
        // wallet untouched. Doing this in JavaScript - read, compare, write - would
        // leave exactly the window this guard closes.
        //
        // `sold_order_id` still records whichever order took a unit last. It no
        // longer decides availability - `sold_count` does - so it is an audit
        // trail, not a lock.
        for (const line of cart.lines.filter((line) => line.kind === cartService.CART_KIND.PRODUCT)) {
            const claim = await run(
                `UPDATE products SET sold_count = sold_count + ?, sold_order_id = ?
                  WHERE id = ? AND sold_count + ? <= COALESCE(NULLIF(count, 0), 1)`,
                [line.quantity, id, line.product_id, line.quantity]
            );

            if (claim.changes === 0) {
                throw new CheckoutError(
                    'OUT_OF_STOCK',
                    'One of the items sold out while you were checking out',
                    409,
                    { product_id: line.product_id }
                );
            }
        }

        // Draw down service stock. A NULL stock means the service is not counted
        // (Prime is a one-time upgrade, not a stockpile), so the row is left
        // untouched and the guard passes.
        for (const line of cart.lines.filter(
            (line) => line.kind === cartService.CART_KIND.SERVICE && line.quantity > 0
        )) {
            const draw = await run(
                `UPDATE service_prices SET stock = stock - ?, updated_at = ?
                 WHERE service = ? AND variant = ? AND (stock IS NULL OR stock >= ?)`,
                [line.quantity, now, line.service, line.variant, line.quantity]
            );

            if (draw.changes === 0) {
                throw new CheckoutError('OUT_OF_STOCK', 'A service in your cart just sold out', 409, {
                    service: line.service,
                    variant: line.variant,
                });
            }
        }

        // Debit the wallet. The reference is what ties the ledger row back to the
        // order the customer is about to be shown.
        await run(
            `INSERT INTO wallet_transactions (user_id, type, amount, reference, created_at) VALUES (?,?,?,?,?)`,
            [user.id, WALLET_TRANSACTION.PURCHASE, total, `order-${id}`, now]
        );

        // Only the lines that were actually bought, so anything added to the cart
        // while this request was in flight survives instead of vanishing.
        const placeholders = cart.lines.map(() => '?').join(',');
        const drained = await run(
            `DELETE FROM cart_items WHERE user_id = ? AND id IN (${placeholders})`,
            [user.id, ...cart.lines.map((line) => line.id)]
        );

        if (drained.changes !== cart.lines.length) {
            throw new CheckoutError('CART_CHANGED', 'Your cart changed while checking out', 409);
        }

        return id;
    });

    return {
        order: await orderRepo.findForUser(orderId, user.id),
        total,
    };
}

module.exports = {
    CheckoutError,
    checkout,
};
