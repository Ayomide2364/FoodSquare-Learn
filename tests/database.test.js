const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { createDatabase } = require("../server/database");

test("database migration supports phone accounts and preserves existing user relationships", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fryday-migration-"));
    const databasePath = path.join(directory, "orders.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_salt TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'customer',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            total INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        CREATE TABLE order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id TEXT NOT NULL,
            product_name TEXT NOT NULL,
            unit_price INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            line_total INTEGER NOT NULL
        );
        INSERT INTO users (name, email, password_salt, password_hash)
        VALUES ('Existing Customer', 'existing@example.test', 'salt', 'hash');
        INSERT INTO sessions (token_hash, user_id, expires_at)
        VALUES ('existing-session', 1, '2999-01-01T00:00:00.000Z');
        INSERT INTO orders (user_id, customer_name, phone, total)
        VALUES (1, 'Existing Customer', '+2348012345678', 1800);
        INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, line_total)
        VALUES (1, 'classic', 'The Classic', 1800, 1, 1800);
    `);
    legacy.close();

    let database;
    try {
        database = createDatabase(databasePath);
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal(database.prepare("SELECT email FROM users WHERE id = 1").get().email, "existing@example.test");
        assert.ok(database.prepare("SELECT email_verified_at FROM users WHERE id = 1").get().email_verified_at);
        assert.equal(database.prepare("SELECT user_id FROM sessions WHERE token_hash = 'existing-session'").get().user_id, 1);
        assert.equal(database.prepare("SELECT user_id FROM orders WHERE id = 1").get().user_id, 1);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = 1").get().count, 1);
        database.prepare("INSERT INTO users (name, phone) VALUES (?, ?)")
            .run("Phone Customer", "+2348012345678");
        assert.equal(database.prepare("SELECT email FROM users WHERE phone = ?").get("+2348012345678").email, null);

        database.exec("DELETE FROM products");
        database.close();
        database = createDatabase(databasePath);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM products").get().count, 0);
        assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
        database?.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
