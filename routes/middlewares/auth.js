const jwt = require('jsonwebtoken');
const db = require('../../app/db/createDatabase');

/**
 * Why a token was refused, in one word, for the log line.
 *
 * `jwt.verify` throws a different error per failure and the distinction matters
 * to whoever is reading the log at 3am: `TokenExpiredError` is routine - a
 * session that simply ran out, which happens to every customer on a ten-day
 * cookie - while a signature error means the signing key changed or something is
 * wrong. They used to be indistinguishable, because a raw error object was logged
 * for both, so an ordinary expiry filled the log with a stack trace.
 */
function reason(err) {
    return err?.name === 'TokenExpiredError' ? 'token expired'
        : err?.name === 'JsonWebTokenError' ? 'token malformed'
        : err?.name === 'TokenNotBeforeError' ? 'token not yet valid'
        : 'token rejected';
}

const auth = (req, res, next) => {
    const token = req.headers?.authorization || req.cookies?.["shopy-token"];

    if(! token ) {
        return res.status(401).json({ status: 'fail' , message : 'unauthorized'})
    }

    try {
        let decoded = jwt.verify(token, process.env.TOKEN_KEY);
        db.get(`SELECT * FROM users WHERE id = ? and token = ?` , [ decoded.user_id , token] , function(err, user) {
            
            if (err) {
                res.status(400).json({"error": err.message})
                return;
            }

            if (!user || user.token != token) {
                // 401, not 403. The session is gone or was never valid, and the only
                // thing the caller can do about that is sign in again. 403 means "we
                // know who you are and you may not do this", which is a different
                // problem with a different answer, and conflating the two left the
                // storefront unable to tell a customer to log in.
                return res.status(401).json({ status: 'fail' , message : 'unauthenticated'})
            }

            const { id , name , phone, permission, email, steam_id, avatar, trade_url, created_at } = user;
            // Permission comes from the database, not the token, so admin changes apply immediately.
            // `token` is deliberately excluded from req.user so it is never
            // echoed back to a client by a route that spreads this object.
            req.user = { id , name , phone, permission, email, steam_id, avatar, trade_url, created_at }
            next()
        });
    } catch(err) {
        // Expiry is an ordinary event, not a fault: a customer whose ten-day
        // cookie ran out is simply signed out. One short line, no stack trace, and
        // nothing at all for the routine case.
        if (err?.name !== 'TokenExpiredError') {
            console.warn(`[auth] ${reason(err)}`);
        }
        return res.status(401).json({ status: 'fail' , message : 'unauthenticated'})
    }
}


module.exports = auth;