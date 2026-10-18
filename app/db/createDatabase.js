const sqlite3 = require('sqlite3').verbose()
const path = require('path')

/**
 * Absolute, anchored to the backend's own directory rather than to process.cwd().
 *
 * This was the bare string "usersdb.sqlite", which sqlite3 resolves against the
 * working directory. Starting the server from a different folder therefore opened
 * a *different* file: the stale usersdb.sqlite in the repo root has only
 * `users`, `products` and `phone_verification` in it, so a server started from
 * there answered every cart request with "no such table: cart_items" while the
 * catalogue, the panel and the wallet all looked perfectly healthy.
 *
 * One database, one path, whoever launches the process.
 *
 * `DATABASE_PATH` overrides it, for the one case where the default is not
 * available: in a container the database needs to sit on a mounted volume, or it
 * lives and dies with the image. It must name the same file from every process -
 * the checkout runs its transaction on a private connection that re-derives this
 * path - so it is resolved once, here, and read again from `db.filename`.
 */
const DBSOURCE = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', '..', 'usersdb.sqlite')
const bcrypt = require('bcryptjs');
const { productImageForTitle } = require('../services/productImages');
const { categoryForTitle } = require('../services/categories');

let db = new sqlite3.Database(DBSOURCE, (err) => {
    if (err) {
      // Cannot open database
      console.error(err.message)
      throw err
    } 
    else {        
        var salt = bcrypt.genSaltSync(10);
        
        db.run(`CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name text,
                phone text,             
                token text,
                loggedin_at TIMESTAMP,
                created_at TIMESTAMP,
                permission text DEFAULT 'NoAccess'
            )`,
        (err) => {
            if (err) {
                // Table already created
            } else{
                // Table just created, creating some rows
                var insert = 'INSERT INTO Users (name, phone, permission, created_at) VALUES (?,?,?,?)'
                // The seed user is the first admin so permissions can be managed after install.
                db.run(insert, ["hesam", "09381329963", "FullAcc", Date.now()])
            }
        });

        db.all(`PRAGMA table_info(users)`, (err, columns) => {
            if (err) return;
            const colNames = columns.map(c => c.name);
            const alterations = [];

            if (!colNames.includes('permission')) {
                alterations.push(`ALTER TABLE users ADD COLUMN permission text DEFAULT 'NoAccess'`);
            }
            // Steam identity + contact details. A buyer cannot receive a skin
            // trade without a Steam trade URL, so these belong on the profile.
            if (!colNames.includes('email')) alterations.push('ALTER TABLE users ADD COLUMN email text');
            if (!colNames.includes('steam_id')) alterations.push('ALTER TABLE users ADD COLUMN steam_id text');
            if (!colNames.includes('trade_url')) alterations.push('ALTER TABLE users ADD COLUMN trade_url text');
            // Steam sign-in: the persona picture is the customer's avatar.
            if (!colNames.includes('avatar')) alterations.push('ALTER TABLE users ADD COLUMN avatar text');

            alterations.forEach(sql => db.run(sql, () => {}));

            // One Steam account can only ever be one row here. Without this, a
            // double-submitted callback would race two INSERTs into two customers
            // with the same identity - and two wallets, two carts, two of
            // everything. Partial, because every phone-era account has a NULL
            // steam_id and a plain unique index would refuse more than one of them.
            db.run(
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_steam_id ON users (steam_id) WHERE steam_id IS NOT NULL`,
                () => {}
            );

            if (!colNames.includes('permission')) {
                // Users created before permissions existed had full access; keep them usable.
                db.run(`UPDATE users SET permission = 'FullAcc' WHERE permission IS NULL OR permission = ''`, () => {});
            }
        });

        // `user_id`, `expires_at` and `attempts` are declared here as well as being
        // added by the migration below, so a brand-new database gets the full
        // shape directly instead of depending on the ALTERs winning a race
        // against this CREATE.
        //
        // All rows are created and consumed through app/services/phoneVerification.js.
        // `user_id` is set only for a phone-change challenge (scoping it to the
        // requester) and left NULL for a login challenge.
        db.run(`CREATE TABLE phone_verification  (
                id text UNIQUE,
                phone text,
                code text UNIQUE,
                created_at TIMESTAMP,
                user_id INTEGER,
                expires_at TIMESTAMP,
                attempts INTEGER DEFAULT 0
            )`, (err) => {
                if (err) {
                    // Table already created
                } else{
                    // Table just created, creating some rows
                }
            })

        db.all(`PRAGMA table_info(phone_verification)`, (err, columns) => {
            if (err) return;
            const colNames = columns.map(c => c.name);
            const alterations = [];
            if (!colNames.includes('user_id')) alterations.push('ALTER TABLE phone_verification ADD COLUMN user_id INTEGER');
            if (!colNames.includes('expires_at')) alterations.push('ALTER TABLE phone_verification ADD COLUMN expires_at TIMESTAMP');
            if (!colNames.includes('attempts')) alterations.push('ALTER TABLE phone_verification ADD COLUMN attempts INTEGER DEFAULT 0');

            // Challenge rows are only ever created through the verification
            // service, which is also what enforces the TTL — the sweeper just
            // clears what expired.
            //
            // The service is required lazily (it requires this module back) and
            // the sweeper only starts once every ALTER has landed, otherwise its
            // first sweep can hit a table that has no expires_at column yet and
            // quietly sweep nothing.
            const startSweeper = () => {
                try {
                    require('../services/phoneVerification').startSweeper();
                } catch (err) {
                    console.error('[phone-verification] sweeper could not start:', err.message);
                }
            };

            let remaining = alterations.length;
            if (remaining === 0) {
                startSweeper();
            } else {
                alterations.forEach(sql => db.run(sql, () => { if (--remaining === 0) startSweeper(); }));
            }
        });

        db.run(`CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                productNumber text,
                title text,
                desc text,
                category text,
                price text,
                image text,
                created_by INTEGER,
                created_at TIMESTAMP
             )`, (err) => {
                if (err) {
                    // Table already created
                } else{
                    // Table just created, creating some rows
                }
            })

        db.all(`PRAGMA table_info(products)`, (err, columns) => {
            if (err) return;
            const colNames = columns.map(c => c.name);
            const alterations = [];
            if (!colNames.includes('desc')) alterations.push('ALTER TABLE products ADD COLUMN desc text');
            if (!colNames.includes('category')) alterations.push('ALTER TABLE products ADD COLUMN category text');
            if (!colNames.includes('price')) alterations.push('ALTER TABLE products ADD COLUMN price text');
            if (!colNames.includes('image')) alterations.push('ALTER TABLE products ADD COLUMN image text');
            // created_by links products to the user who added them.
            if (!colNames.includes('created_by')) alterations.push('ALTER TABLE products ADD COLUMN created_by INTEGER');
            // A skin is a single physical item, so once it belongs to an order it
            // must never be sold to a second customer. NULL means still available.
            // Set inside the checkout transaction; the cart refuses to hold a row
            // whose product is already claimed.
            if (!colNames.includes('sold_order_id')) alterations.push('ALTER TABLE products ADD COLUMN sold_order_id INTEGER');

            // ---- CS2 item specifications ----
            // Nullable on purpose, and that nullability IS the category-awareness.
            // A weapon skin, knife or glove has an exterior and a float range; a
            // case, music kit, agent, sticker, charm or patch has none and never
            // will. Keeping every column optional is what lets one table describe
            // all of them without inventing values that do not apply.
            //
            // One listing is a stock, not a single copy: `count` is what exists,
            // `sold_count` is what has gone, and checkout draws the difference
            // down inside its transaction. A listing with no `count` still reads
            // as one, so a row nobody has stocked stays one-of-a-kind rather than
            // becoming unlimited.
            //
            // `exterior` uses Valve's five names; `float_min`/`float_max` are the
            // real bounds that go with them.
            if (!colNames.includes('exterior')) alterations.push('ALTER TABLE products ADD COLUMN exterior text');
            if (!colNames.includes('float_min')) alterations.push('ALTER TABLE products ADD COLUMN float_min REAL');
            if (!colNames.includes('float_max')) alterations.push('ALTER TABLE products ADD COLUMN float_max REAL');
            if (!colNames.includes('stattrak')) alterations.push('ALTER TABLE products ADD COLUMN stattrak INTEGER DEFAULT 0');
            if (!colNames.includes('souvenir')) alterations.push('ALTER TABLE products ADD COLUMN souvenir INTEGER DEFAULT 0');
            // Rarity tier as Valve names it: Consumer, Industrial, Mil-Spec,
            // Restricted, Classified, Covert, and Extraordinary / Contraband for
            // the star items.
            if (!colNames.includes('rarity')) alterations.push('ALTER TABLE products ADD COLUMN rarity text');
            // Which case it came out of, e.g. "Revolution Case".
            if (!colNames.includes('collection')) alterations.push('ALTER TABLE products ADD COLUMN collection text');
            if (!colNames.includes('release_at')) alterations.push('ALTER TABLE products ADD COLUMN release_at TIMESTAMP');
            // Stat Pattern (paint seed) 0-1000. NULL when it is not known, which is
            // almost always - it is a per-copy value, not a property of the item.
            if (!colNames.includes('pattern_index')) alterations.push('ALTER TABLE products ADD COLUMN pattern_index INTEGER');

            // ---- Stock, and what has been sold of it ----
            //
            // `count` is how many copies of the listing exist. `sold_count` is how
            // many have been taken. Availability is the difference, and it is the
            // same arithmetic a service line uses against `service_prices.stock` -
            // which is what lets one cart serve both kinds of line.
            //
            // A NULL `count` reads as 1, not as unlimited: a row whose stock nobody
            // has thought about must never turn into an unlimited offer.
            //
            // `sold_order_id` stays. It is no longer what decides availability - it
            // is now the order that most recently took a unit, kept so a single-copy
            // claim is still traceable and so the old guard still has something to
            // point at.
            if (!colNames.includes('count')) alterations.push('ALTER TABLE products ADD COLUMN count INTEGER');
            if (!colNames.includes('sold_count')) alterations.push('ALTER TABLE products ADD COLUMN sold_count INTEGER DEFAULT 0');
            alterations.forEach(sql => db.run(sql, () => {}));

            // A row claimed before stock existed was, by definition, a one-of-a-kind
            // skin: the old guard took the whole row and put `sold_order_id` on it.
            // Counting that as one unit sold is what keeps an already-sold item sold
            // instead of quietly putting it back on the shelf.
            if (colNames.includes('sold_order_id')) {
                db.run(
                    `UPDATE products SET sold_count = 1
                      WHERE sold_order_id IS NOT NULL AND (sold_count IS NULL OR sold_count = 0)`,
                    () => {}
                );
            }

            // Migrate existing products to the skins directory structure.
            // Each folder in skins/ represents a category; update image and category accordingly.
            db.all(`SELECT id, title, category, image FROM products`, (productsErr, products) => {
                if (productsErr) return;

                // Async because the category lookup is: it reads the products table
                // to work out which categories exist, rather than listing a folder
                // of images in another repository. The surrounding code never waited
                // on this migration, so it still does not - a slow or failing
                // backfill must not hold up the rest of the boot.
                void (async () => {
                    for (const product of products) {
                        // Keep an explicitly assigned subcategory image intact. This
                        // migration only backfills legacy rows with no image value.
                        if (product.image) continue;

                        try {
                            const matchedCategory = await categoryForTitle(product.title);
                            if (!matchedCategory) continue;

                            const newImage = await productImageForTitle(product.title);
                            const categoryJson = JSON.stringify(matchedCategory);
                            await new Promise((resolve) =>
                                db.run(`UPDATE products SET image = ?, category = ? WHERE id = ?`, [newImage, categoryJson, product.id], resolve)
                            );
                        } catch (err) {
                            console.warn(`[migrate] could not classify product ${product.id}: ${err.message}`);
                        }
                    }
                })();
            });
        })

        // ---- Customer account tables ----
        // A skin is delivered through a Steam trade, not a shipment, so order
        // status tracks the escrow -> trade -> completed lifecycle.
        //
        // Every dependent index is created inside its table's completion
        // callback. sqlite3 does not promise statement order across separate
        // prepares, and on a database that already had these tables an index
        // racing ahead of a no-op CREATE TABLE was harmless - it simply
        // re-landed. On a brand-new one (a container's first boot against a
        // fresh volume) the same race dies with "no such table", so the
        // ordering here is causal: the index runs exactly when the table
        // provably exists.
        db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                status text DEFAULT 'pending_payment',
                total REAL DEFAULT 0,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
             )`, (err) => {
                if (err) return console.log(err);
                db.run(`CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at)`, (err) => { if (err) console.log(err) })
            })

        // Items are snapshotted so order history survives a product being edited or deleted.
        //
        // Two kinds of line share this table. A skin line carries `product_id` and a
        // `title`, and is always `quantity` 1 because a skin is a unique item. A
        // service line (CS2 Prime by region, TF2 keys) carries `service`/`variant`
        // instead - machine values only, matching `service_prices`, because the
        // backend holds no Persian copy. The client resolves the label from
        // app/lib/i18n/fa.ts.
        db.run(`CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL,
                product_id INTEGER,
                title text,
                price REAL,
                quantity INTEGER NOT NULL DEFAULT 1,
                service text,
                variant text,
                image text,
                created_at TIMESTAMP
             )`, (err) => { if (err) console.log(err) })

        db.all(`PRAGMA table_info(order_items)`, (err, columns) => {
            if (err) return;
            const colNames = columns.map(c => c.name);
            const alterations = [];
            if (!colNames.includes('quantity')) alterations.push('ALTER TABLE order_items ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
            if (!colNames.includes('service')) alterations.push('ALTER TABLE order_items ADD COLUMN service text');
            if (!colNames.includes('variant')) alterations.push('ALTER TABLE order_items ADD COLUMN variant text');
            alterations.forEach(sql => db.run(sql, () => {}));
        })

        db.run(`CREATE TABLE IF NOT EXISTS trade_offers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER,
                user_id INTEGER NOT NULL,
                direction text,
                status text DEFAULT 'pending',
                steam_offer_url text,
                created_at TIMESTAMP,
                responded_at TIMESTAMP
             )`, (err) => { if (err) console.log(err) })

        db.run(`CREATE TABLE IF NOT EXISTS wallet_transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type text NOT NULL,
                amount REAL NOT NULL,
                reference text,
                created_at TIMESTAMP
             )`, (err) => {
                if (err) return console.log(err);
                db.run(`CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions (user_id, created_at)`, (err) => { if (err) console.log(err) })
            })

        db.run(`CREATE TABLE IF NOT EXISTS wishlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                target_price REAL,
                created_at TIMESTAMP
             )`, (err) => {
                if (err) return console.log(err);
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_user_product ON wishlist (user_id, product_id)`, (err) => { if (err) console.log(err) })
            })

        // ---- Non-skin goods: CS2 Prime and TF2 Mann Co. keys ----
        // Priced here rather than in `products` on purpose. A product's category
        // is resolved against the folder names under
        // public/images/weapons-real/skins, so a `prime` row would also have
        // appeared as a thirteenth category tile on the home page, as an entry
        // in the product filter, and inside the live catalogue counts - none of
        // which describe a Prime upgrade or a key.
        //
        // `variant` is a machine value (`argentina`, `key`) and its Persian label
        // lives in app/lib/i18n/fa.ts, the same split the catalogue uses for
        // category folder names. `price` is TEXT to match products.price.
        //
        // `image` exists so a service line can be snapshotted into an order the
        // same way a skin is. Without it the cart and the order history would have
        // to hardcode the storefront artwork, and a past order would silently
        // change if that artwork ever moved.
        db.run(`CREATE TABLE IF NOT EXISTS service_prices (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                service text NOT NULL,
                variant text NOT NULL,
                price text NOT NULL,
                stock INTEGER,
                max_quantity INTEGER,
                position INTEGER DEFAULT 0,
                image text,
                updated_at TIMESTAMP
             )`, (err) => {
                if (err) return console.log(err);
                // Makes scripts/seed-services.js re-runnable: the upsert matches
                // on this pair, so re-seeding rewrites the numbers instead of
                // duplicating rows. Inside the callback for the same reason as
                // the indexes above.
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_service_prices_service_variant ON service_prices (service, variant)`, (err) => { if (err) console.log(err) })
            })

        db.all(`PRAGMA table_info(service_prices)`, (err, columns) => {
            if (err) return;
            const colNames = columns.map(c => c.name);
            if (!colNames.includes('image')) db.run('ALTER TABLE service_prices ADD COLUMN image text', () => {});
        })

        // ---- The cart ----
        // Unpaid, mutable staging area. Orders are the immutable record; a cart
        // row has no status and no money behind it, so the two are deliberately
        // different tables rather than one table with a flag.
        //
        // One table holds both kinds of line, discriminated by `kind`:
        //   kind='product' -> product_id set, quantity always 1 (a skin is one
        //                     physical item, so "two of this skin" is unsellable)
        //   kind='service' -> service + variant set, quantity bounded by the
        //                     service_prices stock / max_quantity figures
        db.run(`CREATE TABLE IF NOT EXISTS cart_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                kind text NOT NULL,
                product_id INTEGER,
                service text,
                variant text,
                quantity INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMP,
                updated_at TIMESTAMP
             )`, (err) => {
                if (err) return console.log(err);
                // Partial indexes: two line kinds live in one table but each needs
                // its own uniqueness rule, so each index only covers the rows it
                // describes. This is what makes "add to cart" a real upsert
                // instead of a duplicate line. Created here, inside the callback,
                // so a first boot cannot race an index against its own table.
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_user_product ON cart_items (user_id, product_id) WHERE product_id IS NOT NULL`, (err) => { if (err) console.log(err) })
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_user_service ON cart_items (user_id, service, variant) WHERE service IS NOT NULL`, (err) => { if (err) console.log(err) })
            })

        // ---- Payment intents ----
        // A record of one attempt to move money through a gateway. Kept separate
        // from orders because the store's gateway only ever *credits the wallet*;
        // orders are then paid from the wallet balance. So an intent references the
        // top-up it is for, not the order it might eventually pay for.
        //
        // `authority` is the provider's own handle for the attempt and
        // `reference_id` is what it returns once the money has actually moved.
        db.run(`CREATE TABLE IF NOT EXISTS payment_intents (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                provider text NOT NULL,
                amount REAL NOT NULL,
                status text DEFAULT 'pending',
                authority text,
                reference_id text,
                created_at TIMESTAMP,
                paid_at TIMESTAMP
             )`, (err) => {
                if (err) return console.log(err);
                db.run(`CREATE INDEX IF NOT EXISTS idx_payment_intents_user ON payment_intents (user_id, created_at)`, (err) => { if (err) console.log(err) })
                db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_intents_authority ON payment_intents (provider, authority) WHERE authority IS NOT NULL`, (err) => { if (err) console.log(err) })
            })
    }
});


module.exports = db
