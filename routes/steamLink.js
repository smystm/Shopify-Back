const express = require('express');
const router = express.Router();
const authMiddleware = require('./middlewares/auth');
const steam = require('../app/services/steam');
const userRepo = require('../app/db/repos/user');

/**
 * Binding a Steam account to an account that already exists.
 *
 * This is the answer to "what about the customers who joined on a phone number?".
 * Without it, switching to Steam would strand them: their orders, their wallet
 * balance and their history all hang off a users row that Steam can never find,
 * because Steam only hands back a SteamID and theirs has never been linked.
 *
 * With it, they prove who they are exactly as before - by verifying a phone
 * number they already own, which is the one credential this shop has always
 * known how to check - and the Steam account is written onto *their existing row*.
 * No duplicate, and no transfer: nothing about the account changes but who can
 * sign in to it.
 */
const linkRouter = express.Router();

/** GET /auth/steam/link — start the round trip from a signed-in panel. */
linkRouter.get('/link', authMiddleware, (req, res, next) => {
    try {
        // A verified phone is what makes this safe: it is the credential that
        // already proved this customer owns this account.
        if (!req.user.phone) {
            return res.status(409).json({
                status: 'fail',
                message: 'Verify a phone number on your profile before linking a Steam account',
            });
        }

        if (!steam.isConfigured()) {
            return res.status(503).json({ status: 'fail', message: 'Steam sign-in is not configured' });
        }

        return res.redirect(302, steam.authorizationUrl());
    } catch (err) {
        next(err);
    }
});

/**
 * POST /auth/steam/link/confirm — attach the verified SteamID to this account.
 *
 * Called by the storefront's callback while the customer is still signed in on
 * this device. Two refusals matter here and both are deliberate:
 *
 *   - the SteamID must not already belong to somebody else, or linking would
 *     quietly merge two customers' wallets;
 *   - this account must not already be linked, or a second link could overwrite
 *     the first.
 */
linkRouter.post('/link/confirm', authMiddleware, async (req, res) => {
    let identity;

    try {
        identity = await steam.verifyCallback(req.body ?? {});
    } catch (err) {
        console.warn(`[steam/link] ${err.code}: ${err.message}`);
        return res.status(401).json({ status: 'fail', message: 'Steam could not be verified' });
    }

    try {
        if (!req.user.phone) {
            return res.status(409).json({ status: 'fail', message: 'Verify a phone number first' });
        }

        const owner = await userRepo.findBySteamId(identity.steamId);
        if (owner && Number(owner.id) !== Number(req.user.id)) {
            return res.status(409).json({ status: 'fail', message: 'That Steam account is already linked elsewhere' });
        }

        if (req.user.steam_id) {
            return res.status(409).json({ status: 'fail', message: 'This account is already linked to Steam' });
        }

        const profile = await steam.fetchProfile(identity.steamId);

        await userRepo.update(req.user.id, {
            steam_id: identity.steamId,
            name: profile.personaName ?? req.user.name,
            avatar: profile.avatarUrl ?? null,
        });

        const user = await userRepo.findBy('id', req.user.id);

        return res.status(200).json({
            status: 'success',
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

module.exports = linkRouter;