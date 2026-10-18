/**
 * Prove that one unit cannot be sold twice.
 *
 *   node scripts/verify-oversell.js
 *
 * The scenario the system must survive: a product with a single copy in stock,
 * two customers who have both staged it in their cart, and both hitting "buy"
 * in the same instant. The one property to demonstrate is that exactly one
 * checkout wins - the other fails with OUT_OF_STOCK - and that the failure
 * touches nothing: no order, no wallet debit, no cart drain.
 *
 * The script runs against a throwaway database it creates in the system temp
 * directory (via DATABASE_PATH, read once by app/db/createDatabase.js), so the
 * shop's real usersdb.sqlite is never touched. It then drives the real
 * checkout service twice concurrently, which opens the same BEGIN IMMEDIATE
 * write transaction the server would on two live requests.
 *
 * Exit code 0 when the property holds, 1 when it does not. Run it after any
 * change to checkout, the cart availability rules or the stock claim SQL.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

// The throwaway database must be named before anything opens one.
const tempDb = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-oversell-')),
    'usersdb.sqlite'
);
process.env.DATABASE_PATH = tempDb;

const db = require(path.join(ROOT, 'app', 'db', 'createDatabase'));
const { checkout, CheckoutError } = require(path.join(ROOT, 'app', 'services', 'checkout'));
const transaction = require(path.join(ROOT, 'app', 'db', 'transaction'));

/** Poll until every table exists and carries the columns the scenario writes. */
const REQUIRED = {
    users: ['phone', 'trade_url', 'permission'],
    products: ['price', 'count', 'sold_count'],
    cart_items: ['kind', 'product_id'],
    orders: ['status', 'total'],
    order_items: ['service', 'variant'],
    wallet_transactions: ['type', 'amount', 'reference'],
};

async function waitForSchema() {
    for (let attempt = 0; attempt < 200; attempt++) {
        const ready = await areSchemaRequirementsMet();
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error('the schema never became readable');
}

function tableColumns(table) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table})`, (err, rows) => {
            if (err) return reject(err);
            resolve(rows.map((row) => row.name));
        });
    });
}

async function areSchemaRequirementsMet() {
    for (const [table, columns] of Object.entries(REQUIRED)) {
        let names;
        try {
            names = await tableColumns(table);
        } catch {
            return false;
        }
        // An empty list means the table does not exist yet; the migrations also
        // add columns asynchronously, so every required column must be there.
        if (names.length === 0 || !columns.every((column) => names.includes(column))) {
            return false;
        }
    }
    return true;
}

function insert(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this.lastID);
        });
    });
}

function get(sql, params) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row ?? null)));
    });
}

async function main() {
    await waitForSchema();

    const now = Date.now();

    // Two buyers, each with money enough for dozens of purchases, so the only
    // thing being raced is the single unit of stock.
    const buyerA = await insert(
        `INSERT INTO users (name, phone, trade_url, permission, created_at) VALUES (?,?,?,?,?)`,
        ['رکورد الف', '09120000001', 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=a', 'NoAccess', now]
    );
    const buyerB = await insert(
        `INSERT INTO users (name, phone, trade_url, permission, created_at) VALUES (?,?,?,?,?)`,
        ['رکورد ب', '09120000002', 'https://steamcommunity.com/tradeoffer/new/?partner=2&token=b', 'NoAccess', now]
    );

    const product = await insert(
        `INSERT INTO products (productNumber, title, price, count, sold_count, created_at)
         VALUES (?,?,?,?,0,?)`,
        ['V-1', 'یونیک آخرین نسخه', '1000000', 1, now]
    );

    for (const userId of [buyerA, buyerB]) {
        await insert(
            `INSERT INTO wallet_transactions (user_id, type, amount, reference, created_at) VALUES (?,?,?,?,?)`,
            [userId, 'topup', 10000000, 'seed', now]
        );
        await insert(
            `INSERT INTO cart_items (user_id, kind, product_id, quantity, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
            [userId, 'product', product, 1, now, now]
        );
    }

    // The two requests, racing. Promise.allSettled is the honest shape: we care
    // about one win and one loss, not which request arrived first.
    const [resultA, resultB] = await Promise.allSettled([
        checkout({ id: buyerA, phone: '09120000001', trade_url: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=a' }),
        checkout({ id: buyerB, phone: '09120000002', trade_url: 'https://steamcommunity.com/tradeoffer/new/?partner=2&token=b' }),
    ]);

    const outcomes = [resultA, resultB];
    const winners = outcomes.filter((r) => r.status === 'fulfilled');
    const losers = outcomes.filter((r) => r.status === 'rejected');

    let pass = true;
    const fail = (reason) => { pass = false; console.error(`    ✗ ${reason}`); };

    if (winners.length !== 1) fail(`expected exactly one fulfilled checkout, got ${winners.length}`);
    if (losers.length !== 1) fail(`expected exactly one rejected checkout, got ${losers.length}`);

    const refusal = losers[0]?.reason;
    if (!(refusal instanceof CheckoutError)) fail(`the refunded checkout should refuse with a CheckoutError, saw ${refusal}`);
    if (refusal && refusal.code !== 'OUT_OF_STOCK') fail(`expected the refusal to be OUT_OF_STOCK, was ${refusal.code}`);

    // The stock: one copy claimed once, by one order.
    const productRow = await get(`SELECT count, sold_count, sold_order_id FROM products WHERE id = ?`, [product]);
    if (Number(productRow?.sold_count) !== 1) fail(`sold_count should be exactly 1, was ${productRow?.sold_count}`);
    if (Number(productRow?.sold_order_id) !== Number(winners[0]?.value?.order?.id ?? -1)) {
        fail('sold_order_id should name the winning order');
    }

    // The money: one purchase debit across both wallets, exactly the total of one order.
    const debits = await new Promise((resolve, reject) => {
        db.all(`SELECT user_id, amount FROM wallet_transactions WHERE type = 'purchase'`, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
    if (debits.length !== 1) fail(`expected exactly one purchase debit, got ${debits.length}`);
    if (debits.length === 1 && Number(debits[0].amount) !== 1000000) fail('the winning debit should be the product price');

    // The carts: the winner's drained, the loser's still holding the line.
    const winnerId = winners[0]?.value?.order?.user_id;
    for (const userId of [buyerA, buyerB]) {
        const cartLine = await get(`SELECT id FROM cart_items WHERE user_id = ?`, [userId]);
        if (userId === winnerId && cartLine) fail('the winning cart should have been drained');
        if (userId !== winnerId && !cartLine) fail('the losing cart must keep its line - a refused checkout must not eat the cart');
    }

    console.log('');
    console.log(`  product #${product}   one copy   two buyers racing`);
    console.log(`  winner: '${winners[0]?.status === 'fulfilled' ? `order ${winners[0]?.value?.order?.id}` : '-'}'   loser: ${refusal?.code ?? '-'}`);
    console.log('');
    if (pass) {
        console.log('  PASS  one unit cannot be sold twice; the refused checkout left wallet and cart untouched.');
    } else {
        console.error('  FAIL  see the ✗ lines above.');
    }

    // Closing the shared handle lets Windows delete the temp folder.
    db.close(() => {
        fs.rmSync(path.dirname(tempDb), { recursive: true, force: true });
        process.exit(pass ? 0 : 1);
    });
}

main().catch((err) => {
    console.error(err);
    // The connection must be closed before Windows will delete the folder.
    db.close(() => {
        fs.rmSync(path.dirname(tempDb), { recursive: true, force: true });
        process.exit(1);
    });
});
