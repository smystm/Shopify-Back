const express = require('express');
const router = express.Router();
const steam = require('../app/services/steam');
const userRepo = require('../app/db/repos/user');
const { createToken } = require('../app/services/token');

/**
 * Steam sign-in.
 *
 * Three endpoints and one promise: hand the browser to Steam, take the answer
 * back, answer with the same JWT every other sign-in in this app hands back. That
 * is deliberate - `routes/middlewares/auth.js`, the cart, the wallet, the panel
 * and the admin screens all keep working untouched, because there is only ever
 * one kind of session in this codebase and Steam produces one like the phone flow
 * already does.
 *
 * DORMANT BY DEFAULT. Mounted only when AUTH_PROVIDER=steam. See
 * docs/steam-auth-cutover.md.
 */

/** The same refusal for every cause, so this cannot be used to probe a response. */
function refuse(res, err) {
    // The reason is for the operator's terminal, not for whoever is calling.
    console.warn(`[steam] ${err.code}: ${err.message}`);
    return res.status(401).json({ status: 'fail', message: 'Steam sign-in could not be completed' });
}

/** GET /auth/steam/login — send the browser to Steam. */
router.get('/steam/login', (req, res, next) => {
    try {
        if (!steam.isConfigured()) {
            return res.status(503).json({ status: 'fail', message: 'Steam sign-in is not configured' });
        }

        return res.redirect(302, steam.authorizationUrl());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /auth/steam/exchange — finish a Steam sign-in.
 *
 * The body is the OpenID response exactly as Steam sent it, plus the `state` we
 * minted. Everything is verified against Steam before a single row is touched;
 * `verifyCallback` returning is the proof.
 *
 * Creating an account on a first sign-in is the whole of "register" here: there
 * is no separate registration to do, and no duplicate is possible because the
 * lookup is by SteamID.
 */
router.post('/steam/exchange', async (req, res) => {
    let identity;

    try {
        identity = await steam.verifyCallback(req.body ?? {});
    } catch (err) {
        return refuse(res, err);
    }

    try {
        const profile = await steam.fetchProfile(identity.steamId);
        const existing = await userRepo.findBySteamId(identity.steamId);

        let user = existing;

        if (!user) {
            const id = await userRepo.createFromSteam({
                steamId: identity.steamId,
                name: profile.personaName,
                avatar: profile.avatarUrl,
            });

            user = await userRepo.findBy('id', id);
        } else if (profile.personaName || profile.avatarUrl) {
            // Steam lets its owner rename and re-picture at will, so the storefront
            // follows Steam rather than freezing whatever it saw on the first login.
            await userRepo.syncFromSteam(user.id, profile);
            user = await userRepo.findBy('id', user.id);
        }

        // Exactly the token the phone flow issues, with the same storage in the
        // users row, so the auth middleware cannot tell the two apart.
        const token = createToken({ user_id: user.id, name: user.name });
        await userRepo.update(user.id, { token, loggedin_at: Date.now() });

        return res.status(200).json({
            status: 'success',
            token,
            user: {
                id: user.id,
                name: user.name,
                phone: user.phone ?? null,
                email: user.email ?? null,
                steam_id: user.steam_id ?? null,
                avatar: user.avatar ?? null,
                trade_url: user.trade_url ?? null,
                permission: user.permission ?? null,
                created_at: user.created_at ?? null,
            },
        });
    } catch (err) {
        return next(err);
    }
});

module.exports = router;