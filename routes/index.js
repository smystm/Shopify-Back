const express = require('express');
const router = express.Router();

/**
 * ============================================================================
 * LEGACY PHONE AUTH - PRESERVED, NOT DELETED.
 *
 * This is the sign-in the shop ran before Steam. It is kept whole, working and
 * mounted, because it is the rollback: AUTH_PROVIDER=phone brings the storefront
 * straight back to it with no code change.
 *
 * Both routers are required here unconditionally - loading a module is not
 * mounting it - but only ONE of them is ever mounted. That matters: the phone
 * flow and the Steam flow both want the `/auth` prefix, and mounting both would
 * leave two handlers competing for the same paths. The choice is made once, in
 * one place, rather than discovered at runtime.
 *
 * See docs/steam-auth-cutover.md for the cutover and the rollback.
 * ============================================================================
 *
 * Which sign-in this shop is running. `phone` is the live default; nothing about
 * Steam is switched on until this is changed.
 */
const useSteam = process.env.AUTH_PROVIDER === 'steam';
console.log(`[auth] sign-in provider: ${useSteam ? 'steam' : 'phone'}${useSteam ? '' : ' (legacy phone auth)'}`);

const authMiddleware = require('./middlewares/auth')
const walletRepo = require('../app/db/repos/wallet')
const { buildProfile } = require('../app/services/profile')

const phoneAuthRouter = require('./legacyPhoneAuth');
const steamRouter = require('./steam');
const steamLinkRouter = require('./steamLink');
const usersRouter = require('./users');
const productsRouter = require('./products');
const categoriesRouter = require('./categories');
const servicesRouter = require('./services');
const ordersRouter = require('./orders');
const tradeOffersRouter = require('./tradeOffers');
const inventoryRouter = require('./inventory');
const walletRouter = require('./wallet');
const wishlistRouter = require('./wishlist');
const cartRouter = require('./cart');
const paymentsRouter = require('./payments');
const profileRouter = require('./profile');


/* GET home page. */
router.get('/', (req, res, next) => {
  res.json({ success : 'node shop api'});
});

/**
 * GET /auth/mode — which sign-in this shop is running.
 *
 * Always mounted, and deliberately outside the provider branch below. The
 * storefront asks this before anybody is signed in to decide whether to offer a
 * Steam button or a phone form, so it has to answer under both providers - if it
 * only existed with Steam switched on, every visit to /login on a phone shop
 * would be a 404 that the page had to paper over by guessing.
 *
 * Public on purpose: it says which form is on offer, which is on the page anyway.
 */
router.get('/auth/mode', (req, res) => {
  res.json({ status: 'success', provider: useSteam ? 'steam' : 'phone' });
});

/* GET the signed-in customer: profile fields plus the derived wallet balance. */
router.get('/user', authMiddleware , async (req, res, next) => {
  try {
    const balance = await walletRepo.balanceForUser(req.user.id);
    res.json({ status : 'success' , user : buildProfile(req.user, balance) });
  } catch (err) {
    next(err);
  }
});

router.use('/auth' , useSteam ? steamRouter : phoneAuthRouter);
// Linking is reachable under both providers: it is how a phone-era customer gets
// a Steam account onto the row that already holds their orders and balance.
router.use('/auth' , steamLinkRouter);
router.use('/users' , usersRouter);
router.use('/products' , productsRouter);
router.use('/categories' , categoriesRouter);

// Prices for the non-skin goods (CS2 Prime by region, TF2 keys). Public like
// the catalogue, since the storefront pages read it before sign-in.
router.use('/services' , servicesRouter);

// Customer account endpoints. Each scopes its own queries to req.user.id.
router.use('/orders' , ordersRouter);
router.use('/trade-offers' , tradeOffersRouter);
router.use('/inventory' , inventoryRouter);
router.use('/wallet' , walletRouter);
router.use('/wishlist' , wishlistRouter);

// The cart sits next to the wishlist: both are per-customer lists, but a cart
// line is something the customer intends to pay for, so it is priced on every
// read and drained by checkout.
router.use('/cart' , cartRouter);

// The payment gateway rail. Only ever credits the wallet; it does not know what
// an order is. Its callback is the one unauthenticated route under /api - see
// routes/payments.js for why that is safe.
router.use('/payments' , paymentsRouter);
router.use('/user' , profileRouter);

module.exports = router;
