const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const logger = require('morgan');
const cors = require('cors');

const indexRouter = require('./routes/index');

const app = express();

/**
 * The .env that belongs to this service, not whichever one happens to be in the
 * working directory. Bare `require("dotenv").config()` looks at process.cwd(), so
 * a server started from anywhere else loaded no TOKEN_KEY at all and every
 * authenticated route answered 403 - and, alongside the database path, it meant
 * "start it from the wrong folder" quietly produced a different, broken app.
 */
require("dotenv").config({ path: path.join(__dirname, ".env") });

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
/**
 * Which browser origins may call this API.
 *
 * `FRONTEND_URL` was already in the .env and went unused, while CORS was pinned to
 * `http://localhost:3000` - so the moment the shop was served from anywhere else
 * every request was blocked before it reached a route. A comma-separated list,
 * because one shop may have a staging domain as well as the live one.
 *
 * This is defence in depth rather than the mechanism: the storefront talks to this
 * API through its own `/api` handler, so requests arrive same-origin and CORS never
 * decides anything. It still matters for poking at the API by hand, and for the
 * day somebody points a mobile app or a second storefront at it.
 */
const allowedOrigins = (process.env.FRONTEND_URL || 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  credentials : true,
  origin(origin, callback) {
    // No Origin header at all means curl, a health check or another server. Those
    // are not browser requests and CORS does not apply to them.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    // Answer without the CORS headers rather than with an error: the browser then
    // blocks the response, which is the outcome we want, and a 500 would just be a
    // confusing way of saying the same thing.
    return callback(null, false);
  }
}))
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', indexRouter);

module.exports = app;