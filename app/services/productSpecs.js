/**
 * The CS2 specification fields an administrator may set on a product.
 *
 * The database carries these columns (see app/db/createDatabase.js) and the
 * storefront renders them, but until now nothing could write them through the
 * API - they were only reachable by re-running scripts/enrich-products.js.
 * This module is the one place that turns a request body into safe column
 * values, shared by POST and PUT on routes/products.js.
 *
 * Every field is optional on purpose, and that nullability IS the
 * category-awareness: a knife has an exterior and a float band, a case has
 * neither, and inventing values that do not apply would be worse than leaving
 * them unset. An explicit `null` (or an empty string from a cleared form
 * field) clears the column; an absent key on an update leaves it alone.
 *
 * What is deliberately NOT here: `sold_count` and `sold_order_id`. Those are
 * the shop's own sales ledger, owned by the checkout transaction - a request
 * body never gets to claim a sale or un-claim one.
 */

/** Valve's five exterior names, exactly as the storefront's EXTERIOR_FLOATS keys them. */
const EXTERIORS = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'];

/** Valve's rarity tiers - the same vocabulary scripts/enrich-products.js writes. */
const RARITIES = [
    'Consumer',
    'Industrial',
    'Mil-Spec',
    'Restricted',
    'Classified',
    'Covert',
    'Extraordinary',
    'Contraband',
];

/** What a spec failure looks like: one message per field, listed together. */
class SpecValidationError extends Error {
    constructor(errors) {
        super(errors.join(' '));
        this.name = 'SpecValidationError';
        this.errors = errors;
    }
}

/** True for "no value at all": missing key, null, or a blank-after-trim string. */
function isEmpty(value) {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/** Bool-ish columns are stored as 0/1 integers, matching stattrak/souvenir defaults. */
function toFlag(value) {
    if (value === true || value === 1 || value === '1' || value === 'true') return 1;
    return 0;
}

/**
 * Normalise one spec field from a request body.
 *
 * Returns `{ value, touched }`: `touched` is false when the key was absent, so
 * an update can skip it instead of wiping a column the form never showed.
 * `value` is null for every empty-but-present field, which is how a cleared
 * input clears the column.
 */
function normalize(body, key) {
    if (!(key in body)) return { touched: false };

    const raw = body[key];

    if (isEmpty(raw)) return { touched: true, value: null };
    return { touched: true, value: raw };
}

/**
 * Turn a request body into safe spec column values.
 *
 * Resolves to `{ fields }` - only the keys the body actually spoke about, each
 * already coerced to the column's storage shape - or rejects with a
 * SpecValidationError whose `errors` array names every bad field at once.
 */
function specFieldsFromBody(body) {
    const fields = {};
    const errors = [];

    // ---- Wear (exterior + the float band that goes with it) ----
    const exterior = normalize(body, 'exterior');
    if (exterior.touched) {
        if (exterior.value === null) {
            fields.exterior = null;
        } else if (typeof exterior.value !== 'string' || !EXTERIORS.includes(exterior.value.trim())) {
            errors.push(`exterior must be one of: ${EXTERIORS.join(', ')}`);
        } else {
            fields.exterior = exterior.value.trim();
        }
    }

    for (const key of ['float_min', 'float_max']) {
        const entry = normalize(body, key);
        if (!entry.touched) continue;

        if (entry.value === null) {
            fields[key] = null;
            continue;
        }

        const num = Number(entry.value);
        if (!Number.isFinite(num) || num < 0 || num > 1) {
            errors.push(`${key} must be a number between 0 and 1`);
        } else {
            fields[key] = num;
        }
    }

    // A band only makes sense the right way round.
    if (
        fields.float_min !== undefined && fields.float_min !== null &&
        fields.float_max !== undefined && fields.float_max !== null &&
        fields.float_min > fields.float_max
    ) {
        errors.push('float_min must not be greater than float_max');
    }

    // ---- StatTrak / Souvenir flags ----
    for (const key of ['stattrak', 'souvenir']) {
        if (!(key in body)) continue;
        fields[key] = toFlag(body[key]);
    }

    // ---- Free text with a sane ceiling ----
    const rarity = normalize(body, 'rarity');
    if (rarity.touched) {
        if (rarity.value === null) {
            fields.rarity = null;
        } else if (typeof rarity.value !== 'string' || rarity.value.trim().length > 40) {
            errors.push('rarity must be a string of at most 40 characters');
        } else if (!RARITIES.includes(rarity.value.trim())) {
            errors.push(`rarity must be one of: ${RARITIES.join(', ')}`);
        } else {
            fields.rarity = rarity.value.trim();
        }
    }

    const collection = normalize(body, 'collection');
    if (collection.touched) {
        if (collection.value === null) {
            fields.collection = null;
        } else if (typeof collection.value !== 'string' || collection.value.trim().length > 80) {
            errors.push('collection must be a string of at most 80 characters');
        } else {
            fields.collection = collection.value.trim();
        }
    }

    // ---- Stat pattern (paint seed) ----
    const pattern = normalize(body, 'pattern_index');
    if (pattern.touched) {
        if (pattern.value === null) {
            fields.pattern_index = null;
        } else {
            const num = Number(pattern.value);
            if (!Number.isInteger(num) || num < 0 || num > 1000) {
                errors.push('pattern_index must be a whole number between 0 and 1000');
            } else {
                fields.pattern_index = num;
            }
        }
    }

    // ---- Release date, always a millisecond timestamp in this schema ----
    const release = normalize(body, 'release_at');
    if (release.touched) {
        if (release.value === null) {
            fields.release_at = null;
        } else {
            const num = Number(release.value);
            if (!Number.isFinite(num) || num <= 0) {
                errors.push('release_at must be a millisecond timestamp');
            } else {
                fields.release_at = Math.floor(num);
            }
        }
    }

    // ---- Stock ----
    // Absent on an update means "leave it alone"; absent on a create means the
    // repo's default of 1. A present value must be a whole number of at least
    // one - the checkout reads NULL as one anyway, but an explicit 0 or minus
    // figure is a typo, not a state.
    if ('count' in body) {
        if (isEmpty(body.count)) {
            // A cleared stock field means "one copy", the same reading the
            // checkout gives NULL - never "unlimited".
            fields.count = 1;
        } else {
            const num = Number(body.count);
            if (!Number.isInteger(num) || num < 1 || num > 9999) {
                errors.push('count must be a whole number between 1 and 9999');
            } else {
                fields.count = num;
            }
        }
    }

    if (errors.length > 0) {
        throw new SpecValidationError(errors);
    }

    return fields;
}

module.exports = {
    EXTERIORS,
    RARITIES,
    SpecValidationError,
    specFieldsFromBody,
};
