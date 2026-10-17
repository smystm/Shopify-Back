var express = require('express');
var router = express.Router();
var { getCategoryTree } = require('../app/services/categories');

/**
 * GET /categories - the catalogue's own taxonomy.
 *
 * Every category in the shop, each with the subcategories inside it. Read from the
 * products themselves rather than from a folder of images in another repository:
 * see app/services/categories.js for why that mattered.
 */
router.get('/', async (req, res, next) => {
  try {
    res.json({ status: 'success', categories: await getCategoryTree() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
