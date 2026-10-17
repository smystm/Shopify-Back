const db = require("../createDatabase");
const { TRADE_OFFER_STATUS } = require("../../services/orders");

/** Trade offers belonging to one user, newest first. Scoped by user_id. */
class TradeOffer {
    allForUser(userId) {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT id, order_id, user_id, direction, status, steam_offer_url, created_at, responded_at
                 FROM trade_offers WHERE user_id = ? ORDER BY created_at DESC`,
                [userId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows);
                }
            );
        });
    }

    findForUser(id, userId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT id, order_id, user_id, direction, status, steam_offer_url, created_at, responded_at
                 FROM trade_offers WHERE id = ? AND user_id = ?`,
                [id, userId],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row ?? null);
                }
            );
        });
    }

    create({ orderId = null, userId, direction, status = TRADE_OFFER_STATUS.PENDING, steamOfferUrl = null }) {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO trade_offers (order_id, user_id, direction, status, steam_offer_url, created_at) VALUES (?,?,?,?,?,?)`,
                [orderId, userId, direction, status, steamOfferUrl, Date.now()],
                function (err) {
                    if (err) return reject(err);
                    resolve({ id: this.lastID });
                }
            );
        });
    }

    /**
     * Accepting or declining is only valid once, so a repeated tap on a stale
     * button cannot overwrite an earlier decision.
     */
    respond(id, userId, status) {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE trade_offers SET status = ?, responded_at = ? WHERE id = ? AND user_id = ? AND status = ?`,
                [status, Date.now(), id, userId, TRADE_OFFER_STATUS.PENDING],
                function (err) {
                    if (err) return reject(err);
                    // changes === 0 means it was already answered.
                    resolve(this.changes > 0);
                }
            );
        });
    }

    pendingCountForUser(userId) {
        return new Promise((resolve, reject) => {
            db.get(
                `SELECT COUNT(*) AS count FROM trade_offers WHERE user_id = ? AND status = ?`,
                [userId, TRADE_OFFER_STATUS.PENDING],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row?.count ?? 0);
                }
            );
        });
    }
}

module.exports = new TradeOffer();