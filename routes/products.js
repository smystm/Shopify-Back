var express = require('express');
var router = express.Router();
var authMiddleware = require('./middlewares/auth');
var productRepo = require('../app/db/repos/product');
var { productImageForTitle, productImageForCategory } = require('../app/services/productImages');
var { specFieldsFromBody, SpecValidationError } = require('../app/services/productSpecs');
const { canViewProducts, canCreateProducts, canModifyProduct } = require('../app/services/permissions');

// comment code : Only users with some product access can list products.
//router.get('/', authMiddleware, async (req, res, next) => {
router.get('/', async (req, res, next) => {
  try {
    // if (!canViewProducts(req.user.permission)) {
    //   return res.status(403).json({ status: 'fail', message: 'You do not have permission to view products' });
    // }
    const { category, minPrice, maxPrice } = req.query;
    const categories = Array.isArray(category)
        ? category
        : category
            ? [category]
            : [];
    const { subcategory } = req.query;
    const subcategories = Array.isArray(subcategory)
        ? subcategory
        : subcategory
            ? [subcategory]
            : [];
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    // Whitelisted rather than passed through, so a hand-edited ?sort= can never
    // reach the repository as anything but one of these three.
    const SORT_ORDERS = ['price_asc', 'price_desc', 'best_selling'];
    const sort = SORT_ORDERS.includes(req.query.sort) ? req.query.sort : '';

    const hasFilters = categories.length > 0 || subcategories.length > 0 || minPrice || maxPrice || search || sort;
    const products = hasFilters
        ? await productRepo.allFiltered({ categories, subcategories, minPrice, maxPrice, search, sort })
        : await productRepo.all();
    res.json({ status: 'success', products });
  } catch (err) {
    next(err);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  try {
    // Only FullAcc and WriteDeleteEditSelfAdds users can add products.
    if (!canCreateProducts(req.user.permission)) {
      return res.status(403).json({ status: 'fail', message: 'You do not have permission to create products' });
    }

    const { productNumber, title, desc, category, price } = req.body;

    if (!productNumber || !title) {
      return res.status(400).json({ status: 'fail', message: 'productNumber and title are required' });
    }

    // The CS2 specification columns - exterior, float band, rarity, stock and
    // friends. Validated and coerced in one place; a bad figure answers 400
    // naming every field at once rather than 500 from SQLite.
    let specs;
    try {
      specs = specFieldsFromBody(req.body);
    } catch (err) {
      if (err instanceof SpecValidationError) {
        return res.status(400).json({ status: 'fail', message: err.errors.join(' '), errors: err.errors });
      }
      throw err;
    }

    // An explicitly provided image wins; the auto-derived artwork is only for a
    // row the admin did not name a file for.
    const image = typeof req.body.image === 'string' && req.body.image.trim() !== ''
      ? req.body.image.trim()
      : (category ? await productImageForCategory(category.value, title) : await productImageForTitle(title));

    // Store the creator so self-add users can edit/delete their own products later.
    const result = await productRepo.create({ productNumber, title, desc, category, price, image, created_by: req.user.id, ...specs });
    const product = await productRepo.findBy('id', result.id);

    res.status(201).json({ status: 'success', product });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { productNumber, title, desc, category, price } = req.body;

    if (!productNumber || !title) {
      return res.status(400).json({ status: 'fail', message: 'productNumber and title are required' });
    }

    const existing = await productRepo.findBy('id', id);
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'Product not found' });
    }

    if (!canModifyProduct(req.user.permission, req.user, existing)) {
      return res.status(403).json({ status: 'fail', message: 'You do not have permission to edit this product' });
    }

    let specs;
    try {
      specs = specFieldsFromBody(req.body);
    } catch (err) {
      if (err instanceof SpecValidationError) {
        return res.status(400).json({ status: 'fail', message: err.errors.join(' '), errors: err.errors });
      }
      throw err;
    }

    // An explicit image keeps the row exactly as the admin set it; only an
    // absent (or cleared) one falls back to the category-derived artwork.
    // Recomputing on every save used to silently overwrite a hand-picked URL.
    const image = typeof req.body.image === 'string' && req.body.image.trim() !== ''
      ? req.body.image.trim()
      : (category ? await productImageForCategory(category.value, title) : await productImageForTitle(title));

    await productRepo.update(id, { productNumber, title, desc, category, price, image, ...specs });
    const product = await productRepo.findBy('id', id);

    res.json({ status: 'success', product });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;

    const existing = await productRepo.findBy('id', id);
    if (!existing) {
      return res.status(404).json({ status: 'fail', message: 'Product not found' });
    }

    if (!canModifyProduct(req.user.permission, req.user, existing)) {
      return res.status(403).json({ status: 'fail', message: 'You do not have permission to delete this product' });
    }

    await productRepo.delete(id);

    res.json({ status: 'success' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
