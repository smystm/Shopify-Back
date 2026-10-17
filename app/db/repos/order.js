const db = require("../createDatabase");

/**
 * Every query here is scoped by `user_id` so one customer can never read or
 * mutate another customer's order, whatever id they pass in.
 */
class Order {
    allForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, user_id, status, total, created_at, updated_at FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
                [userId],
                async (err, rows) => {
                    if (err) return reject(err);
                    try {
                        resolve(await this.attachItems(rows));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    findForUser(id, userId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, user_id, status, total, created_at, updated_at FROM orders WHERE id = ? AND user_id = ?`,
                [id, userId],
                async (err, row) => {
                    if (err) return reject(err);
                    if (!row) return resolve(null);
                    try {
                        resolve((await this.attachItems([row]))[0]);
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    async attachItems(orders) {
        if (orders.length === 0) return [];

        const orderIds = orders.map((o) => o.id);
        const placeholders = orderIds.map(() => '?').join(',');

        const items = await new Promise((resolve, reject) => {
            db.all(
                `SELECT id, order_id, product_id, title, price, quantity, service, variant, image, created_at
                 FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`,
                orderIds,
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });

        return orders.map((order) => ({ ...order, items: items.filter((i) => i.order_id === order.id) }));
    }

    /** Creates an order plus its snapshotted items, then returns the full order. */
    async create({ userId, items = [], status = 'pending_payment' }) {
        const now = Date.now();
        // A line's share of the total is its unit price times how many were bought,
        // so a service line with a quantity contributes what it actually cost.
        const total = items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1), 0);

        const orderId = await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO orders (user_id, status, total, created_at, updated_at) VALUES (?,?,?,?,?)`,
                [userId, status, total, now, now],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });

        await Promise.all(
            items.map((item) =>
                new Promise((resolve, reject) => {
                    db.run(
                        `INSERT INTO order_items (order_id, product_id, title, price, quantity, service, variant, image, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?)`,
                        [
                            orderId,
                            item.product_id ?? null,
                            item.title ?? null,
                            Number(item.price) || 0,
                            Number(item.quantity) || 1,
                            item.service ?? null,
                            item.variant ?? null,
                            item.image ?? null,
                            now,
                        ],
                        (err) => (err ? reject(err) : resolve())
                    );
                })
            )
        );

        return this.findForUser(orderId, userId);
    }

    /** Raw status write. Callers must check canTransition() first. */
    setStatus(id, userId, status) {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
                [status, Date.now(), id, userId],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes > 0);
                }
            );
        });
    }

    /** Order count by status key, for the panel's stat tiles. */
    countsForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT status, COUNT(*) AS count FROM orders WHERE user_id = ? GROUP BY status`,
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    /** Items from completed orders — the user's owned inventory. */
    inventoryForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT oi.id, oi.product_id, oi.title, oi.price, oi.quantity, oi.service, oi.variant, oi.image, oi.created_at,
                        o.id AS order_id, o.created_at AS acquired_at
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 WHERE o.user_id = ? AND o.status = 'completed'
                 ORDER BY oi.created_at DESC`,
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }
}

module.exports = new Order();