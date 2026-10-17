const db = require("../createDatabase");

/**
 * One attempt to move money through a gateway.
 *
 * Intents are deliberately not tied to an order. The shop's rail is the wallet:
 * a gateway can only ever *credit* the wallet, and an order is then paid from the
 * balance. So an intent records a top-up that may or may not happen, and the
 * order it eventually pays for is a separate, later decision.
 *
 * `authority` is the provider's handle for the attempt and is what the browser
 * comes back with; `reference_id` is only filled in once the money has actually
 * moved. Column names are returned verbatim, like the other repos.
 */
class PaymentIntent {
    create({ userId, provider, amount }) {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO payment_intents (user_id, provider, amount, status, created_at) VALUES (?,?,?,?,?)`,
                [userId, provider, amount, 'pending', Date.now()],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }

    /**
     * The provider's handle, not ours.
     *
     * Scoped by provider as well as authority so two gateways can never collide on
     * an id. Returns null rather than undefined so callers can test it directly.
     */
    findByAuthority(provider, authority) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, user_id, provider, amount, status, authority, reference_id, created_at, paid_at
                 FROM payment_intents WHERE provider = ? AND authority = ?`,
                [provider, authority],
                (err, row) => (err ? reject(err) : resolve(row ?? null))
            );
        });
    }

    /** Record the handle the provider just handed us, so the callback can find this row. */
    setAuthority(id, authority) {
        return new Promise((resolve, reject) => {
            db.run(`UPDATE payment_intents SET authority = ? WHERE id = ?`, [authority, id], function (err) {
                if (err) return reject(err);
                resolve(this.changes > 0);
            });
        });
    }

    /**
     * Mark an intent as paid.
     *
     * The `status = 'pending'` guard is what makes a replayed callback harmless:
     * gateways retry, browsers get refreshed, and the second arrival changes
     * nothing, so the wallet cannot be credited twice for one payment.
     */
    markPaid(id, referenceId) {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE payment_intents SET status = 'paid', reference_id = ?, paid_at = ?
                 WHERE id = ? AND status = 'pending'`,
                [referenceId ?? null, Date.now(), id],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes > 0);
                }
            );
        });
    }

    markFailed(id, status = 'failed') {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE payment_intents SET status = ? WHERE id = ? AND status = 'pending'`,
                [status, id],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.changes > 0);
                }
            );
        });
    }

    /** The customer's own top-up history, newest first. */
    allForUser(userId, limit = 50) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, user_id, provider, amount, status, reference_id, created_at, paid_at
                 FROM payment_intents WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
                [userId, limit],
                (err, rows) => (err ? reject(err) : resolve(rows))
            );
        });
    }
}

module.exports = new PaymentIntent();
