/**
 * Gives every product a stock figure, between MIN and MAX.
 *
 * The figures are genuinely random, and that is the point - a catalogue where
 * every skin has exactly 50 in stock looks like a spreadsheet, not a shop. It is
 * also why this script refuses to touch a row that already has one: randomness
 * that re-rolls on every deploy would mean the number a customer was just told
 * "45 in stock" is different a minute later. It writes each figure once and then
 * leaves it alone, which makes running this repeatedly safe.
 *
 * Only `count` is touched. `sold_count` is how much has been *bought*, which is
 * the shop's business and not this script's.
 *
 * Run: node scripts/assign-stock.js
 */
const crypto = require('crypto');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const db = require(path.join(ROOT, 'app', 'db', 'createDatabase'));

/** Inclusive on both ends: 40 through 60. */
const MIN = 40;
const MAX = 60;

const all = (sql, params = []) =>
   new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, params = []) =>
   new Promise((res, rej) => db.run(sql, params, function (e) { return e ? rej(e) : res(this) }));

/** Uniform in [MIN, MAX]. crypto, not Math.random, for no good reason except that it is here. */
const roll = () => crypto.randomInt(MIN, MAX + 1);

;(async () => {
   await new Promise((r) => setTimeout(r, 600));

   const products = await all('SELECT id, title, count FROM products ORDER BY id');

   if (products.length === 0) {
      console.log('no products to stock');
      process.exit(0);
   }

   const unstocked = products.filter((p) => p.count === null || p.count === undefined);
   const kept = products.length - unstocked.length;

   let assigned = 0;

   for (const product of unstocked) {
      await run('UPDATE products SET count = ? WHERE id = ?', [roll(), product.id]);
      assigned++;
   }

   await new Promise((r) => setTimeout(r, 300));

   console.log(`assigned ${assigned} product(s), left ${kept} untouched`);
   if (kept > 0) console.log('  (already-stocked rows are never re-rolled)');

   const summary = await all(
      `SELECT MIN(count) AS lo, MAX(count) AS hi, ROUND(AVG(count), 1) AS avg, COUNT(*) AS n
         FROM products WHERE count IS NOT NULL`
   );

   console.log(`\nrange: ${summary[0].lo} - ${summary[0].hi}   average ${summary[0].avg}   across ${summary[0].n} products`);

   // A histogram, because "it ran" and "the numbers are actually spread out" are
   // different claims and only one of them is worth making.
   const histogram = await all(
      `SELECT count AS stock, COUNT(*) AS n FROM products WHERE count IS NOT NULL
        GROUP BY count ORDER BY count`
   );

   console.log('\ndistribution:');
   for (const row of histogram) {
      const bars = '#'.repeat(row.n)
      console.log(`  ${String(row.stock).padStart(3)}  ${String(row.n).padStart(2)}  ${bars}`)
   }

   console.log('\nexamples:');
   for (const row of await all('SELECT id, title, count, sold_count FROM products ORDER BY id LIMIT 6')) {
      console.log(`  #${row.id}  ${String(row.count).padStart(3)} in stock   ${row.title}`)
   }

   process.exit(0);
})().catch((err) => {
   console.error(err);
   process.exit(1);
});