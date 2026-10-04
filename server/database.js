const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const initialMenu = require("./menu");

function createDatabase(databasePath) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });

    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE COLLATE NOCASE,
            password_salt TEXT,
            password_hash TEXT,
            role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
            phone TEXT,
            google_sub TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            customer_name TEXT NOT NULL,
            phone TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            address TEXT NOT NULL DEFAULT '',
            fulfillment TEXT NOT NULL DEFAULT 'pickup',
            payment_method TEXT NOT NULL DEFAULT 'cash',
            promo_code TEXT NOT NULL DEFAULT '',
            subtotal INTEGER NOT NULL DEFAULT 0,
            delivery_fee INTEGER NOT NULL DEFAULT 0,
            discount INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL CHECK (total > 0),
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            product_id TEXT NOT NULL,
            product_name TEXT NOT NULL,
            unit_price INTEGER NOT NULL CHECK (unit_price > 0),
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            line_total INTEGER NOT NULL CHECK (line_total > 0),
            delivery_fee INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
            delivery_total INTEGER NOT NULL DEFAULT 0 CHECK (delivery_total >= 0)
        );

        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS email_verification_tokens (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS google_oauth_states (
            state_hash TEXT PRIMARY KEY,
            code_verifier TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            price INTEGER NOT NULL CHECK (price > 0),
            delivery_fee INTEGER NOT NULL CHECK (delivery_fee >= 0),
            description TEXT NOT NULL,
            contents TEXT NOT NULL,
            image_url TEXT NOT NULL,
            image_public_id TEXT,
            category TEXT NOT NULL,
            tag TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_metadata (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
    const googleStateColumns = new Set(database.prepare("PRAGMA table_info(google_oauth_states)").all()
        .map((column) => column.name));
    if (!googleStateColumns.has("code_verifier")) {
        database.exec("ALTER TABLE google_oauth_states ADD COLUMN code_verifier TEXT NOT NULL DEFAULT ''");
    }

    const userColumns = new Map(database.prepare("PRAGMA table_info(users)").all()
        .map((column) => [column.name, column]));
    if (userColumns.get("email").notnull || userColumns.get("password_salt").notnull
        || userColumns.get("password_hash").notnull) {
        database.exec("PRAGMA foreign_keys = OFF");
        try {
            database.exec("BEGIN IMMEDIATE");
            database.exec(`
                CREATE TABLE users_new (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    email TEXT UNIQUE COLLATE NOCASE,
                    password_salt TEXT,
                    password_hash TEXT,
                    role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
                    phone TEXT,
                    google_sub TEXT,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                );
                INSERT INTO users_new (id, name, email, password_salt, password_hash, role, created_at)
                SELECT id, name, email, password_salt, password_hash, role, created_at FROM users;
                DROP TABLE users;
                ALTER TABLE users_new RENAME TO users;
                COMMIT;
            `);
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        } finally {
            database.exec("PRAGMA foreign_keys = ON");
        }
    }

    const migratedUserColumns = new Set(database.prepare("PRAGMA table_info(users)").all()
        .map((column) => column.name));
    for (const [name, definition] of [["phone", "TEXT"], ["google_sub", "TEXT"]]) {
        if (!migratedUserColumns.has(name)) database.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
    }
    if (!migratedUserColumns.has("email_verified_at")) {
        database.exec("ALTER TABLE users ADD COLUMN email_verified_at TEXT");
        database.prepare("UPDATE users SET email_verified_at = created_at WHERE email IS NOT NULL").run();
    }
    database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users(phone) WHERE phone IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_unique ON users(google_sub) WHERE google_sub IS NOT NULL;
    `);

    const columns = new Set(database.prepare("PRAGMA table_info(orders)").all().map((column) => column.name));
    const migrations = [
        ["user_id", "INTEGER REFERENCES users(id) ON DELETE SET NULL"],
        ["address", "TEXT NOT NULL DEFAULT ''"],
        ["fulfillment", "TEXT NOT NULL DEFAULT 'pickup'"],
        ["payment_method", "TEXT NOT NULL DEFAULT 'cash'"],
        ["promo_code", "TEXT NOT NULL DEFAULT ''"],
        ["customer_email", "TEXT NOT NULL DEFAULT ''"],
        ["subtotal", "INTEGER NOT NULL DEFAULT 0"],
        ["delivery_fee", "INTEGER NOT NULL DEFAULT 0"],
        ["discount", "INTEGER NOT NULL DEFAULT 0"]
    ];
    for (const [name, definition] of migrations) {
        if (!columns.has(name)) {
            database.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
        }
    }

    const itemColumns = new Set(database.prepare("PRAGMA table_info(order_items)").all().map((column) => column.name));
    const itemMigrations = [
        ["delivery_fee", "INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0)"],
        ["delivery_total", "INTEGER NOT NULL DEFAULT 0 CHECK (delivery_total >= 0)"]
    ];
    for (const [name, definition] of itemMigrations) {
        if (!itemColumns.has(name)) {
            database.exec(`ALTER TABLE order_items ADD COLUMN ${name} ${definition}`);
        }
    }

    const menuSeeded = database.prepare("SELECT value FROM app_metadata WHERE key = 'initial_menu_seeded'").get();
    if (!menuSeeded) {
        database.exec("BEGIN IMMEDIATE");
        try {
            const insertProduct = database.prepare(`
                INSERT INTO products (id, name, price, delivery_fee, description, contents, image_url, category, tag)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const product of initialMenu) {
                insertProduct.run(
                    product.id,
                    product.name,
                    product.price,
                    product.deliveryFee,
                    product.description,
                    JSON.stringify(product.contents),
                    product.imageUrl,
                    product.category,
                    product.tag
                );
            }
            database.prepare("INSERT INTO app_metadata (key, value) VALUES ('initial_menu_seeded', '1')").run();
            database.exec("COMMIT");
        } catch (error) {
            database.exec("ROLLBACK");
            throw error;
        }
    }

    return database;
}

module.exports = { createDatabase };