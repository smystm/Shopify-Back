/**
 * The cart's rules.
 *
 * The repo stores rows; this module is what turns them into something the
 * storefront can render, and what decides whether an "add to cart" is allowed at
 * all. Three rules live here and nowhere else:
 *
 *   1. A skin is one physical item, so its cart quantity is always 1. There is no
 *      such thing as two of a listing, and `products` has no stock column to
 *      disagree with that.
 *   2. A service line (CS2 Prime by region, TF2 keys) is bounded by whatever
 *      `service_prices` says - see `serviceLimit`.
 *   3. Nothing can be added that could not actually be delivered: a sold skin, a
 *      listing an admin deleted, or a service row with no stock left.
 *
 * A cart line holds no price. Every read joins the live listing, so what the cart
 * shows is always what checkout would charge. There is deliberately no
 * "price changed since you added this" state to reconcile, because there is no
 * stored price to go stale.
 */
const cartRepo = require('../db/repos/cart');
const productRepo = require('../db/repos/product');
const servicePriceRepo = require('../db/repos/servicePrice');

const CART_KIND = {
    PRODUCT: 'product',
    SERVICE: 'service',
};

/**
 * Why a line cannot be bought. `null` means it can.
 *
 * These are machine values; the Persian copy lives in `app/lib/i18n/fa.ts`, the
 * same split `service`/`variant` and product categories already use.
 */
const UNAVAILABLE = {
    /** The listing or price row is gone - deleted or renamed by an admin. */
    MISSING: 'missing',
    /** The skin already belongs to somebody else's order. */
    SOLD: 'sold',
    /** The service row exists but has no stock left. */
    OUT_OF_STOCK: 'out_of_stock',
};

/**
 * The highest quantity one line may hold.
 *
 * Every positive constraint in `service_prices` applies and the smallest wins:
 * `stock` is how many the bot can deliver, `max_quantity` is the per-order cap
 * the shop sets for itself (for keys it is 50, because Steam will not hold more
 * than that in one account). Taking the minimum means neither figure alone can be
 * used to oversell.
 *
 * When neither is known the answer is 1 rather than "unlimited". Prime is the row
 * that relies on this: it is a one-time upgrade to one account, so more than one
 * per customer is meaningless, and an unknown cap must never be read as an
 * invitation to buy a thousand. The keys page's stepper uses a looser fallback
 * because it is only a number picker; the cart is the thing that has to be right.
 */
function serviceLimit(row) {
    const constraints = [row.stock, row.max_quantity].filter((n) => Number.isFinite(n) && n > 0);

    return constraints.length ? Math.min(...constraints) : 1;
}

/**
 * How many of a product listing are still buyable.
 *
 * The same subtraction a service line does, and deliberately so: `count` is what
 * exists, `sold_count` is what has gone, and the difference is what is left. That
 * is what lets one cart serve both kinds of line with one rule for "you may not
 * ask for more than we have".
 *
 * A NULL `count` reads as 1, never as unlimited. A listing whose stock nobody
 * has ever filled in must not become an unlimited offer the moment a customer
 * finds it.
 */
function productRemaining(row) {
    const total = Number.isFinite(row.count) && row.count > 0 ? Number(row.count) : 1;
    const sold = Number.isFinite(row.sold_count) && row.sold_count > 0 ? Number(row.sold_count) : 0;

    return Math.max(0, total - sold);
}

/** A rejection the route can turn into a status code. */
class CartError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = 'CartError';
        this.code = code;
        this.status = status;
    }
}

function toPrice(value) {
    if (value === null || value === undefined) return null;

    const n = Number(value);

    return Number.isFinite(n) ? n : null;
}

/**
 * One product line, priced against its live listing.
 *
 * `lineTotal` is 0 when the line is unavailable, so an unbuyable row can never
 * leak into the subtotal. The customer sees the shortfall through
 * `totals.unavailableCount` instead of through a silently smaller total.
 */
function shapeProductLine(row) {
    const price = toPrice(row.price);
    const remaining = productRemaining(row);
    const outOfStock = !row.title ? false : remaining <= 0;

    const unavailable = !row.title || price === null
        ? UNAVAILABLE.MISSING
        : outOfStock
            ? UNAVAILABLE.OUT_OF_STOCK
            : null;

    // Clamped on the way out as well as on the way in: stock falls while an item
    // sits in someone's cart, and a rendered total that checkout would refuse is
    // worse than a total that quietly corrects itself.
    const limit = Math.max(1, remaining);
    const quantity = Math.max(1, Math.min(row.quantity || 1, limit));

    return {
        id: row.id,
        kind: CART_KIND.PRODUCT,
        product_id: row.product_id,
        service: null,
        variant: null,
        quantity,
        title: row.title ?? null,
        image: row.image ?? null,
        category: row.category ?? null,
        price,
        lineTotal: unavailable ? 0 : price * quantity,
        /** The most this line may hold right now: what is left in stock. */
        limit,
        /** What exists, and what is left of it. The stepper needs both. */
        stock: Number.isFinite(row.count) && row.count > 0 ? Number(row.count) : null,
        available: remaining,
        unavailable,
    };
}

/** One service line, priced against its live `service_prices` row. */
function shapeServiceLine(row) {
    const price = toPrice(row.price);
    const missing = price === null;
    const limit = missing ? 1 : serviceLimit(row);
    const outOfStock = !missing && Number.isFinite(row.stock) && row.stock <= 0;

    const unavailable = missing
        ? UNAVAILABLE.MISSING
        : outOfStock
            ? UNAVAILABLE.OUT_OF_STOCK
            : null;

    // A cap can fall after something is already in the cart, so clamp on the way
    // out too - otherwise the rendered total would show a quantity checkout would
    // refuse.
    const quantity = Math.max(1, Math.min(row.quantity, limit));

    return {
        id: row.id,
        kind: CART_KIND.SERVICE,
        product_id: null,
        service: row.service,
        variant: row.variant,
        quantity,
        // Always null: the backend holds machine values only, and the client
        // resolves the Persian label from its own copy.
        title: null,
        image: row.image ?? null,
        category: null,
        price,
        lineTotal: unavailable ? 0 : price * quantity,
        limit,
        /** Services carry no `count`/`sold_count`; availability is the limit. */
        stock: null,
        available: Math.max(0, limit),
        unavailable,
    };
}

/**
 * The whole cart: every line priced live, plus the totals the UI needs.
 *
 * `unitCount` is what the header badge shows - it counts keys, not lines, so
 * three keys read as "3". `subtotal` covers available lines only.
 */
async function summarize(userId) {
    const [productRows, serviceRows] = await Promise.all([
        cartRepo.productLinesForUser(userId),
        cartRepo.serviceLinesForUser(userId),
    ]);

    const lines = [
        ...productRows.map(shapeProductLine),
        ...serviceRows.map(shapeServiceLine),
    ];

    const available = lines.filter((line) => !line.unavailable);

    return {
        lines,
        totals: {
            lineCount: lines.length,
            unitCount: lines.reduce((sum, line) => sum + line.quantity, 0),
            subtotal: available.reduce((sum, line) => sum + line.lineTotal, 0),
            unavailableCount: lines.length - available.length,
        },
    };
}

/** Just the badge figure, without pricing anything. */
async function count(userId) {
    return cartRepo.countForUser(userId);
}

/**
 * Add a skin, in however many copies the customer asked for.
 *
 * Checked before it is written rather than after, so a deleted or fully-sold
 * listing never reaches the cart in the first place - the alternative is a line
 * that appears and then immediately reads as unavailable.
 *
 * Adding twice accumulates, exactly like a service line, and the result is
 * clamped to what is actually left. A customer asking for more than remains
 * gets what remains rather than an error: they are not doing anything wrong, the
 * shop simply has less than they hoped, and the rest of their cart should not be
 * lost to an arithmetic refusal.
 */
async function addProduct(userId, productId, quantity = 1) {
    const product = await productRepo.findBy('id', productId);

    if (!product) {
        throw new CartError('PRODUCT_NOT_FOUND', 'No such product', 404);
    }

    const remaining = productRemaining(product);

    if (remaining <= 0) {
        throw new CartError('OUT_OF_STOCK', 'That item is sold out', 409);
    }

    const existing = await cartRepo.findProductLine(userId, productId);
    const requested = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
    const target = Math.max(1, Math.min(remaining, (existing?.quantity ?? 0) + requested));

    await cartRepo.upsertProduct(userId, productId, target);

    return summarize(userId);
}

/**
 * Add service units, accumulating onto any line that is already there.
 *
 * Accumulating is what a customer expects from "add to cart"; setting an exact
 * figure is what `setQuantity` is for. The result is clamped to the line's limit
 * either way, so adding 40 keys to a cart that already holds 30 lands on the cap
 * of 50 rather than on 70.
 */
async function addService(userId, service, variant, quantity = 1) {
    const row = await servicePriceRepo.findByVariant(service, variant);

    if (!row) {
        throw new CartError('SERVICE_NOT_FOUND', 'No such service', 404);
    }

    if (Number.isFinite(row.stock) && row.stock <= 0) {
        throw new CartError('OUT_OF_STOCK', 'That service is out of stock', 409);
    }

    const limit = serviceLimit(row);
    const existing = await findServiceLine(userId, service, variant);
    const requested = Number.isFinite(quantity) && quantity > 0 ? Math.floor(quantity) : 1;
    const target = Math.max(1, Math.min(limit, (existing?.quantity ?? 0) + requested));

    await cartRepo.upsertService(userId, service, variant, target);

    return summarize(userId);
}

/**
 * Change how many of a service line the customer wants.
 *
 * Product lines ignore this: their quantity is a property of what a skin is, not
 * a preference, so the storefront has no stepper to offer and a request to change
 * it is clamped back to 1 rather than treated as an error.
 */
async function setQuantity(userId, lineId, quantity) {
    const line = await cartRepo.findLine(userId, lineId);

    if (!line) {
        throw new CartError('LINE_NOT_FOUND', 'That item is not in your cart', 404);
    }

    if (line.kind === CART_KIND.PRODUCT) {
        // Clamped to what is left of the listing rather than refused: the same
        // reasoning as `addProduct`. A customer asking for four when three remain
        // gets three, and the cart they were looking at stays intact.
        const product = await productRepo.findBy('id', line.product_id);
        const remaining = product ? productRemaining(product) : 0;

        if (remaining <= 0) {
            throw new CartError('OUT_OF_STOCK', 'That item is sold out', 409);
        }

        const requested = Number.isFinite(quantity) ? Math.floor(quantity) : 1;

        await cartRepo.setQuantity(userId, lineId, Math.max(1, Math.min(remaining, requested)));

        return summarize(userId);
    }

    const row = await servicePriceRepo.findByVariant(line.service, line.variant);
    const limit = row ? serviceLimit(row) : 1;
    const requested = Number.isFinite(quantity) ? Math.floor(quantity) : 1;
    const target = Math.max(1, Math.min(limit, requested));

    await cartRepo.setQuantity(userId, lineId, target);

    return summarize(userId);
}

async function remove(userId, lineId) {
    const removed = await cartRepo.remove(userId, lineId);

    if (!removed) {
        throw new CartError('LINE_NOT_FOUND', 'That item is not in your cart', 404);
    }

    return summarize(userId);
}

async function clear(userId) {
    await cartRepo.clear(userId);

    return summarize(userId);
}

async function findServiceLine(userId, service, variant) {
    const rows = await cartRepo.serviceLinesForUser(userId);

    return rows.find((row) => row.service === service && row.variant === variant) ?? null;
}

module.exports = {
    CART_KIND,
    UNAVAILABLE,
    CartError,
    serviceLimit,
    summarize,
    count,
    addProduct,
    addService,
    setQuantity,
    remove,
    clear,
};
