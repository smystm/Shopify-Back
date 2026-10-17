var express = require('express');
var router = express.Router();
var { getCategories, getSubcategories } = require('../app/services/categories');

router.get('/', async (req, res, next) => {
  try {
    const categories = getCategories().map((category) => ({
      ...category,
      subcategories: getSubcategories(category.value),
    }));
    res.json({ status: 'success', categories });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
