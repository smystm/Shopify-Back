/**
 * Steam authentication: OpenID 2.0 for identity, the Web API for a face and a name.
 *
 * Two very different things happen here and it is worth keeping them apart:
 *
 *   1. **OpenID 2.0** proves who the visitor is. Steam never shares a password;
 *      it hands back a 64-bit SteamID with an RSA signature over the response.
 *      That signature is what makes this an authentication and not a suggestion.
 *
 *   2. **GetPlayerSummaries** decorates that identity with the persona name and
 *      the avatar. It needs a Web API key, and it is the *only* optional part -
 *      without a key the login still works, the customer just has no face or name
 *      beyond their SteamID.
 *
 * Everything is verified server-side. Nothing here trusts a value the browser
 * sent except as an unverified claim that is then checked against Steam itself.
 *
 * DORMANT BY DEFAULT. This module is wired up but not switched on; see
 * docs/steam-auth-cutover.md for what turning it on involves.
 */
const crypto = require('crypto');

const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const OP_ENDPOINT = 'https://steamcommunity.com/openid/';
const OPENID_NS = 'http://specs.openid.net/auth/2.0';

/** A SteamID64 is a fixed-width unsigned 64-bit integer, written in decimal. */
const STEAM_ID_64 = /^([0-9]{17})$/;
const CLAIMED_ID = /^https:\/\/steamcommunity\.com\/openid\/id\/([0-9]{17})$/;

/** How long a started login may take to come back. */
const RETURN_TTL_MS = 10 * 60 * 1000;

/** One Steam failure for every cause, so a caller cannot probe which check hit. */
class SteamAuthError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SteamAuthError';
        this.code = code;
    }
}

const failure = (code, message) => new SteamAuthError(code, message);

/* ------------------------------------------------------------------ configuration */

/**
 * Valve's OpenID signing key.
 *
 * It is configuration rather than a constant on purpose. This key is published
 * by Valve and has never changed, but a key copied from a blog post is a key
 * nobody has verified, and a wrong one fails as an inscrutable signature error
 * at the worst possible moment. Read it from the environment so it can be taken
 * from Valve's own documentation, and validate it once at boot.
 *
 * In a .env file the newlines are written as literal `\n`.
 */
function publicKey() {
    const raw = String(process.env.STEAM_OPENID_PUBLIC_KEY ?? '').trim();

    if (!raw) {
        throw failure(
            'NOT_CONFIGURED',
            'STEAM_OPENID_PUBLIC_KEY is not set - Steam sign-in cannot be verified'
        );
    }

    const pem = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : `-----BEGIN PUBLIC KEY-----\n${raw.replace(/\\n/g, '\n')}\n-----END PUBLIC KEY-----`;

    // Throws on anything that is not a real key, which is far easier to diagnose
    // than a signature that never matches.
    try {
        crypto.createPublicKey(pem);
    } catch {
        throw failure('NOT_CONFIGURED', 'STEAM_OPENID_PUBLIC_KEY is not a valid public key');
    }

    return pem;
}

/** Required for the persona name and avatar. Empty is allowed: see the note above. */
function apiKey() {
    return String(process.env.STEAM_API_KEY ?? '').trim();
}

/**
 * Where Steam sends the browser back to. Must be the exact URL registered on the
 * Steamworks partner site - Steam rejects anything else, and a mismatch here is
 * also what stops an attacker aiming somebody else's assertion at us.
 */
function returnTo() {
    const value = String(process.env.STEAM_RETURN_URL ?? '').trim();

    if (!value) {
        throw failure('NOT_CONFIGURED', 'STEAM_RETURN_URL is not set - there is nowhere to return to');
    }

    return value;
}

/** The customer-facing site, shown by Steam on its "authorise" screen. */
function realm() {
    return String(process.env.STEAM_REALM ?? '').trim() || returnTo();
}

function isConfigured() {
    try {
        publicKey();
        returnTo();
        return true;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------------ nonce */

/**
 * OpenID 2.0 has no nonce of its own, so the `state` parameter carries ours.
 *
 * It is HMAC'd rather than stored, so a started login survives a backend restart
 * instead of silently expiring, and it is single-use on top of that - without the
 * single-use check a captured, valid response could be replayed to sign somebody
 * in a second time. The in-memory set is per-process: behind more than one
 * instance the replay window is bounded by the TTL rather than closed outright.
 */
const spentStates = new Map();

function pruneSpentStates() {
    const now = Date.now();
    for (const [value, expiry] of spentStates) {
        if (expiry <= now) spentStates.delete(value);
    }
}

function signState(nonce, issuedAt) {
    return crypto.createHmac('sha256', process.env.TOKEN_KEY ?? 'steam').update(`${nonce}.${issuedAt}`).digest('base64url');
}

function newState() {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const issuedAt = Date.now();
    return `${issuedAt}.${nonce}.${signState(nonce, issuedAt)}`;
}

function checkState(state) {
    if (typeof state !== 'string') return false;

    const parts = state.split('.');
    if (parts.length !== 3) return false;

    const [issuedAt, nonce, signature] = parts;
    const issued = Number(issuedAt);

    if (!Number.isFinite(issued) || Date.now() - issued > RETURN_TTL_MS || Date.now() - issued < -RETURN_TTL_MS) return false;

    const expected = signState(nonce, issuedAt);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    pruneSpentStates();

    if (spentStates.has(signature)) return false;
    spentStates.set(signature, issued + RETURN_TTL_MS);

    return true;
}

/* ---------------------------------------------------------------------- step one */

/**
 * Where to send the browser.
 *
 * `state` rides inside `return_to`, which Steam returns verbatim - so the callback
 * URL always carries it.
 */
function authorizationUrl() {
    const target = new URL(returnTo());
    target.searchParams.set('state', newState());

    const params = new URLSearchParams({
        'openid.ns': OPENID_NS,
        'openid.mode': 'checkid_setup',
        'openid.claimed_id': 'https://steamcommunity.com/openid/id/',
        'openid.identity': 'https://steamcommunity.com/openid/id/',
        'openid.return_to': target.toString(),
        'openid.realm': realm(),
    });

    return `${OPENID_ENDPOINT}?${params.toString()}`;
}

/* ---------------------------------------------------------------------- step two */

/**
 * Confirms with Steam that the assertion we hold is a live one and not a
 * copy somebody kept. Cheap, and it is what makes a replay obvious.
 */
async function checkAuthentication(query) {
    const body = new URLSearchParams({ ...query, 'openid.mode': 'check_authentication' });

    const response = await fetch(OPENID_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
    });

    const text = await response.text();
    return /^is_valid\s*:\s*true/i.test(text);
}

/**
 * Rebuilds the exact string Valve signed.
 *
 * OpenID 2.0 section 10.1: split `openid.signed` on commas, sort those names
 * ASCII-lexicographically, and join `name=value` with newlines.
 *
 * The names in `openid.signed` are bare - `identity`, not `openid.identity` -
 * which is the whole trap here. Looking them up as they were sent produces a
 * string of empty values, and every genuine login then fails verification in a
 * way that looks like a wrong key.
 */
function signedString(params) {
    const signed = String(params['openid.signed'] ?? '');

    if (!signed) throw failure('BAD_RESPONSE', 'Steam did not sign the response');

    return `${signed.split(',').sort().map((name) => `${name}=${params[`openid.${name}`] ?? ''}`).join('\n')}\n`;
}

function verifySignature(params) {
    const signature = String(params['openid.sig'] ?? '').trim();
    if (!signature) throw failure('BAD_RESPONSE', 'Steam sent no signature');

    const ok = crypto.verify(
        'RSA-SHA1',
        Buffer.from(signedString(params), 'utf8'),
        publicKey(),
        Buffer.from(signature, 'base64')
    );

    if (!ok) throw failure('BAD_SIGNATURE', 'Steam signature did not verify');
}

/**
 * Verifies a callback and answers with the SteamID it proves.
 *
 * Every rejection is the same 401 to the caller; the reasons are for the log.
 */
async function verifyCallback(params = {}) {
    if (!isConfigured()) throw failure('NOT_CONFIGURED', 'Steam sign-in is not configured');
    if (!checkState(params.state)) throw failure('BAD_STATE', 'The login attempt is missing, stale or already used');

    if (params['openid.ns'] !== OPENID_NS) throw failure('BAD_RESPONSE', 'Unexpected OpenID namespace');
    if (params['openid.mode'] !== 'id_res') throw failure('BAD_RESPONSE', 'Steam did not confirm an identity');
    if (params['openid.op_endpoint'] !== OP_ENDPOINT) throw failure('BAD_RESPONSE', 'Response came from the wrong provider');
    if (params['openid.claimed_id'] !== params['openid.identity']) throw failure('BAD_RESPONSE', 'Claimed ID does not match the identity');

    // Steam echoes return_to exactly, so this both proves the response is aimed at
    // us and stops a response captured from another site being replayed here.
    if (params['openid.return_to'] !== returnTo()) throw failure('BAD_RETURN_TO', 'Response was aimed at a different URL');

    const match = CLAIMED_ID.exec(String(params['openid.identity'] ?? ''));
    if (!match || !STEAM_ID_64.test(match[1])) throw failure('BAD_IDENTITY', 'SteamID was not in the expected form');

    verifySignature(params);

    const live = await checkAuthentication(params);
    if (!live) throw failure('NOT_LIVE', 'Steam would not confirm this login is live');

    return { steamId: match[1] };
}

/* ------------------------------------------------------------------- the Web API */

/**
 * Persona name and avatar. Purely a garnish on top of a verified identity.
 *
 * A missing key, a rate limit or a Steam outage must never fail a login that has
 * already been proven - the customer still gets an account, just a plainer one -
 * so every failure here degrades to nulls.
 */
async function fetchProfile(steamId) {
    const key = apiKey();
    if (!key) return { personaName: null, avatarUrl: null };

    try {
        const url = new URL('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/');
        url.searchParams.set('key', key);
        url.searchParams.set('steamids', steamId);

        const response = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
        if (!response.ok) return { personaName: null, avatarUrl: null };

        const body = await response.json();
        const player = body?.response?.players?.[0];
        if (!player || String(player.steamid) !== steamId) return { personaName: null, avatarUrl: null };

        // `avatars` is `{ avatar, avatarmedium, avatarfull }`. Steam hands every
        // account a default image, so this is never empty for a real profile.
        const avatarUrl = player.avatarfull || player.avatarmedium || player.avatar || null;

        return {
            personaName: typeof player.personaname === 'string' ? player.personaname.trim() : null,
            avatarUrl,
        };
    } catch {
        return { personaName: null, avatarUrl: null };
    }
}

module.exports = {
    authorizationUrl,
    verifyCallback,
    fetchProfile,
    isConfigured,
    apiKey,
    SteamAuthError,
    OPENID_ENDPOINT,
};