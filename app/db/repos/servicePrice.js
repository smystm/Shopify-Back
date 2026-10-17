const db = require("../createDatabase");

/**
 * Prices for the store's non-skin goods: CS2 Prime and TF2 Mann Co. keys.
 *
 * These are deliberately not rows in `products`. That table's category value is
 * matched against the folder names under `public/images/weapons-real/skins`, so
 * a `prime` row would also have surfaced as a thirteenth category tile on the
 * home page, as an entry in the product filter on /products, and inside the live
 * catalogue counts on the home and about pages - none of which describe a Prime
 * upgrade or a key.
 *
 * `variant` is a machine value (`argentina`, `key`); its Persian label lives in
 * `app/lib/i18n/fa.ts`, the same split the catalogue already uses for category
 * folder names. Column names are returned verbatim so the frontend contract
 * mirrors the schema, like the product repo does. `position` orders rows within
 * one service, so both orderings group by service first.
 */
class ServicePrice {

    /** Every row, in the order the storefront renders them. */
    all() {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, service, variant, price, stock, max_quantity, position, image
                 FROM service_prices
                 ORDER BY service ASC, position ASC, id ASC`,
                function (err, rows) {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    byService(service) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, service, variant, price, stock, max_quantity, position, image
                 FROM service_prices
                 WHERE service = ?
                 ORDER BY position ASC, id ASC`,
                [service],
                function (err, rows) {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    /** One row by its machine pair, or null. Used by the cart to price a line. */
    findByVariant(service, variant) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, service, variant, price, stock, max_quantity, position, image
                 FROM service_prices
                 WHERE service = ? AND variant = ?`,
                [service, variant],
                function (err, row) {
                    if (err) return reject(err);
                    resolve(row ?? null);
                }
            );
        });
    }

    /**
     * Insert one price row, or rewrite its numbers if it is already there.
     *
     * The UNIQUE(service, variant) index turns this into a real upsert, which is
     * what makes scripts/seed-services.js safe to re-run after a price change
     * instead of appending a second Argentina.
     */
    upsert({ service, variant, price, stock = null, maxQuantity = null, position = 0, image = null }) {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO service_prices (service, variant, price, stock, max_quantity, position, image, updated_at)
                 VALUES (?,?,?,?,?,?,?,?)
                 ON CONFLICT(service, variant) DO UPDATE SET
                    price = excluded.price,
                    stock = excluded.stock,
                    max_quantity = excluded.max_quantity,
                    position = excluded.position,
                    image = excluded.image,
                    updated_at = excluded.updated_at`,
                [service, variant, String(price), stock, maxQuantity, position, image, Date.now()],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }
}

module.exports = new ServicePrice();
