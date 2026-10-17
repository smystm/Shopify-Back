var express = require('express');
var router = express.Router();
var servicePriceRepo = require('../app/db/repos/servicePrice');

/**
 * Public prices for the store's non-skin goods: CS2 Prime per Steam region and
 * the TF2 Mann Co. key.
 *
 * Unauthenticated like the catalogue endpoints, and for the same reason: /prime
 * and /tf2-keys are storefront pages that signed-out visitors read before they
 * have an account, and nothing here is scoped to a user.
 *
 * `?service=prime` narrows the listing to one good; without it every row comes
 * back and the caller groups them.
 */
router.get('/', async (req, res, next) => {
  try {
    const { service } = req.query;

    const prices = service
      ? await servicePriceRepo.byService(String(service))
      : await servicePriceRepo.all();

    res.json({ status: 'success', prices });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
