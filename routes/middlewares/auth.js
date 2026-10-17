const jwt = require('jsonwebtoken');
const db = require('../../app/db/createDatabase');

const auth = (req, res, next) => {
    const token = req.headers?.authorization || req.cookies?.["shopy-token"];

    if(! token ) {
        return res.status(403).json({ status: 'fail' , message : 'unauthorized'})
    }

    try {
        let decoded = jwt.verify(token, process.env.TOKEN_KEY);
        console.log(decoded);
        db.get(`SELECT * FROM users WHERE id = ? and token = ?` , [ decoded.user_id , token] , function(err, user) {
            
            if (err) {
                res.status(400).json({"error": err.message})
                return;
            }

            if (!user || user.token != token) {
                return res.status(403).json({ status: 'fail' , message : 'unauthenticated'})
            }

            const { id , name , phone, permission, email, steam_id, avatar, trade_url, created_at } = user;
            // Permission comes from the database, not the token, so admin changes apply immediately.
            // `token` is deliberately excluded from req.user so it is never
            // echoed back to a client by a route that spreads this object.
            req.user = { id , name , phone, permission, email, steam_id, avatar, trade_url, created_at }
            next()
        });
    } catch(err) {
        console.log(err);
        return res.status(403).json({ status: 'fail' , message : 'unauthenticated'})
    }
}


module.exports = auth;