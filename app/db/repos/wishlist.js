const db = require("../createDatabase");

class Wishlist {
    /**
     * Wishlist rows joined against the live product so the panel can show the
     * current price and flag a price drop against `target_price`.
     */
    allForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT w.id, w.user_id, w.product_id, w.target_price, w.created_at,
                        p.title, p.price AS current_price, p.image, p.category, p.productNumber
                 FROM wishlist w
                 LEFT JOIN products p ON p.id = w.product_id
                 WHERE w.user_id = ? ORDER BY w.created_at DESC`,
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(
                        rows.map((row) => {
                            let category = null;
                            if (row.category) {
                                try {
                                    category = JSON.parse(row.category);
                                } catch (e) {
                                    category = null;
                                }
                            }
                            const { category: rawCategory, ...rest } = row;
                            return { ...rest, category };
                        })
                    );
                }
            );
        });
    }

    countForUser(userId) {
        return new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) AS count FROM wishlist WHERE user_id = ?`, [userId], (err, row) => {
                if (err) return reject(err);
                resolve(row?.count ?? 0);
            });
        });
    }

    /** Idempotent: saving an already-saved product only updates its target price. */
    add(userId, productId, targetPrice = null) {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO wishlist (user_id, product_id, target_price, created_at) VALUES (?,?,?,?)
                 ON CONFLICT (user_id, product_id)
                 DO UPDATE SET target_price = excluded.target_price`,
                [userId, productId, targetPrice, Date.now()],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }

    remove(userId, productId) {
        return new Promise((resolve, reject) => {
            db.run(`DELETE FROM wishlist WHERE user_id = ? AND product_id = ?`, [userId, productId], function (err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }
}

module.exports = new Wishlist();