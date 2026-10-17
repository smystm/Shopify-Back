/**
 * The database handle, required lazily.
 *
 * createDatabase.js requires this module - to classify titles during its migration -
 * so requiring it at the top of this file would be a cycle. The second module to
 * load gets a half-finished export and then quietly holds an empty object instead
 * of the database, which fails much later and much more confusingly than a
 * duplicate require. Waiting until the first call means both have finished.
 */
function getDb() {
   return require('../db/createDatabase');
}

/**
 * The catalogue's taxonomy, read from the products table.
 *
 * This used to be worked out by listing a directory of PNGs inside the storefront
 * repository - a path reached by counting `..` hops from here. That worked only
 * while the backend lived inside that repository, and it broke the moment the two
 * were split: the listing threw, the error was swallowed, and the shop served 82
 * products with zero categories and an empty "no products" message on the home
 * page. It was also wrong to begin with. A directory of images in another project
 * is not a description of this shop's catalogue.
 *
 * So the catalogue describes itself. Every product already carries the category it
 * belongs to as JSON - {"id":9,"value":"rifle","subcategory":"ak47"} - and its
 * image. Reading those rows back gives the categories, the subcategories within
 * them, and the picture for each, with no filesystem involved and nothing to keep
 * in step. Delete the last knife and the knife category stops being offered,
 * which is correct: there is nothing left to filter.
 *
 * The keyword tables below are the one thing that is not read from data, and that
 * is deliberate. They answer a different question - "which category does this
 * *new* title belong to?" - and there is no row to read for a product that does
 * not exist yet. They can only propose a category that the catalogue already has.
 */

/** The stored shape, with anything missing filled in rather than trusted. */
function parseCategory(raw) {
   if (typeof raw !== "string" || raw.trim() === "") return null;
   try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.value !== "string" || parsed.value === "") return null;
      return {
         id: Number.isFinite(parsed.id) ? parsed.id : null,
         value: parsed.value,
         subcategory: typeof parsed.subcategory === "string" && parsed.subcategory !== "" ? parsed.subcategory : null,
      };
   } catch {
      return null;
   }
}

/**
 * One query for the whole taxonomy.
 *
 * Every getter here is answered from this rather than from a query of its own,
 * because the obvious API - a query per category, twelve of them to build one
 * listing - is the kind of thing that looks fine at 82 products and falls over at
 * 8,000. The table is small and read as one block.
 */
async function loadTaxonomy() {
   const rows = await new Promise((resolve, reject) => {
      getDb().all(
         `SELECT category, image FROM products WHERE category IS NOT NULL AND TRIM(category) != ''`,
         (err, result) => (err ? reject(err) : resolve(result ?? [])),
      );
   });

   /** value -> { id, value, subs: Map<subcategory, Set<image>>, images: Set<image> } */
   const byValue = new Map();

   for (const row of rows) {
      const category = parseCategory(row.category);
      if (!category) continue;

      let entry = byValue.get(category.value);
      if (!entry) {
         entry = { id: category.id, value: category.value, subs: new Map(), images: new Set() };
         byValue.set(category.value, entry);
      }

      // The first row wins for the id. Every product in a category stores the same
      // one, so this only matters for a hand-edited row.
      if (entry.id === null && category.id !== null) entry.id = category.id;

      const image = typeof row.image === "string" && row.image !== "" ? row.image : null;
      if (!image) continue;

      // Tracked per subcategory as well as per category, keyed by the value stored
      // on the product. Deriving it from the image path instead would be another
      // quiet dependency on a folder layout - the same mistake this file used to
      // make, one level down.
      entry.images.add(image);
      if (category.subcategory) {
         let forSub = entry.subs.get(category.subcategory);
         if (!forSub) {
            forSub = new Set();
            entry.subs.set(category.subcategory, forSub);
         }
         forSub.add(image);
      }
   }

   const sorted = [...byValue.values()].sort((a, b) => {
      // By id where the data has one, so the order matches the ids already stored on
      // every product; alphabetically otherwise.
      if (a.id !== null && b.id !== null && a.id !== b.id) return a.id - b.id;
      return a.value.localeCompare(b.value);
   });

   return sorted;
}

/** Categories, each with its id, in the order the catalogue numbers them. */
async function getCategories() {
   const taxonomy = await loadTaxonomy();
   return taxonomy.map(({ id, value }) => ({ id, value }));
}

/** Every subcategory within one category, sorted. */
async function getSubcategories(categoryValue) {
   const taxonomy = await loadTaxonomy();
   const entry = taxonomy.find((c) => c.value === categoryValue);
   return entry ? [...entry.subs.keys()].sort() : [];
}

/** The images the catalogue uses for one subcategory. */
async function getImagesForSubcategory(categoryValue, subcategoryValue) {
   const taxonomy = await loadTaxonomy();
   const entry = taxonomy.find((c) => c.value === categoryValue);
   if (!entry) return [];
   return [...(entry.subs.get(subcategoryValue) ?? [])].sort();
}

/** Every image belonging to a category, across all of its subcategories. */
async function getImagesForCategory(categoryValue) {
   const taxonomy = await loadTaxonomy();
   const entry = taxonomy.find((c) => c.value === categoryValue);
   return entry ? [...entry.images].sort() : [];
}

/** The first image for a category, or null when the catalogue has none. */
async function getImageForCategory(categoryValue) {
   const images = await getImagesForCategory(categoryValue);
   return images.length > 0 ? images[0] : null;
}

/** Categories and their subcategories together, for the one listing the API serves. */
async function getCategoryTree() {
   const taxonomy = await loadTaxonomy();
   return taxonomy.map(({ id, value, subs }) => ({
      id,
      value,
      subcategories: [...subs.keys()].sort(),
   }));
}

/* ------------------------------------------------------------------ new titles */

const TITLE_TO_CATEGORY = {
   deserteagle: 'pistol',
   dualberettas: 'pistol',
   m4a4: 'rifle',
   sg553: 'rifle',
};

const CATEGORY_KEYWORDS = {
   knife: ['bayonet', 'bowieknife', 'butterflyknife', 'falchionknife', 'flipknife', 'gutknife', 'huntsmanknife', 'karambit', 'navajaknife', 'nomadknife', 'paracordknife', 'shadowdaggers', 'skeletonknife', 'stiletto', 'survivalknife', 'talonknife', 'ursusknife', 'classicknife', 'kukriknife'],
   gloves: ['bloodhoundgloves', 'brokenfanggloves', 'drivergloves', 'handwraps', 'hydragloves', 'motogloves', 'specialistgloves', 'sportgloves'],
   pistol: ['cz75auto', 'deserteagle', 'dualberettas', 'fiveseven', 'glock18', 'p2000', 'p250', 'r8revolver', 'tec9', 'usps'],
   rifle: ['ak47', 'aug', 'famas', 'galilar', 'm4a1s', 'm4a4', 'sg553'],
   sniper: ['awp', 'g3sg1', 'scar20', 'ssg08'],
   smg: ['mac10', 'mp5sd', 'mp7', 'mp9', 'p90', 'ppbizon', 'ump45'],
   shotgun: ['mag7', 'nova', 'sawedoff', 'xm1014'],
   machinegun: ['m249', 'negev'],
   agent: ['darryl', 'ricksaw', 'ava', 'operator', 'commando', 'agent'],
   case: ['case'],
   music_kit: ['musickit'],
   other: ['charm', 'sticker', 'graffiti', 'patch', 'capsule'],
};

/**
 * Which existing category does this title belong to?
 *
 * Only ever proposes a category the catalogue already contains - a shop with no
 * gloves cannot have its "Broken Fang" title filed under gloves, because there
 * would be nothing to file it with.
 */
async function categoryForTitle(title) {
   const normalized = String(title ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
   const categories = await getCategories();

   const mapped = TITLE_TO_CATEGORY[normalized];
   if (mapped) {
      const found = categories.find((c) => c.value === mapped);
      if (found) return found;
   }

   for (const [categoryName, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
      if (keywords.some((keyword) => normalized.includes(keyword))) {
         const found = categories.find((c) => c.value === categoryName);
         if (found) return found;
      }
   }

   for (const cat of categories) {
      const catNormalized = cat.value.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (catNormalized && (normalized.includes(catNormalized) || catNormalized.includes(normalized))) {
         return cat;
      }
   }

   return null;
}

module.exports = {
   getCategories,
   getCategoryTree,
   getSubcategories,
   getImagesForCategory,
   getImagesForSubcategory,
   getImageForCategory,
   categoryForTitle,
};
