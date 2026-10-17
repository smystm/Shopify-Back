/**
 * Iranian mobile numbers are typed in many equivalent shapes, and a Persian
 * keyboard emits Persian digits. Storing whatever the user happened to type
 * means "+989121110002" and "09121111002" are treated as two different
 * numbers — which lets the same phone number end up on two accounts, and both
 * of them then log in successfully.
 *
 * So every phone that enters the system is normalized to one canonical form
 * before it is validated, stored, or looked up.
 */

/**
 * Canonical form: 09 followed by 9 digits.
 * Operator prefixes are exactly the ones the original regex accepted, so
 * normalization widens the accepted *formatting* without widening the set of
 * valid numbers.
 */
const CANONICAL_PHONE_REGEXP = /^09(0[1-5]|[13]\d|2[0-2]|98)\d{7}$/;

// Persian (U+06F0..U+06F9) and Arabic-Indic (U+0660..U+0669) digits.
const PERSIAN_ZERO = 0x06f0;
const ARABIC_ZERO = 0x0660;

/**
 * Converts Persian/Arabic digits to ASCII, drops separators (spaces, dashes,
 * dots, parentheses) and rewrites any country-code spelling of the number to
 * the local 09… form.
 *
 *   "۰۹۱۲۱۲۳۴۵۶۷" -> "09121234567"
 *   "0912 123 4567" -> "09121234567"
 *   "+98 912 123 4567" -> "09121234567"
 *   "00989121234567" -> "09121234567"
 *   "9121234567" -> "09121234567"   (the leading zero is implied)
 *
 * Returns an empty string when there is nothing digit-like left, so callers can
 * reject it with the normal validation message.
 */
function normalizePhone(input) {
    if (typeof input !== "string") return "";

    let digits = "";

    for (const char of input.trim()) {
        const code = char.codePointAt(0);

        if (code >= 0x30 && code <= 0x39) digits += char;            // 0-9
        else if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) digits += String(code - PERSIAN_ZERO);
        else if (code >= ARABIC_ZERO && code <= ARABIC_ZERO + 9) digits += String(code - ARABIC_ZERO);
        // Everything else (spaces, +, -, ., parentheses) is formatting.
    }

    if (!digits) return "";

    // Strip the country code in whichever spelling was used, then put the
    // implied leading zero back.
    if (digits.startsWith("0098")) digits = digits.slice(4);
    else if (digits.startsWith("98")) digits = digits.slice(2);

    if (digits.startsWith("9") && digits.length === 10) digits = "0" + digits;

    return digits;
}

/**
 * True when `input` is a valid number once normalized.
 *
 * This checks the canonical form, not merely that something digit-like is left
 * over — otherwise "9891211110032" (one digit too many) normalizes to
 * "91211110032" and would be accepted and stored as a malformed number.
 */
function isValidPhone(input) {
    return CANONICAL_PHONE_REGEXP.test(normalizePhone(input));
}

module.exports = {
    normalizePhone,
    isValidPhone,
    CANONICAL_PHONE_REGEXP,
};