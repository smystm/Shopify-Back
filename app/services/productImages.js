const { getImageForCategory, getSubcategories, getImagesForSubcategory, categoryForTitle } = require('./categories');

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function subcategoryForTitle(title, categoryValue) {
  const titleValue = normalized(title);
  const subcategories = getSubcategories(categoryValue);
  return subcategories.find((subcategory) => {
    const key = normalized(subcategory);
    const singularKey = key.endsWith('es') ? key.slice(0, -2) : key.endsWith('s') ? key.slice(0, -1) : key;
    return key && (titleValue.includes(key) || titleValue.includes(singularKey) || key.includes(titleValue));
  }) ?? null;
}

function productImageForTitle(title) {
  const category = categoryForTitle(title);
  if (!category) return null;
  const subcategory = subcategoryForTitle(title, category.value);
  return subcategory
    ? getImagesForSubcategory(category.value, subcategory)[0] ?? null
    : getImageForCategory(category.value);
}

function productImageForCategory(categoryValue, title) {
  const subcategory = title ? subcategoryForTitle(title, categoryValue) : null;
  return subcategory
    ? getImagesForSubcategory(categoryValue, subcategory)[0] ?? null
    : getImageForCategory(categoryValue);
}

module.exports = { productImageForTitle, productImageForCategory };
