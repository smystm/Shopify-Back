const db = require("../createDatabase");

/**
 * The customer's unpaid cart.
 *
 * Two kinds of line share this table, discriminated by `kind`:
 *   - `product` lines reference `products` and are bounded by what is left of that
 *     listing's stock (`count` minus `sold_count`).
 *   - `service` lines reference `service_prices` by (service, variant) and are
 *     bounded by that row's own stock and per-order cap.
 *
 * Both are now bought in multiples and both obey the same rule - "never more than
 * is left" - so the two reads differ only in which table supplies the numbers.
 *
 * The two reads below therefore join different tables and hand back different
 * column sets on purpose; `app/services/cart.js` is what normalises them into one
 * shape the storefront can render. Keeping the repo this dumb means the column
 * names mirror the schema, the same convention the product and service repos
 * follow.
 *
 * Every statement is scoped by `user_id`, so a guessed line id can never read or
 * mutate another customer's cart.
 */
class Cart {
    /**
     * Product lines, joined to their live listing.
     *
     * A LEFT JOIN rather than INNER: a product deleted by an admin must still
     * return its cart line, carrying nulls, so the storefront can say the item is
     * gone instead of silently dropping it from the total the customer is looking
     * at.
     */
    productLinesForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT ci.id, ci.user_id, ci.kind, ci.product_id, ci.quantity, ci.created_at, ci.updated_at,
                        p.title, p.price, p.image, p.category, p.productNumber,
                        p.sold_order_id, p.count, p.sold_count
                 FROM cart_items ci
                 LEFT JOIN products p ON p.id = ci.product_id
                 WHERE ci.user_id = ? AND ci.kind = 'product'
                 ORDER BY ci.created_at ASC, ci.id ASC`,
                [userId],
                (err, rows) => (err ? reject(err) : resolve(rows))
            );
        });
    }

    /** Service lines, joined to their live price row. Same LEFT JOIN reasoning. */
    serviceLinesForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT ci.id, ci.user_id, ci.kind, ci.service, ci.variant, ci.quantity, ci.created_at, ci.updated_at,
                        sp.price, sp.stock, sp.max_quantity, sp.image
                 FROM cart_items ci
                 LEFT JOIN service_prices sp ON sp.service = ci.service AND sp.variant = ci.variant
                 WHERE ci.user_id = ? AND ci.kind = 'service'
                 ORDER BY ci.created_at ASC, ci.id ASC`,
                [userId],
                (err, rows) => (err ? reject(err) : resolve(rows))
            );
        });
    }

    /** Both kinds, unjoined. For the header badge and for clearing. */
    countForUser(userId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT COUNT(*) AS lines, COALESCE(SUM(quantity), 0) AS units FROM cart_items WHERE user_id = ?`,
                [userId],
                (err, row) => (err ? reject(err) : resolve({ lines: Number(row?.lines ?? 0), units: Number(row?.units ?? 0) }))
            );
        });
    }

    findLine(userId, lineId) {
        return new Promise((resolve, reject) => {
            db.get(`SELECT * FROM cart_items WHERE id = ? AND user_id = ?`, [lineId, userId], (err, row) =>
                err ? reject(err) : resolve(row ?? null)
            );
        });
    }

    /** This customer's product line for one listing, if they have one. */
    findProductLine(userId, productId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT * FROM cart_items WHERE user_id = ? AND product_id = ?`,
                [userId, productId],
                (err, row) => (err ? reject(err) : resolve(row ?? null))
            );
        });
    }

    /**
     * Create a product line, or set its quantity exactly.
     *
     * Set rather than accumulate, for the same reason as `upsertService`: the
     * caller owns the clamping rules and a line's ceiling can fall as well as
     * rise, which a delta could not express.
     *
     * The conflict target names the partial index from createDatabase, so a second
     * "add to cart" click on the same listing cannot produce a duplicate line.
     */
    upsertProduct(userId, productId, quantity) {
        return new Promise((resolve, reject) => {
            const now = Date.now();
            db.run(
                `INSERT INTO cart_items (user_id, kind, product_id, quantity, created_at, updated_at)
                 VALUES (?, 'product', ?, ?, ?, ?)
                 ON CONFLICT(user_id, product_id) WHERE product_id IS NOT NULL
                 DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
                [userId, productId, quantity, now, now],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }

    /**
     * Create a service line, or set its quantity exactly.
     *
     * Set rather than accumulate: the caller owns the pricing rules, and a
     * service's per-order cap can also *fall* (a shop owner lowers max_quantity),
     * in which case an existing line has to be clamped back down. Passing a final
     * figure covers both directions; passing a delta would not.
     */
    upsertService(userId, service, variant, quantity) {
        return new Promise((resolve, reject) => {
            const now = Date.now();
            db.run(
                `INSERT INTO cart_items (user_id, kind, service, variant, quantity, created_at, updated_at)
                 VALUES (?, 'service', ?, ?, ?, ?, ?)
                 ON CONFLICT(user_id, service, variant) WHERE service IS NOT NULL
                 DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
                [userId, service, variant, quantity, now, now],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }

    /** Set an exact quantity. Returns false when the line is not this user's. */
    setQuantity(userId, lineId, quantity) {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
                [quantity, Date.now(), lineId, userId],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes > 0);
                }
            );
        });
    }

    remove(userId, lineId) {
        return new Promise((resolve, reject) => {
            db.run(`DELETE FROM cart_items WHERE id = ? AND user_id = ?`, [lineId, userId], function (err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }

    /**
     * Empty the cart.
     *
     * Called inside the checkout transaction, which is also what makes a
     * double-submitted checkout safe: the second attempt finds nothing to price.
     */
    clear(userId) {
        return new Promise((resolve, reject) => {
            db.run(`DELETE FROM cart_items WHERE user_id = ?`, [userId], function (err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });
    }
}

module.exports = new Cart();
