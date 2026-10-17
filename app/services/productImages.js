const { getImageForCategory, getSubcategories, getImagesForSubcategory, categoryForTitle } = require('./categories');

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Which subcategory inside a category does this title name?
 *
 * Matching is on the name only, because that is all a title carries: the catalogue
 * says which subcategories exist and what they are called, and the title decides
 * which one this is.
 */
async function subcategoryForTitle(title, categoryValue) {
  const titleValue = normalized(title);
  const subcategories = await getSubcategories(categoryValue);
  return subcategories.find((subcategory) => {
    const key = normalized(subcategory);
    const singularKey = key.endsWith('es') ? key.slice(0, -2) : key.endsWith('s') ? key.slice(0, -1) : key;
    return key && (titleValue.includes(key) || titleValue.includes(singularKey) || key.includes(titleValue));
  }) ?? null;
}

/**
 * The picture to file a new product under.
 *
 * Every product in a subcategory shares that subcategory's image, so the answer is
 * whichever one the catalogue already uses - not a guess at a filename. A
 * subcategory nothing has ever been filed under has no picture to offer, and says
 * so, rather than inventing a path to a file that may not exist.
 */
async function productImageForTitle(title) {
  const category = await categoryForTitle(title);
  if (!category) return null;
  const subcategory = await subcategoryForTitle(title, category.value);
  return subcategory
    ? (await getImagesForSubcategory(category.value, subcategory))[0] ?? null
    : await getImageForCategory(category.value);
}

async function productImageForCategory(categoryValue, title) {
  const subcategory = title ? await subcategoryForTitle(title, categoryValue) : null;
  return subcategory
    ? (await getImagesForSubcategory(categoryValue, subcategory))[0] ?? null
    : await getImageForCategory(categoryValue);
}

module.exports = { productImageForTitle, productImageForCategory };
