const db = require("../createDatabase");

/**
 * Every product column the storefront and the admin are allowed to see.
 *
 * `sold_order_id` is here on purpose: the product page has to be able to say
 * "sold" and disable its button, and the listing cannot know that unless the
 * flag comes back with the row.
 *
 * `findBy` uses `SELECT *` instead, because it is the one path that hands a row
 * to the checkout machinery, and a projection that quietly omitted a column would
 * turn a claim into a no-op. The two lists are therefore deliberately different,
 * and this one is the narrow one.
 */
const PUBLIC_COLUMNS = `id, productNumber, title, desc, category, price, image, created_by, created_at,
        sold_order_id, count, sold_count, exterior, float_min, float_max, pattern_index,
        stattrak, souvenir, rarity, collection, release_at`;

class Product {

    /**
     * Columns this repo is willing to INSERT, with how each is bound.
     *
     * The route is the whitelister - it decides what a request body may say -
     * and this table is what decides what may reach a column at all, so an
     * unexpected key in `data` is skipped rather than interpolated into the
     * SQL. `created_at` is always supplied by the repo itself.
     */
    static WRITABLE = ['productNumber', 'title', 'desc', 'category', 'price', 'image', 'created_by',
        'count', 'exterior', 'float_min', 'float_max', 'pattern_index', 'stattrak', 'souvenir',
        'rarity', 'collection', 'release_at'];

    create(data) {
        return new Promise((resolve, reject) => {
            // Only the keys both sides agreed on, plus the created_at the repo owns.
            const columns = [...Product.WRITABLE.filter((key) => key in data), 'created_at'];
            const placeholders = columns.map(() => '?').join(', ');
            const values = columns.map((key) => {
                if (key === 'created_at') return Date.now();
                if (key === 'category') return typeof data.category === 'object' ? JSON.stringify(data.category) : data.category;
                // Defaults to 1 rather than NULL. A NULL would read as one anyway, but
                // writing the figure explicitly means the row says what it means and
                // the admin panel has something to show.
                if (key === 'count') return Number.isFinite(data.count) && data.count > 0 ? Math.floor(data.count) : 1;
                return data[key] ?? null;
            });

            const sql = `INSERT INTO products (${columns.join(', ')}) VALUES (${placeholders})`;

            db.run(sql, values, function (err) {
                if (err) return reject(err);

                resolve({ id: this.lastID });
            });
        })
    }

    findBy(field, value) {
        return new Promise((resolve, reject) => {
            db.get(`SELECT * FROM products WHERE ${field} = ?`, value, function (err, product) {
                if (err) return reject(err);

                if (product && product.category) {
                    try {
                        product.category = JSON.parse(product.category);
                    } catch (e) {
                    }
                }
                resolve(product);
            });
        });
    }

    all() {
        return new Promise((resolve, reject) => {
            db.all(`SELECT ${PUBLIC_COLUMNS} FROM products ORDER BY created_at ASC`, function (err, rows) {
                if (err) return reject(err);

                const parsed = rows.map(row => ({
                    ...row,
                    category: row.category ? JSON.parse(row.category) : null,
                }));
                resolve(parsed);
            });
        });
    }

    /**
     * Units sold per product, counted from orders that actually completed.
     *
     * Pending, escrowed, disputed, refunded and cancelled orders are all
     * excluded, so a product that was bought and then refunded does not outrank
     * one that stayed sold. `product_id` is nullable because order items are
     * snapshotted to survive a product being edited or deleted, so those rows
     * are dropped rather than counted against a null id.
     *
     * Only called when the caller actually asks for best-selling, so the common
     * listing stays a single SELECT.
     */
    salesCounts() {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT oi.product_id AS productId, COUNT(*) AS sold
                 FROM order_items oi
                 JOIN orders o ON o.id = oi.order_id
                 WHERE o.status = ? AND oi.product_id IS NOT NULL
                 GROUP BY oi.product_id`,
                ['completed'],
                function (err, rows) {
                    if (err) return reject(err);
                    resolve(new Map(rows.map(r => [Number(r.productId), Number(r.sold)])));
                }
            );
        });
    }

    /**
     * Ordering applied after filtering, so a sorted listing is identical
     * whether or not other filters are active.
     *
     * `price` is a TEXT column, so it is compared as a number - a plain string
     * compare would rank "95000000" below "50000". Rows without a usable price
     * sink to the bottom of a price sort instead of interleaving.
     *
     * When no order has ever completed, every sold count is 0 and "best
     * selling" would be an arbitrary tie, so it falls back to newest-first.
     */
    static sortProducts(products, sort, sales) {
        const byPrice = (a, b) => {
            const av = Number(a.price);
            const bv = Number(b.price);
            const aBad = Number.isNaN(av);
            const bBad = Number.isNaN(bv);
            if (aBad && bBad) return 0;
            if (aBad) return 1;
            if (bBad) return -1;
            return av - bv;
        };
        const newestFirst = (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0);

        if (sort === 'price_asc') return [...products].sort(byPrice);

        if (sort === 'price_desc') return [...products].sort((a, b) => -byPrice(a, b));

        if (sort === 'best_selling') {
            const soldOf = (p) => (sales ? sales.get(Number(p.id)) || 0 : 0);
            return [...products].sort((a, b) => {
                const diff = soldOf(b) - soldOf(a);
                // Equal sales fall back to newest-first, which is also what makes
                // the listing deterministic while the order book is still empty.
                return diff !== 0 ? diff : newestFirst(a, b);
            });
        }

        return products;
    }

    allFiltered({ categories = [], subcategories = [], minPrice, maxPrice, search, sort } = {}) {
        // The db.all callback below is a plain `function`, so `this` inside it
        // is sqlite3's Statement rather than this repo. Capture the receiver.
        const self = this;

        return new Promise((resolve, reject) => {
            db.all(`SELECT ${PUBLIC_COLUMNS} FROM products ORDER BY created_at ASC`, function (err, rows) {
                if (err) return reject(err);

                let parsed = rows.map(row => ({
                    ...row,
                    category: row.category ? JSON.parse(row.category) : null,
                }));

                if (Array.isArray(categories) && categories.length > 0) {
                    parsed = parsed.filter(p => p.category && categories.includes(p.category.value));
                }

                if (Array.isArray(subcategories) && subcategories.length > 0) {
                    parsed = parsed.filter(p => p.category && subcategories.includes(p.category.subcategory));
                }

                if (minPrice !== undefined && minPrice !== null && minPrice !== '') {
                    const min = Number(minPrice);
                    if (!Number.isNaN(min)) {
                        parsed = parsed.filter(p => Number(p.price) >= min);
                    }
                }

                if (maxPrice !== undefined && maxPrice !== null && maxPrice !== '') {
                    const max = Number(maxPrice);
                    if (!Number.isNaN(max)) {
                        parsed = parsed.filter(p => Number(p.price) <= max);
                    }
                }

                if (typeof search === 'string' && search.trim() !== '') {
                    // Titles look like "★ Bayonet | Doppler", so this matches
                    // both the weapon and the skin name. Matching in JS keeps it
                    // consistent with the other filters here rather than
                    // splitting the logic across SQL and JS.
                    const needle = search.trim().toLowerCase();
                    parsed = parsed.filter(p => {
                        const title = (p.title || '').toLowerCase();
                        const number = (p.productNumber || '').toLowerCase();
                        return title.includes(needle) || number.includes(needle);
                    });
                }

                if (!sort) return resolve(parsed);

                const finish = (sales) => resolve(Product.sortProducts(parsed, sort, sales));

                if (sort === 'best_selling') {
                    // One extra query, but only on this path.
                    return self.salesCounts().then(finish, () => finish(null));
                }

                return finish(null);
            });
        });
    }

    update(id, data) {
        let fieldMustUpdate = Object.keys(data).map(item => `${item}=$${item}`).join(',');
        let fieldData = {};
        Object.keys(data).forEach(item => {
            fieldData[`$${item}`] = item === 'category' && typeof data[item] === 'object'
                ? JSON.stringify(data[item])
                : data[item];
        })

        return new Promise((resolve, reject) => {
            db.run(`UPDATE products SET ${fieldMustUpdate} WHERE id = $id`, { $id: id, ...fieldData }, function (err) {
                if (err) return reject(err)

                resolve()
            })
        });
    }

    delete(id) {
        return new Promise((resolve, reject) => {
            db.run(`DELETE FROM products WHERE id = ?`, [id], function (err) {
                if (err) return reject(err);

                resolve();
            });
        });
    }
}

module.exports = new Product();
