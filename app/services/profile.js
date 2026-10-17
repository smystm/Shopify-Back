/**
 * Shape and edit rules for the signed-in customer's profile.
 *
 /**
 * `EDITABLE_FIELDS` is the security boundary for PATCH /user: userRepo.update()
 * builds its SQL SET clause from the keys of the object it receives, so a
 * request body must never be spread into it unchecked. Only names on this list
 * can reach the database, which keeps a caller from setting `permission`,
 * `token`, `id` or `loggedin_at` on their own record.
 *
 * `phone` is never on it, and never was: it changes only through a verified code.
 *
 * The Steam identity - name, steam_id, avatar - is on it ONLY while the shop is
 * still signing people in with a phone number. In that world nobody's name comes
 * from Steam, so the customer's own name is the best name there is and taking the
 * field away would be a regression for no gain. The moment AUTH_PROVIDER=steam,
 * those three drop off automatically: they belong to the Steam account, they are
 * re-synced on every sign-in, and letting the storefront write them would let
 * anybody put a stranger's name on their own header. Tightening it here means the
 * cutover does not have to remember to do it.
 */
function editableFields() {
   return process.env.AUTH_PROVIDER === 'steam'
      ? ['email', 'trade_url']
      : ['name', 'email', 'steam_id', 'trade_url'];
}

/** Fields that may be emptied to remove a previously saved value. */
function clearableFields() {
   return process.env.AUTH_PROVIDER === 'steam' ? ['email', 'trade_url'] : ['email', 'steam_id', 'trade_url'];
}

/**
 * Returns a new object containing only whitelisted fields present in `body`.
 *
 * A field the caller did not send is left out entirely, so saving one section of
 * the profile can never blank another — which is what makes per-section saves
 * safe. A clearable field sent as an empty string becomes NULL rather than "".
 */
function editableFieldsFromBody(body = {}) {
    const patch = {};
    const editable = editableFields();
    const clearable = clearableFields();

    for (const field of editable) {
        if (!Object.prototype.hasOwnProperty.call(body, field)) continue;

        const value = body[field];
        const trimmed = typeof value === 'string' ? value.trim() : value;

        patch[field] = clearable.includes(field) && trimmed === '' ? null : trimmed;
    }
    return patch;
}

/**
 * Public shape of the signed-in user. `token` is deliberately absent — never
 * expose it, exactly like User.all() does.
 */
function buildProfile(user, balance = 0) {
    if (!user) return null;
    return {
        id: user.id,
        name: user.name ?? null,
        phone: user.phone ?? null,
        email: user.email ?? null,
        steam_id: user.steam_id ?? null,
        /** Steam persona picture. Null on a phone-era account that has not linked. */
        avatar: user.avatar ?? null,
        trade_url: user.trade_url ?? null,
        permission: user.permission ?? null,
        created_at: user.created_at ?? null,
        balance,
    };
}

module.exports = { editableFields, editableFieldsFromBody, buildProfile };