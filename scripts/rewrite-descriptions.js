/**
 * Rewrites the Persian description of every product already in the catalogue.
 *
 * Strictly an UPDATE of the `desc` column. No title, price, image, id or any
 * other column is touched, so it cannot disturb carts, orders or snapshots.
 *
 * WHAT CHANGES
 *
 * The old descriptions came from a single template per category, so forty
 * rifles read as forty copies of one sentence. This script keeps the facts
 * honest - exterior, float and its real band, collection, StatTrak/Souvenir -
 * but composes them from several phrasings per category, picked from the
 * product's own id. Two AKs still differ, one product never changes between
 * runs, and nothing claims "rarest item on the market" about a common skin.
 *
 * HOW TO RUN
 *
 *    node scripts/rewrite-descriptions.js            # dry-run, first 12 rows
 *    node scripts/rewrite-descriptions.js --all      # dry-run, every row
 *    node scripts/rewrite-descriptions.js --apply    # write, after backing up
 *
 * `--apply` writes a JSON backup of every old description to
 * scripts/backups/descriptions-<timestamp>.json before the first UPDATE.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const db = require(path.join(ROOT, 'app', 'db', 'createDatabase'));

const all = (sql, params = []) =>
   new Promise((res, rej) => db.all(sql, params, (e, r) => (e ? rej(e) : res(r))));
const run = (sql, params = []) =>
   new Promise((res, rej) => db.run(sql, params, function (e) { return e ? rej(e) : res(this) }));

const APPLY = process.argv.includes('--apply');
const SHOW_ALL = process.argv.includes('--all');

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
 * Deterministic pick: the same product always lands on the same line, but
 * neighbouring ids land on different ones. The odd multiplier is what stops
 * ids 1,2,3 from stepping through the variants in order.
 */
function pickFor(id, salt, options) {
   const h = (id * 2654435761 + salt * 40503) % 2147483647;
   return options[h % options.length];
}

function formatFloat(v) {
   if (v === null || v === undefined) return null;
   return Number(v).toString();
}

/** "★ Bayonet | Doppler (Factory New)" -> "Bayonet"; strips variant prefixes so the copy owns those words. */
function weaponNameOf(title) {
   const clean = String(title ?? '')
      .replace(/^★\s*/, '')
      .replace(/^(Souvenir|StatTrak™)\s+/i, '');
   return (clean.split('|')[0] ?? clean).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** "★ Bayonet | Doppler (Factory New)" -> "Doppler" */
function skinNameOf(title) {
   const clean = String(title ?? '').replace(/^★\s*/, '');
   const parts = clean.split('|');
   return (parts[1] ?? clean).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** The readable name after the "|" of a Sticker/Charm/Patch/Agent/Music Kit title. */
function nameAfterPipe(title, prefix) {
   const clean = String(title ?? '')
      .replace(/^StatTrak™\s*/i, '')
      .replace(new RegExp(`^${prefix}\\s*\\|\\s*`, 'i'), '')
      .trim();
   return clean || String(title ?? '').trim();
}

/* ------------------------------------------------------------------ delivery */

/**
 * Every description must say how the item arrives - that is the one thing the
 * old copy got right - but it does not have to say it the same way 82 times.
 */
const DELIVERY = [
   'تحویل از طریق لینک ترید استیم انجام می‌شود.',
   'پس از پرداخت، پیشنهاد ترید به لینک استیم ثبت‌شده در پنل شما ارسال می‌شود.',
   'تحویل مستقیم به لینک ترید استیم شما انجام می‌شود.',
   'آیتم از طریق ترید استیم به اکانت شما منتقل می‌شود.',
];

const deliveryOf = (id) => pickFor(id, 7, DELIVERY);

/* --------------------------------------------------------------------- copy */

/**
 * Composes the description for one product row.
 *
 * Pure: takes the row, returns the string. Keeping the database out of it is
 * what makes `--all` reviewable before anything is written.
 */
function descriptionFor(product) {
   const title = String(product.title ?? '').trim();
   const category = readCategory(product.category);
   const kind = category.value;
   const sub = category.subcategory;
   const id = product.id;

   const hasWear = Boolean(product.exterior);
   const delivery = deliveryOf(id);

   // Which sentence the copy gets to lean on. Only true things are offered.
   const collection = product.collection
      ? `از کالکشن «${product.collection}» است. `
      : '';
   const stat =
      product.stattrak && kind !== 'gloves' /* gloves have no StatTrak variant */
         ? pickFor(id, 11, [
           'نسخه StatTrak™ است و کشته‌ها روی خود اسکین شمرده می‌شوند. ',
           'StatTrak™ دارد؛ شمارنده کشته‌ها بخشی از خود این قلم است. ',
        ])
      : '';
   const souvenir = !product.stattrak && product.souvenir
      ? 'نسخه Souvenir است و استیکرهای رویداد روی آن ثابت مانده‌اند. '
      : '';

   /* ---- items that carry wear: knives, gloves, weapons ------------------- */

   if (hasWear) {
      const w = weaponNameOf(title);
      const s = skinNameOf(title);
      const e = product.exterior;
      const f = formatFloat(product.pattern_index);
      const band =
         product.float_min !== null && product.float_max !== null
            ? `${Number(product.float_min)}–${Number(product.float_max)}`
            : null;
      const floatClause = f ? `فلوت ${f}${band ? ` در بازه ${band}` : ''}` : '';

      if (kind === 'knife') {
         return pickFor(id, 1, [
            `چاقوی ${w} با طرح «${s}» در وضعیت ${e}؛ ${floatClause}. ${stat}${souvenir}${collection}بدنه دست‌نخورده و مطابق تصویر است. ${delivery}`,
            `«${s}» روی ${w}، وضعیت ${e} با ${floatClause || `بازه ${band}`}. ${stat}${souvenir}${collection}انتخابی برای کلکسیونرها و کسانی که فرسودگی مشخصی می‌خواهند. ${delivery}`,
            `${w} | ${s} (${e}) — ${floatClause}. ${stat}${souvenir}${collection}مطابق تصویر ثبت‌شده است. ${delivery}`,
         ]);
      }

      if (kind === 'gloves') {
         return pickFor(id, 2, [
            `دستکش ${w} با طرح «${s}» در وضعیت ${e}؛ ${floatClause}. ${stat}${souvenir}${collection}متریال و جزئیات روی این قلم به‌وضوح قابل بررسی است. ${delivery}`,
            `«${s}» روی ${w}، ${e} (${floatClause || `بازه ${band}`}). ${stat}${souvenir}${collection}دستکشی دست‌نخورده و آماده‌ی بستن ست‌آپ. ${delivery}`,
            `${w} | ${s} در وضعیت ${e} با ${floatClause}. ${stat}${souvenir}${collection}رنگ و دوخت این نسخه متمایز است. ${delivery}`,
         ]);
      }

      // rifle, pistol, smg, sniper, shotgun, machinegun - and anything with wear
      return pickFor(id, 3, [
         `${w} | ${s} در وضعیت ${e}؛ ${floatClause}. ${stat}${souvenir}${collection}رنگ‌بندی و الگوی اسکین دست‌نخورده و آماده تحویل است. ${delivery}`,
         `اسکین «${s}» روی ${w}، وضعیت ${e} با ${floatClause}. ${stat}${souvenir}${collection}${delivery}`,
         `${w} با طرح «${s}» — ${e} (${floatClause}). ${stat}${souvenir}${collection}مطابق تصویر و آماده‌ی استفاده در بازی. ${delivery}`,
         `«${s}» برای ${w} در وضعیت ${e}؛ ${floatClause}. ${stat}${souvenir}${collection}نمونه‌ای کاربردی برای بازی روزمره. ${delivery}`,
      ]);
   }

   /* ---- items that do not carry wear -------------------------------------- */

   if (kind === 'case') {
      // The catalogue title is the readable name here; the subcategory key
      // would flatten "&" out of "Dreams & Nightmares". The sentence supplies
      // the word "case" itself, so a trailing "Case" would just echo it.
      const name = /case/i.test(title)
         ? title.replace(/\s+case\s*$/i, '').trim()
         : `${String(sub ?? kind)} Case`;
      return pickFor(id, 4, [
         `کیس «${name}»؛ برای باز کردن آن به کلید مخصوص همین کیس نیاز دارید و محتویات بر اساس جدول Valve تصادفی است. ${delivery}`,
         `«${name}» — کیس CS2 با شانس دریافت اسکین‌های کمیاب، از جمله چاقو و دستکش. خود کیس بازنشده و سالم است. ${delivery}`,
         `کیس ${name}؛ بعد از تحویل در اینونتوری شما قرار می‌گیرد و هر زمان بخواهید می‌توانید بازش کنید. ${delivery}`,
      ]);
   }

   if (kind === 'music_kit') {
      const name = nameAfterPipe(title, 'Music Kit');
      return pickFor(id, 5, [
         `میوزیک کیت «${name}»؛ موسیقی منوی بازی و لحظه‌ی MVP را تغییر می‌دهد. بعد از تحویل روی اکانت شما فعال می‌شود. ${delivery}`,
         `«${name}» — یک Music Kit برای CS2. بعد از تحویل از تنظیمات صدا آن را انتخاب می‌کنید. ${delivery}`,
      ]);
   }

   if (kind === 'agent') {
      const name = nameAfterPipe(title, 'Agent');
      return pickFor(id, 6, [
         `عامل «${name}»؛ یک مدل شخصیت قابل بازی در CS2. ${delivery}`,
         `«${name}» — شخصیت قابل انتخاب برای تیم شما در بازی. بعد از تحویل در فهرست عامل‌های اکانتتان قرار می‌گیرد. ${delivery}`,
      ]);
   }

   // "other" holds charms, patches and stickers, which need telling apart.
   if (sub === 'charms') {
      const name = nameAfterPipe(title, 'Charm');
      return pickFor(id, 8, [
         `چارم «${name}»؛ روی سلاح‌های دارای جای چارم در CS2 نصب می‌شود و همراه اسکین خودنمایی می‌کند. ${delivery}`,
         `آویز «${name}» — جزئیات کوچکی که ست‌آپ را کامل می‌کند. بعد از تحویل در اینونتوری شماست. ${delivery}`,
      ]);
   }

   if (sub === 'patches') {
      const name = nameAfterPipe(title, 'Patch');
      return pickFor(id, 9, [
         `پچ «${name}»؛ روی شخصیت (عامل) شما در بازی نصب می‌شود. ${delivery}`,
         `«${name}» — پچ تزئینی CS2 برای شخصیت شما در بازی. ${delivery}`,
      ]);
   }

   if (kind === 'other' && /graffiti/i.test(title)) {
      // Graffiti sit in the same taxonomy bucket as stickers but are not one.
      const name = nameAfterPipe(title, 'Sealed Graffiti');
      return pickFor(id, 13, [
         `گرافیتی «${name}»؛ از اینونتوری می‌توانید آن را باز کرده و روی سطوح بازی استفاده کنید. ${delivery}`,
         `«${name}» — گرافیتی تزئینی برای سطوح بازی. ${delivery}`,
      ]);
   }

   if (kind === 'other' && sub !== 'patches' && sub !== 'charms') {
      // The catalogue's remaining "other" rows are stickers.
      const name = nameAfterPipe(title, 'Sticker');
      return pickFor(id, 10, [
         `استیکر «${name}»؛ روی سطح سلاح‌ها نصب می‌شود. ${delivery}`,
         `«${name}» — استیکر تزئینی CS2. بعد از تحویل روی اکانت شما قرار می‌گیرد. ${delivery}`,
      ]);
   }

   // Anything the taxonomy grows later still gets a truthful, non-committal line.
   return pickFor(id, 12, [
      `«${title}» — یکی از آیتم‌های فروشگاه. برای جزئیات بیشتر با پشتیبانی در ارتباط باشید. ${delivery}`,
      `«${title}». ${delivery}`,
   ]);
}

/* ----------------------------------------------------------------------- run */

;(async () => {
   await new Promise((r) => setTimeout(r, 600));

   const products = await all('SELECT * FROM products ORDER BY id');

   if (products.length === 0) {
      console.log('no products to rewrite');
      process.exit(0);
   }

   const changes = products.map((p) => ({
      id: p.id,
      title: p.title,
      before: String(p.desc ?? ''),
      after: descriptionFor(p),
   }));

   const changed = changes.filter((c) => c.before !== c.after);

   // ---- review output ----------------------------------------------------

   console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} — ${products.length} product(s), ${changed.length} description(s) to change\n`);

   const shown = SHOW_ALL || APPLY ? changes : changes.slice(0, 12);
   for (const c of shown) {
      console.log(`#${c.id}  ${c.title}`);
      if (c.before === c.after) {
         console.log('   (unchanged)\n');
         continue;
      }
      console.log(`  old: ${c.before}`);
      console.log(`  new: ${c.after}\n`);
   }
   if (!SHOW_ALL && !APPLY && changes.length > shown.length) {
      console.log(`…and ${changes.length - shown.length} more row(s) — run with --all to review them all.\n`);
   }

   if (!APPLY) {
      console.log('Nothing written. Re-run with --apply to save these descriptions.');
      process.exit(0);
   }

   // ---- backup -------------------------------------------------------------

   const backupDir = path.join(__dirname, 'backups');
   fs.mkdirSync(backupDir, { recursive: true });
   const stamp = new Date().toISOString().replace(/[:.]/g, '-');
   const backupPath = path.join(backupDir, `descriptions-${stamp}.json`);
   fs.writeFileSync(
      backupPath,
      JSON.stringify(
         products.map((p) => ({ id: p.id, title: p.title, desc: p.desc })),
         null,
         2
      )
   );
   console.log(`backup written: ${backupPath}\n`);

   // ---- write --------------------------------------------------------------

   let touched = 0;
   for (const c of changed) {
      await run('UPDATE products SET desc = ? WHERE id = ?', [c.after, c.id]);
      touched++;
   }

   console.log(`updated ${touched} product(s)`);
   process.exit(0);
})().catch((err) => {
   console.error(err);
   process.exit(1);
});
