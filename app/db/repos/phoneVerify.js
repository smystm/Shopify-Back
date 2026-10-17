const db = require("../createDatabase");

/**
 * Rows in `phone_verification` are short-lived OTP challenges. They are created
 * by app/services/phoneVerification.js and should only be reached through it —
 * this repo is the data layer, not the policy.
 */
class PhoneVerify {

    /**
     * `userId` / `expiresAt` are null for a login challenge and set for a
     * phone-change request, which is what scopes a code to its requester.
     */
    create(data) {
        return new Promise((resolve, reject) => {
            const sql =
                'INSERT INTO phone_verification (id, phone, code, created_at, user_id, expires_at, attempts) VALUES (?,?,?,?,?,?,?)';

            db.run(
                sql,
                [data.id, data.phone, data.code, Date.now(), data.userId ?? null, data.expiresAt ?? null, 0],
                function (err) {
                    if (err) return reject(err);
                    resolve();
                }
            );
        });
    }

    findBy(field, value) {
        return new Promise((resolve, reject) => {
            db.get(`SELECT * FROM phone_verification WHERE ${field} = ?`, value, function (err, row) {
                if (err) return reject(err);
                resolve(row);
            });
        });
    }

    delete(id) {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM phone_verification WHERE id = ?', [id], function (err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });
    }

    /**
     * Drops any still-pending challenge for this phone, so requesting a new code
     * invalidates the previous one instead of leaving two live codes for the
     * same number. A phone-change request is scoped by user as well, because the
     * same number can legitimately appear in a login challenge and a change
     * request at the same time.
     */
    deletePendingFor(phone, userId = null) {
        return new Promise((resolve, reject) => {
            const sql =
                userId === null
                    ? 'DELETE FROM phone_verification WHERE phone = ? AND user_id IS NULL'
                    : 'DELETE FROM phone_verification WHERE phone = ? AND user_id = ?';

            db.run(sql, userId === null ? [phone] : [phone, userId], function (err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });
    }

    /** Records one wrong guess. Returns the new attempt count. */
    recordFailedAttempt(id) {
        return new Promise((resolve, reject) => {
            db.run('UPDATE phone_verification SET attempts = attempts + 1 WHERE id = ?', [id], function (err) {
                if (err) return reject(err);
                db.get('SELECT attempts FROM phone_verification WHERE id = ?', [id], (e, row) => {
                    if (e) return reject(e);
                    resolve(row ? row.attempts : 0);
                });
            });
        });
    }

    /** Removes rows past their TTL, and legacy rows that never got one. */
    deleteExpired(now = Date.now()) {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM phone_verification WHERE expires_at IS NULL OR expires_at < ?', [now], function (err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });
    }

    count() {
        return new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) AS c FROM phone_verification', [], (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.c : 0);
            });
        });
    }

    /**
     * A random 6-digit code that no live row is using.
     *
     * Only checks against unexpired rows — otherwise the pool keeps shrinking as
     * dead rows pile up, and expired codes are about to be swept anyway.
     */
    async getUniqueCode(now = Date.now()) {
        let code;

        do {
            code = Math.floor(100000 + Math.random() * 900000);
        } while (!(await this.checkIsCodeUnique(code, now)));

        return code;
    }

    checkIsCodeUnique(code, now = Date.now()) {
        return new Promise((resolve, reject) => {
            db.get(
                'SELECT id FROM phone_verification WHERE code = ? AND expires_at IS NOT NULL AND expires_at >= ?',
                [code, now],
                (err, row) => {
                    if (err) return reject(err);
                    resolve(row === undefined);
                }
            );
        });
    }
}

module.exports = new PhoneVerify();