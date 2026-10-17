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

    all() {
        return new Promise((resolve , reject) => {

            // Only safe columns: never expose token.
            db.all(`SELECT id, name, phone, permission, created_at FROM users ORDER BY created_at DESC`, function(err , rows) {
                if(err) return reject(err);
    
                resolve(rows);
            });
    
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