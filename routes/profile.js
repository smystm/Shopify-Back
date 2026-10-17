var express = require('express');
var router = express.Router();
const yup = require('yup');
const authMiddleware = require('./middlewares/auth');
const validate = require('./middlewares/validate');
const userRepo = require('../app/db/repos/user');
const walletRepo = require('../app/db/repos/wallet');
const phoneVerification = require('../app/services/phoneVerification');
const { editableFieldsFromBody, buildProfile } = require('../app/services/profile');
const { normalizePhone, isValidPhone } = require('../app/services/phone');

// Steam only issues trade URLs on this exact path, so anything else is a typo
// or a phishing link — reject it rather than storing it.
const tradeUrlPattern = /^https:\/\/steamcommunity\.com\/tradeoffer\/[A-Za-z0-9]+\/?$/i;

// Each section of the profile is saved on its own, so an optional field must be
// clearable. In yup 0.32 `.email()` already ignores the empty string, and
// `.matches()` needs excludeEmptyString to do the same — without it a user could
// never remove a wrong trade URL or an old address.
// Empty string -> NULL happens in editableFieldsFromBody, not here: the validate
// middleware discards yup's cast value, so a transform would never reach req.body.
const editProfileSchema = yup.object({
    body: yup.object({
        name: yup.string().trim().min(2).max(60),
        email: yup.string().trim().email().max(120),
        steam_id: yup.string().trim().max(40),
        trade_url: yup.string()
            .trim()
            .max(300)
            .matches(tradeUrlPattern, {
                message: 'trade_url must be a Steam trade offer URL',
                excludeEmptyString: true,
            }),
    }),
});

const phoneChangeRequestSchema = yup.object({
    body: yup.object({
        phone: yup
            .string()
            .trim()
            .test('phone-valid', 'phone is not valid', (value) => isValidPhone(value)),
    }),
});

const phoneChangeConfirmSchema = yup.object({
    body: yup.object({
        verificationId: yup.string().trim().required(),
        code: yup.string().trim().required().matches(/^\d{6}$/, 'code must be 6 digits'),
    }),
});

/**
 * Rejects a phone number that is already registered to a different account.
 * Without this, anyone signed in could claim a victim's number and then take
 * over that account on the next login.
 *
 * Normalizes first: comparing raw strings would let "+989121110002" and
 * "09121111002" each be claimed by a different account, because they are the
 * same number written two ways.
 */
async function assertPhoneAvailable(phone, currentUserId) {
    const owner = await userRepo.findBy('phone', normalizePhone(phone));
    if (owner && Number(owner.id) !== Number(currentUserId)) {
        return 'This phone number is already registered to another account';
    }
    return null;
}

// PATCH /user — the signed-in customer edits their own profile.
router.patch('/', authMiddleware, validate(editProfileSchema), async (req, res, next) => {
    try {
        // Whitelisted, never the raw body. See services/profile.js.
        const patch = editableFieldsFromBody(req.body);

        if (Object.keys(patch).length === 0) {
            return res.status(400).json({ status: 'fail', message: 'No editable fields supplied' });
        }

        // Always the authenticated user's own id, never one from the body.
        await userRepo.update(req.user.id, patch);

        const user = await userRepo.findBy('id', req.user.id);
        const balance = await walletRepo.balanceForUser(req.user.id);

        res.json({ status: 'success', user: buildProfile(user, balance) });
    } catch (err) {
        next(err);
    }
});

// POST /user/phone-change/request — start a verified phone change.
router.post('/phone-change/request', authMiddleware, validate(phoneChangeRequestSchema), async (req, res, next) => {
    try {
        const { phone } = req.body;
        // Canonical form before any comparison, so a differently-spelled version
        // of my own number is recognised as mine and a victim's number is
        // recognised as taken.
        const normalizedPhone = normalizePhone(phone);

        if (normalizedPhone === normalizePhone(req.user.phone)) {
            return res.status(400).json({ status: 'fail', message: 'This is already your phone number' });
        }

        const taken = await assertPhoneAvailable(normalizedPhone, req.user.id);
        if (taken) {
            return res.status(409).json({ status: 'fail', message: taken });
        }

        const challenge = await phoneVerification.issueCode({
            // Stored canonically: the confirmation re-checks availability against
            // this value, so it has to match what other accounts would store.
            phone: normalizedPhone,
            // Scoping the code to the requester is what stops one user from
            // confirming another user's pending change.
            userId: req.user.id,
            purpose: 'phone_change',
        });

        // The code is NOT returned — it is written to the backend terminal by the
        // delivery seam in the service.
        res.status(201).json({
            status: 'success',
            verificationId: challenge.id,
            expiresIn: challenge.expiresAt - Date.now(),
        });
    } catch (err) {
        next(err);
    }
});

// POST /user/phone-change/confirm — complete the change with the code that was
// sent to the NEW number.
router.post('/phone-change/confirm', authMiddleware, validate(phoneChangeConfirmSchema), async (req, res, next) => {
    try {
        const { verificationId, code } = req.body;

        // The shared service handles the id lookup, the requester binding, the
        // TTL and the attempt limit, and reports every failure identically so
        // this cannot be used to probe which ids exist or which codes are close.
        const result = await phoneVerification.consumeCode({
            id: verificationId,
            code,
            userId: req.user.id,
        });

        if (!result.ok) {
            return res.status(400).json({ status: 'fail', message: 'The verification code is wrong or has expired' });
        }

        // The service only returns a row issued to THIS user, but assert it again
        // rather than let a future change silently turn this into an unverified
        // phone write.
        if (result.row.user_id === null || result.row.user_id === undefined || Number(result.row.user_id) !== Number(req.user.id)) {
            return res.status(400).json({ status: 'fail', message: 'The verification code is wrong or has expired' });
        }

        // Re-check availability: the number may have been claimed between the
        // request and the confirm.
        const taken = await assertPhoneAvailable(result.row.phone, req.user.id);
        if (taken) {
            return res.status(409).json({ status: 'fail', message: taken });
        }

        // Hardcoded field name — `phone` is deliberately absent from
        // EDITABLE_FIELDS so it can only ever change through this verified path.
        await userRepo.update(req.user.id, { phone: normalizePhone(result.row.phone) });

        const user = await userRepo.findBy('id', req.user.id);
        const balance = await walletRepo.balanceForUser(req.user.id);

        res.json({ status: 'success', user: buildProfile(user, balance) });
    } catch (err) {
        next(err);
    }
});

module.exports = router;