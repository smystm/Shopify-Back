/**
 * A block of statements that must land together or not at all.
 *
 * Nothing else in the app needs a transaction: carts, wishlists and profiles are
 * each a single statement, and SQLite makes a single statement atomic on its own.
 * The two things that do need one - checking out, and settling a payment - both
 * move money, which is exactly the case where "half applied" is unacceptable.
 *
 * The block runs on a connection of its own rather than the shared one. On the
 * shared connection, any other request that happened to run between our
 * statements would be silently folded into our transaction - and then rolled back
 * with it if we failed, quietly discarding whatever that other request did.
 * A private connection keeps the block genuinely private.
 *
 * `BEGIN IMMEDIATE` takes SQLite's write lock up front rather than waiting until
 * the first write. That is what lets a caller read the ledger, decide, and write,
 * knowing the numbers cannot move underneath them. The busier moments then queue
 * on `busy_timeout` instead of failing outright.
 */
const path = require('path');
const sqlite3 = require('sqlite3');

const sharedDb = require('./createDatabase');

// How long a blocked writer waits for the lock before giving up. Checkout holds
// the lock for a handful of statements, so anything approaching this is a bug
// rather than contention.
const BUSY_TIMEOUT_MS = 5000;

// Resolved once, so a later process.chdir() cannot quietly point this elsewhere.
let databasePath = null;

function resolveDatabasePath() {
    if (!databasePath) {
        databasePath = path.resolve(sharedDb.filename);
    }

    return databasePath;
}

function open() {
    return new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(resolveDatabasePath(), (err) => {
            if (err) return reject(err);
            resolve(connection);
        });
    });
}

function run(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function get(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.get(sql, params, (err, row) => (err ? reject(err) : resolve(row ?? null)));
    });
}

function all(connection, sql, params = []) {
    return new Promise((resolve, reject) => {
        connection.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows ?? [])));
    });
}

/**
 * Run `work` inside one transaction and resolve with whatever it returns.
 *
 * `work` receives the transaction's own `run` / `get` / `all` - the statements it
 * uses have to belong to this connection, so spreading the work across the shared
 * repos is not an option. Anything `work` throws rolls the block back and
 * propagates untouched.
 */
async function withTransaction(work) {
    const connection = await open();

    const statements = {
        run: (sql, params) => run(connection, sql, params),
        get: (sql, params) => get(connection, sql, params),
        all: (sql, params) => all(connection, sql, params),
    };

    try {
        await run(connection, `PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
        await run(connection, 'BEGIN IMMEDIATE');

        const result = await work(statements);

        await run(connection, 'COMMIT');

        return result;
    } catch (err) {
        try {
            await run(connection, 'ROLLBACK');
        } catch {
            // A failed rollback must never mask the reason the block failed.
        }

        throw err;
    } finally {
        connection.close();
    }
}

module.exports = {
    withTransaction,
    resolveDatabasePath,
};
