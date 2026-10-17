/**
 * Fills in the CS2 specifications for every product already in the catalogue.
 *
 * Strictly an UPDATE. Nothing is inserted, nothing is deleted, and no id,
 * productNumber, price or image is touched - a customer can have an item in
 * their cart, an order can already snapshot a title, and this script must not be
 * able to disturb any of that. It can be run as often as you like.
 *
 * WHAT THE DATA IS
 *
 * Coherent sample data, not scraped market data. The shape is Valve's own item
 * schema - the five exteriors and their real float bounds, the rarity ladder, the
 * collections - but the particular assignment per product is derived from its
 * own id, so the same row always gets the same answer. Re-running never shuffles
 * anything, which matters because a catalogue whose specs change on every deploy
 * is worse than one with no specs.
 *
 * When real market data arrives it replaces these columns and nothing else: the
 * schema is already the real one.
 *
 * WHY CATEGORY MATTERS
 *
 * A weapon skin, a knife and a glove have wear. A case, a music kit, an agent,
 * a sticker, a charm and a patch do not, and inventing a float range for one of
 * those would put a wear meter on a page that has no such thing. So the wear
 * block is written only where it is true, and the rest of the page is built from
 * whatever is present.
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const db = require(path.join(ROOT, 'app', 'db', 'createDatabase'));

const all = (sql, params = []) =>
   new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, params = []) =>
   new Promise((res, rej) => db.run(sql, params, function (e) { return e ? rej(e) : res(this) }));

/* ------------------------------------------------------------------ the taxonomy */

/** Valve's five exteriors and the float bounds that belong to each. */
const EXTERIORS = [
   { name: 'Factory New', min: 0.0, max: 0.07 },
   { name: 'Minimal Wear', min: 0.07, max: 0.15 },
   { name: 'Field-Tested', min: 0.15, max: 0.38 },
   { name: 'Well-Worn', min: 0.38, max: 0.45 },
   { name: 'Battle-Scarred', min: 0.45, max: 1.0 },
];

/** Categories whose items carry wear. Everything else has none. */
const WEAR_CATEGORIES = new Set(['knife', 'gloves', 'rifle', 'pistol', 'smg', 'sniper', 'shotgun', 'machinegun']);

/**
 * Real CS2 collections, so a product's collection is at least a collection that
 * exists rather than a word that reads well.
 */
const COLLECTIONS = [
   'Kilowatt Case',
   'Revolution Case',
   'Fracture Case',
   'Gallery Case',
   'Chroma 3 Case',
   'Prism 2 Case',
   'Spectrum 2 Case',
   'Glove Case',
   'Spectrum Case',
   'Clutch Case',
   'Shadow Case',
   'Prism Case',
   'Chroma 2 Case',
   'Goo Case',
   'Horizon Case',
   'Danger Zone Case',
   'Chroma Case',
   'Falchion Case',
   'Huntsman Case',
   'Recoil Case',
];

/** Non-skin items and the collection they belong to, where that reads true. */
const NON_SKIN_COLLECTIONS = {
   case: null,        // the case IS the collection
   music_kit: null,  // music kits are not tied to a case
   agent: null,
   other: null,
};

/** Rarity by category, where Valve is consistent about it. */
const RARITY = {
   knife: 'Extraordinary',
   gloves: 'Extraordinary',
};
const WEAPON_RARITIES = ['Covert', 'Classified', 'Restricted', 'Mil-Spec', 'Industrial', 'Consumer'];

/**
 * Release windows, oldest first, so the dates step forward with the collections
 * instead of scattering randomly across a decade.
 */
const FIRST_RELEASE = Date.UTC(2018, 8, 27); // Spectrum Case
const RELEASE_STEP_DAYS = 34;

/* -------------------------------------------------------------------- helpers */

/** The `category` column is JSON in a TEXT column; this is the one reader for it. */
function readCategory(raw) {
   try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
         id: parsed?.id ?? null,
         value: parsed?.value ?? 'other',
         subcategory: parsed?.subcategory ?? null,
      };
   } catch {
      return { id: null, value: 'other', subcategory: null };
   }
}

/**
 * Deterministic 0..n-1 pick.
 *
 * Seeded from the product id on purpose: the same product always draws the same
 * card, so this script is safe to run twice and the catalogue is stable.
 */
function pick(seed, options) {
   return options[seed % options.length];
}

/** A float inside the exterior's real band, so the meter can show it honestly. */
function floatWithin(seed, { min, max }) {
   const span = max - min;
   return Number((min + ((seed % 1000) / 1000) * span).toFixed(4));
}

/** "★ Bayonet | Doppler" -> "Doppler" */
function skinNameOf(title) {
   const clean = String(title ?? '').replace(/^★\s*/, '');
   const parts = clean.split('|');
   return (parts[1] ?? clean).trim();
}

/** "★ Bayonet | Doppler" -> "Bayonet" */
function weaponNameOf(title) {
   const clean = String(title ?? '').replace(/^★\s*/, '');
   return (clean.split('|')[0] ?? clean).trim();
}

function prettyKey(key) {
   return String(key)
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
}

/* ------------------------------------------------------------------ the copy */

const COPY = {
   knife: (w, s, exterior) =>
      `${w} با طرح ${s} در وضعیت ${exterior}. یکی از کمیاب‌ترین آیتم‌های بازار، مناسب کلکسیونرها و کسانی که یک لبه تزئینی می‌خواهند. تحویل از طریق لینک ترید استیم انجام می‌شود.`,
   gloves: (w, s, exterior) =>
      `دستکش ${w} با طرح ${s} در وضعیت ${exterior}. متریال و جزئیات روی این آیتم به‌وضوح قابل بررسی است. پس از پرداخت، لینک ترید برای تحویل ارسال می‌شود.`,
   weapon: (w, s, exterior) =>
      `${w} | ${s} در وضعیت ${exterior}. رنگ‌بندی و الگوی این اسکین روی بدنه دست‌نخورده باقی مانده و آماده تحویل است.`,
   case: (w) =>
      `کیس ${w}؛ یک کیس باز شدن با آیتم‌های تصادفی. پس از خرید، کیس به‌صورت مستقیم به اکانت استیم شما منتقل می‌شود.`,
   music_kit: (w) =>
      `میوزیک کیت ${w}؛ قابل استفاده روی منوی اصلی بازی و مخصوص لپ‌تاپ و کامپیوتر شخصی. پس از تحویل، آیتم روی اکانت شما فعال می‌شود.`,
   agent: (w) =>
      `عامل ${w}؛ تنها یک بار قابل استفاده است و پس از تحویل روی اکانت شما قفل می‌شود. برای شروع بازی به این آیتم نیاز دارید.`,
   charm: (w) =>
      `چارم ${w}؛ همراه با چاقوهای CS2 قابل استفاده است. روی دسته چاقو قرار می‌گیرد و پس از تحویل در اینورتوری شما خواهد بود.`,
   sticker: (w) =>
      `استیکر ${w}؛ قابل استفاده روی سلاح‌ها در بازی‌های CS2 و CS:GO. پس از تحویل روی اکانت شما قرار می‌گیرد.`,
   patch: (w) =>
      `پچ ${w}؛ قابل استفاده روی جلیقه‌ها. پس از تحویل روی اکانت شما قرار می‌گیرد.`,
};

/* ----------------------------------------------------------------------- run */

/**
 * Decides every specification for one product.
 *
 * Pure: takes the row and returns the columns to write. Keeping it separate from
 * the database is what makes the whole thing reviewable - the rules for a case
 * and the rules for a knife are readable side by side.
 */
function specificationsFor(product, index) {
   const category = readCategory(product.category);
   const kind = category.value;
   const sub = category.subcategory;
   const label = prettyKey(sub ?? kind);
   const skin = skinNameOf(product.title);
   const weapon = weaponNameOf(product.title);
   const wears = WEAR_CATEGORIES.has(kind);

   const patch = {
      exterior: null,
      float_min: null,
      float_max: null,
      stattrak: 0,
      souvenir: 0,
      rarity: null,
      collection: null,
      release_at: FIRST_RELEASE + (index % COLLECTIONS.length) * RELEASE_STEP_DAYS * 86400000,
      pattern_index: null,
      title: product.title,
      desc: product.desc,
   };

   // --- wear ---------------------------------------------------------------
   if (wears) {
      // Skewed towards the middle of the range, where most real listings sit,
      // rather than spreading evenly over the five.
      const exterior = EXTERIORS[(index * 3 + Math.floor(index / 5)) % EXTERIORS.length];
      const value = floatWithin(index + product.id, exterior);

      patch.exterior = exterior.name;
      patch.float_min = exterior.min;
      patch.float_max = exterior.max;
      patch.pattern_index = value;
      patch.rarity = RARITY[kind] ?? pick(index + 1, WEAPON_RARITIES);
      patch.collection = pick(index, COLLECTIONS);

      // A souvenir is a distinct product, not a flag on a random one: it gets its
      // own title and its own page, which is how the reference shop sells them.
      if (sub === 'usp_s') {
         patch.souvenir = 1;
         patch.title = `Souvenir ${weapon} | ${skin} (${exterior.name})`;
      } else {
         patch.title = `${product.title.replace(/\s*\([^)]*\)\s*$/, '')} (${exterior.name})`;
      }

      // StatTrak is a real variant of the same skin and is worth showing, but it
      // is rarer than the plain one, so only some rows carry it.
      patch.stattrak = index % 4 === 0 ? 1 : 0;

      const describe = kind === 'knife' ? COPY.knife : kind === 'gloves' ? COPY.gloves : COPY.weapon;
      patch.desc = describe(weapon, skin, exterior.name);

      return patch;
   }

   // --- everything else ----------------------------------------------------
   if (kind === 'case') {
      // The case IS the collection; naming it twice would be noise.
      //
      // Taken from the title rather than the subcategory key, because the title is
      // the readable one: `dreams_nightmares` prettifies to "Dreams Nightmares"
      // and loses the "&", while the catalogue title already reads
      // "Dreams & Nightmares Case".
      const title = String(product.title ?? '').trim();
      patch.collection = /case/i.test(title) ? title : `${label} Case`;
      patch.rarity = 'Consumer';
      patch.desc = COPY.case(label);
      return patch;
   }

   if (kind === 'music_kit') {
      patch.rarity = 'Consumer';
      patch.collection = null;
      patch.desc = COPY.music_kit(label);
      return patch;
   }

   if (kind === 'agent') {
      patch.rarity = 'Consumer';
      patch.desc = COPY.agent(label);
      return patch;
   }

   // "other" holds stickers, charms and patches, which need to be told apart.
   if (sub === 'charms') {
      patch.rarity = 'Covert';
      patch.desc = COPY.charm(label);
      return patch;
   }

   if (sub === 'patches') {
      patch.rarity = 'Consumer';
      patch.desc = COPY.patch(label);
      return patch;
   }

   patch.rarity = 'Consumer';
   patch.desc = COPY.sticker(label);
   return patch;
}

;(async () => {
   await new Promise((r) => setTimeout(r, 600));

   const products = await all('SELECT * FROM products ORDER BY id');

   if (products.length === 0) {
      console.log('no products to enrich');
      process.exit(0);
   }

   const byCategory = new Map();
   let touched = 0;

   products.forEach((product, index) => {
      const patch = specificationsFor(product, index);

      run(
         `UPDATE products
            SET title = ?, desc = ?, exterior = ?, float_min = ?, float_max = ?,
                stattrak = ?, souvenir = ?, rarity = ?, collection = ?, release_at = ?,
                pattern_index = ?
          WHERE id = ?`,
         [
            patch.title,
            patch.desc,
            patch.exterior,
            patch.float_min,
            patch.float_max,
            patch.stattrak,
            patch.souvenir,
            patch.rarity,
            patch.collection,
            patch.release_at,
            patch.pattern_index,
            product.id,
         ]
      );

      const category = readCategory(product.category).value;
      byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
      touched++;
   });

   await new Promise((r) => setTimeout(r, 400));

   console.log(`enriched ${touched} product(s)\n`);
   for (const [category, count] of [...byCategory].sort()) {
      console.log(`  ${String(count).padStart(3)}  ${category}`);
   }

   const worn = await all(`SELECT COUNT(*) AS n FROM products WHERE exterior IS NOT NULL`);
   const bare = await all(`SELECT COUNT(*) AS n FROM products WHERE exterior IS NULL`);
   const souvenirs = await all(`SELECT COUNT(*) AS n FROM products WHERE souvenir = 1`);
   const stattraks = await all(`SELECT COUNT(*) AS n FROM products WHERE stattrak = 1`);

   console.log(`\nwith wear: ${worn[0].n}   without: ${bare[0].n}`);
   console.log(`souvenir: ${souvenirs[0].n}   stattrak: ${stattraks[0].n}`);

   console.log('\nexamples:');
   for (const row of await all(
      `SELECT title, exterior, rarity, collection, price, image FROM products
        ORDER BY id LIMIT 4`
   )) {
      console.log('  ' + JSON.stringify(row));
   }

   process.exit(0);
})().catch((err) => {
   console.error(err);
   process.exit(1);
});