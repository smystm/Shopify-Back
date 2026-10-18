/**
 * One-shot E2E helper: plant a clearly-marked demo top-up in the wallet ledger
 * so the knife trade-offer flow can be exercised end to end.
 *
 *   node scripts/seed-e2e-wallet.js            # seed 96,000,000 to user 2
 *   node scripts/seed-e2e-wallet.js --remove   # delete the marker row instead
 *
 * The row is idempotent: it exists at most once (guarded by its reference),
 * and the marker makes manual cleanup trivial:
 *   DELETE FROM wallet_transactions WHERE reference='manual-test-e2e-2026';
 */
const db = require('sqlite3');

const REFERENCE = 'manual-test-e2e-2026';
const USER_ID = 2;
const AMOUNT = 96_000_000;
const DB_FILE = 'usersdb.sqlite';

const s = new db.Database(DB_FILE);
s.serialize(() => {
    s.run('PRAGMA busy_timeout = 5000');

    s.get(
        `SELECT COALESCE(SUM(CASE
             WHEN type='topup'    THEN amount
             WHEN type='purchase' THEN -amount
             WHEN type='refund'   THEN  amount
             ELSE 0 END), 0) AS bal
         FROM wallet_transactions WHERE user_id = ?`,
        [USER_ID],
        (e, r) => console.log(`user ${USER_ID} balance before:`, e ? `ERR ${e.message}` : r.bal),
    );

    if (process.argv.includes('--remove')) {
        s.run(`DELETE FROM wallet_transactions WHERE user_id = ? AND reference = ?`, [USER_ID, REFERENCE], function (err) {
            console.log(err ? `DELETE ERR ${err.message}` : `removed ${this.changes} marker row(s)`);
        });
    } else {
        // re-check inside serialize() so reads/writes stay ordered
        s.get(`SELECT id FROM wallet_transactions WHERE user_id = ? AND reference = ?`, [USER_ID, REFERENCE], (e, r) => {
            if (r) return console.log('ALREADY SEEDED, skipping');
            s.run(
                `INSERT INTO wallet_transactions (user_id, type, amount, reference, created_at) VALUES (?,?,?,?,?)`,
                [USER_ID, 'topup', AMOUNT, REFERENCE, Date.now()],
                (err) => console.log(err ? `INSERT ERR ${err.message}` : `seeded ${AMOUNT} (${REFERENCE})`),
            );
        });
    }
});

setTimeout(() => {
    s.get(
        `SELECT COALESCE(SUM(CASE
             WHEN type='topup'    THEN amount
             WHEN type='purchase' THEN -amount
             WHEN type='refund'   THEN  amount
             ELSE 0 END), 0) AS bal
         FROM wallet_transactions WHERE user_id = ?`,
        [USER_ID],
        (e, r) => { console.log(`user ${USER_ID} balance after :`, e ? `ERR ${e.message}` : r.bal); s.close(); },
    );
}, 600);
