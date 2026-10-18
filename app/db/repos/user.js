const db = require("../createDatabase");

class User {

    create(data) {
        return new Promise((reslove , reject) => {
            let sql ='INSERT INTO users (name, phone, permission, created_at) VALUES (?,?,?,?)'
    
            db.run(sql, [ data.name, data.phone, data.permission ?? 'NoAccess', Date.now() ], function (err, innerResult) {
                if (err) return reject(err);
        
                reslove();
            });   

        })
    }

    findBy(field , email) {
        return new Promise((resolve , reject) => {

            db.get(`SELECT * FROM users WHERE ${field} = ?`, email , function(err , user) {
                if(err) return reject(err);
    
                resolve(user);
            });
    
        });
    }

    /**
     * The one lookup a Steam sign-in needs: the identity is the 64-bit SteamID,
     * never the persona name - a name can be changed by its owner at any time and
     * two accounts can collide on it.
     */
    findBySteamId(steamId) {
        return new Promise((resolve, reject) => {
            if (!steamId) return resolve(undefined);

            db.get(`SELECT * FROM users WHERE steam_id = ?`, [steamId], function (err, user) {
                if (err) return reject(err);
                resolve(user);
            });
        });
    }

    /**
     * First Steam sign-in: create the account.
     *
     * `permission` is never taken from here - it defaults to NoAccess, so a new
     * customer cannot arrive as an admin.
     */
    createFromSteam({ steamId, name, avatar }) {
        return new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO users (name, steam_id, avatar, permission, created_at) VALUES (?,?,?,'NoAccess',?)`,
                [name ?? null, steamId, avatar ?? null, Date.now()],
                function (err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });
    }

    /**
     * Every Steam sign-in after that.
     *
     * The persona name and avatar are refreshed each time because Steam lets their
     * owner change them; the phone, the wallet, the orders and the cart are left
     * alone, so re-syncing a display name can never disturb an account.
     */
    syncFromSteam(id, { name, avatar }) {
        return this.update(id, { name: name ?? null, avatar: avatar ?? null });
    }

    /**
     * The admin user-management projection: every column an administrator can act
     * on, and nothing more sensitive than that.
     *
     * `token` is still the line that is never crossed - it is a live session
     * credential, not a profile field. Everything else the sign-up flows write
     * (email, Steam identity, trade URL, avatar, last login) belongs on this page,
     * because granting or refusing permissions is exactly the decision those
     * fields inform.
     *
     * `balance` rides along as a correlated sum using the same ledger arithmetic
     * the wallet page shows. With the handful of rows a shop carries that is
     * cheaper than a second round-trip per user, and it cannot drift: it is
     * derived, never stored.
     */
    all() {
        return new Promise((resolve , reject) => {

            // Only safe columns: never expose token.
            db.all(
                `SELECT u.id, u.name, u.phone, u.email, u.steam_id, u.trade_url, u.avatar,
                        u.permission, u.created_at, u.loggedin_at,
                        COALESCE((
                            SELECT SUM(CASE
                                WHEN w.type = 'topup'    THEN  w.amount
                                WHEN w.type = 'purchase' THEN -w.amount
                                WHEN w.type = 'refund'   THEN  w.amount
                                ELSE 0 END)
                            FROM wallet_transactions w WHERE w.user_id = u.id
                        ), 0) AS balance
                 FROM users u
                 ORDER BY u.created_at DESC`,
                function(err , rows) {
                    if(err) return reject(err);
        
                    resolve(rows);
                }
            );
    
        });
    }

    update(id , data) {
        let fieldMustUpdate = Object.keys(data).map(item => `${item}=$${item}` ).join(',');
        let fieldData = {};
        Object.keys(data).forEach(item => fieldData[`$${item}`] = data[item] )

        return new Promise((resolve , reject) => {

            db.run(`UPDATE users SET ${fieldMustUpdate} WHERE id = $id` , { $id : id  , ...fieldData} , function(err) {
                if(err) return reject(err)

                resolve()
            })
        });
    }
}

module.exports = new User();