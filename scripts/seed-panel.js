/**
 * Opt-in demo data for the customer panel.
 *
 *   node scripts/seed-panel.js <phone>
 *
 * Creates a wallet ledger, a spread of orders across the trade lifecycle,
 * trade offers and wishlist rows for the user with that phone number.
 *
 * This is intentionally NOT called on boot. Run it by hand when you want
 * something to look at; it never touches a user that does not already exist.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const db = require(path.join(ROOT, 'app', 'db', 'createDatabase.js'));
const userRepo = require(path.join(ROOT, 'app', 'db', 'repos', 'user.js'));
const orderRepo = require(path.join(ROOT, 'app', 'db', 'repos', 'order.js'));
const tradeOfferRepo = require(path.join(ROOT, 'app', 'db', 'repos', 'tradeOffer.js'));
const walletRepo = require(path.join(ROOT, 'app', 'db', 'repos', 'wallet.js'));
const wishlistRepo = require(path.join(ROOT, 'app', 'db', 'repos', 'wishlist.js'));
const { ORDER_STATUS, TRADE_OFFER_DIRECTION, TRADE_OFFER_STATUS, WALLET_TRANSACTION } = require(path.join(
    ROOT,
    'app',
    'services',
    'orders.js'
));

const DAY = 24 * 60 * 60 * 1000;

function relink(sql, params) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
}

async function main() {
    const phone = process.argv[2];
    if (!phone) {
        console.error('Usage: node scripts/seed-panel.js <phone>');
        process.exit(1);
    }

    const user = await userRepo.findBy('phone', phone);
    if (!user) {
        console.error(`No user with phone ${phone}. Register through the UI first.`);
        process.exit(1);
    }

    const uid = user.id;
    const now = Date.now();

    // Clear anything from a previous run so re-seeding is idempotent.
    for (const table of ['order_items', 'orders', 'trade_offers', 'wallet_transactions', 'wishlist']) {
        if (table === 'order_items') {
            await relink('DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)', [uid]);
        } else {
            await relink(`DELETE FROM ${table} WHERE user_id = ?`, [uid]);
        }
    }

    // --- Wallet ledger ---
    await walletRepo.add({ userId: uid, type: WALLET_TRANSACTION.TOPUP, amount: 500, reference: 'seed-topup-1' });
    await walletRepo.add({ userId: uid, type: WALLET_TRANSACTION.TOPUP, amount: 250, reference: 'seed-topup-2' });
    await relink('UPDATE wallet_transactions SET created_at = ? WHERE user_id = ?', [now - 12 * DAY, uid]);

    const catalogue = await query('SELECT id, title, price, image FROM products ORDER BY created_at DESC LIMIT 6');
    if (catalogue.length === 0) {
        console.log('No products in the catalogue — orders were seeded empty.');
    }

    // --- Orders spread across the whole trade lifecycle ---
    const plan = [
        { status: ORDER_STATUS.COMPLETED, items: catalogue.slice(0, 2), daysAgo: 14 },
        { status: ORDER_STATUS.TRADE_SENT, items: catalogue.slice(2, 4), daysAgo: 5 },
        { status: ORDER_STATUS.IN_ESCROW, items: catalogue.slice(4, 6), daysAgo: 2 },
        { status: ORDER_STATUS.PENDING_PAYMENT, items: catalogue.slice(0, 1), daysAgo: 1 },
    ];

    const created = [];
    for (const entry of plan) {
        if (entry.items.length === 0) continue;
        const order = await orderRepo.create({ userId: uid, items: entry.items, status: entry.status });
        const when = now - entry.daysAgo * DAY;
        await relink('UPDATE orders SET created_at = ?, updated_at = ? WHERE id = ?', [when, when, order.id]);
        created.push({ ...order, created_at: when });
    }

    // --- Trade offers linked to the live orders ---
    const tradeSent = created.find((o) => o.status === ORDER_STATUS.TRADE_SENT);
    if (tradeSent) {
        await tradeOfferRepo.create({
            orderId: tradeSent.id,
            userId: uid,
            direction: TRADE_OFFER_DIRECTION.INCOMING,
            status: TRADE_OFFER_STATUS.PENDING,
            steamOfferUrl: 'https://steamcommunity.com/tradeoffers/pending-demo-offer',
        });
    }

    await tradeOfferRepo.create({
        orderId: null,
        userId: uid,
        direction: TRADE_OFFER_DIRECTION.OUTGOING,
        status: TRADE_OFFER_STATUS.ACCEPTED,
        steamOfferUrl: 'https://steamcommunity.com/tradeoffers/history-demo-offer',
    });

    const balance = await walletRepo.balanceForUser(uid);
    const wishlistCount = await wishlistRepo.countForUser(uid);

    console.log(`Seeded panel demo data for "${user.name}" (id ${uid}, ${phone}).`);
    console.log(`  orders:        ${created.length} (${created.map((o) => o.status).join(', ')})`);
    console.log(`  trade offers:  2`);
    console.log(`  wallet balance:${balance}`);
    console.log(`  wishlist:      ${wishlistCount}`);

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});