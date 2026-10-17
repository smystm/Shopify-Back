/**
 * Prices for the store's non-skin goods.
 *
 *   node scripts/seed-services.js
 *
 * Idempotent: UNIQUE(service, variant) makes each row an upsert, so running this
 * again after a price change rewrites the numbers in place instead of appending
 * a second Argentina.
 *
 * Every figure is Toman, exactly as listed on the storefront - there is no
 * currency conversion anywhere in this codebase, and the frontend only decides
 * how the amount is *written* (see app/lib/formatPrice.ts).
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const servicePriceRepo = require(path.join(ROOT, 'app', 'db', 'repos', 'servicePrice'));

/**
 * CS2 Prime, sold per Steam region.
 *
 * Steam's own regional pricing is what makes the six amounts differ, so the
 * region is the thing being bought - not a cosmetic option. Array order is
 * display order: it is the order the region picker renders.
 *
 * Every region shares one piece of artwork - it is the same badge whichever
 * Steam region the account is in; the flag that distinguishes them is a frontend
 * asset keyed by variant.
 */
const PRIME_ARTWORK = '/images/others/cs2-prime.webp';

const PRIME_REGIONS = [
    { variant: 'argentina', price: '4801840' },
    { variant: 'europe', price: '5149341' },
    { variant: 'ukraine', price: '4738658' },
    { variant: 'usa', price: '4944000' },
    { variant: 'turkey', price: '4833431' },
    { variant: 'india', price: '4738658' },
];

/**
 * A single Mann Co. key price, with the bot's stock behind it.
 *
 * `maxQuantity` is the per-order buyer cap rather than stock: Steam will not
 * hold more than 50 keys in one account, so the storefront clamps its quantity
 * stepper to this.
 */
const TF2_KEY = { variant: 'key', price: '466000', stock: 426, maxQuantity: 50, image: '/images/others/tf2.png' };

/**
 * Wait until the table is readable before seeding it.
 *
 * `createDatabase` opens the handle synchronously but submits its CREATE TABLE
 * statements from the connection's `open` event, which fires on the next tick. A
 * seed script that inserts on the first tick therefore loses the race and dies
 * with "no such table". Retrying until the table answers is enough, and it also
 * makes this script safe to run against a database that has never been touched.
 */
async function waitForSchema() {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            await servicePriceRepo.all();
            return;
        } catch (err) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    throw new Error('service_prices never became readable - is it still created in app/db/createDatabase.js?');
}

async function main() {
    await waitForSchema();

    for (const [index, region] of PRIME_REGIONS.entries()) {
        await servicePriceRepo.upsert({ service: 'prime', ...region, position: index, image: PRIME_ARTWORK });
    }

    await servicePriceRepo.upsert({ service: 'tf2_keys', ...TF2_KEY, position: 0 });

    const prices = await servicePriceRepo.all();

    console.log(`Seeded ${prices.length} service prices:`);
    for (const row of prices) {
        const stock = row.stock === null || row.stock === undefined ? '' : `   stock ${row.stock}`;
        const cap = row.max_quantity === null || row.max_quantity === undefined ? '' : `   cap ${row.max_quantity}`;
        console.log(`  ${row.service}/${row.variant}   ${row.price} Toman${stock}${cap}`);
    }

    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
