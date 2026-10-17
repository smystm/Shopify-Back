const db = require("../createDatabase");

/**
 * Wallet balance is derived from the ledger rather than stored, so it can
 * never drift and the user can never write to it directly.
 */
class Wallet {
    transactionsForUser(userId, limit = 100) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, user_id, type, amount, reference, created_at
                 FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
                [userId, limit],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    balanceForUser(userId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT COALESCE(SUM(CASE
                        WHEN type = 'topup'  THEN  amount
                        WHEN type = 'purchase' THEN -amount
                        WHEN type = 'refund'  THEN  amount
                        ELSE 0 END), 0) AS balance
                 FROM wallet_transactions WHERE user_id = ?`,
                [userId],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(Number(row?.balance ?? 0));
                }
            );
        });
    }

    add({ userId, type, amount, reference = null }) {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO wallet_transactions (user_id, type, amount, reference, created_at) VALUES (?,?,?,?,?)`,
                [userId, type, amount, reference, Date.now()],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }
}

module.exports = new Wallet();