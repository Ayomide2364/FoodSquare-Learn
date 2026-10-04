const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = "fryday_session";
const SESSION_LENGTH = 7 * 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function validEmail(email) {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function hashToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPasswordSync(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

async function verifyPassword(password, salt, expectedHash) {
    const actualHash = await scrypt(password, Buffer.from(salt, "hex"), 64);
    const expected = Buffer.from(expectedHash, "hex");
    return actualHash.length === expected.length && crypto.timingSafeEqual(actualHash, expected);
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function cookieValue(request) {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : "";
}

function createAuth(database, { adminEmail, adminPassword, secureCookies = false } = {}) {
    const cleanAdminEmail = normalizeEmail(adminEmail);
    if (Boolean(cleanAdminEmail) !== Boolean(adminPassword)) {
        throw new Error("Set both ADMIN_EMAIL and ADMIN_PASSWORD to provision the admin account.");
    }
    if (cleanAdminEmail) {
        if (!validEmail(cleanAdminEmail) || adminPassword.length < 12 || adminPassword.length > 128) {
            throw new Error("ADMIN_EMAIL must be valid and ADMIN_PASSWORD must contain 12 to 128 characters.");
        }
        const credentials = hashPasswordSync(adminPassword);
        database.prepare(`
            INSERT INTO users (name, email, password_salt, password_hash, role, email_verified_at)
            VALUES ('Fryday Admin', ?, ?, ?, 'admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT(email) DO UPDATE SET
                name = excluded.name,
                password_salt = excluded.password_salt,
                password_hash = excluded.password_hash,
                role = 'admin',
                email_verified_at = COALESCE(users.email_verified_at, excluded.email_verified_at)
        `).run(cleanAdminEmail, credentials.salt, credentials.hash);
    }

    function setSessionCookie(response, token, maxAge) {
        const secure = secureCookies ? "; Secure" : "";
        response.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
    }

    function createSession(userId, response) {
        const token = crypto.randomBytes(32).toString("base64url");
        const expiresAt = new Date(Date.now() + SESSION_LENGTH).toISOString();
        database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
            .run(hashToken(token), userId, expiresAt);
        setSessionCookie(response, token, Math.floor(SESSION_LENGTH / 1000));
    }

    function userFromRequest(request) {
        const token = cookieValue(request);
        if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return null;
        const session = database.prepare(`
            SELECT users.id, users.name, users.email, users.phone, users.role
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
        `).get(hashToken(token), new Date().toISOString());
        if (!session) return null;
        return {
            id: session.id,
            name: session.name,
            email: session.email,
            phone: session.phone,
            role: session.role
        };
    }

    function destroySession(request, response) {
        const token = cookieValue(request);
        if (/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
            database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
        }
        setSessionCookie(response, "", 0);
    }

    return { createSession, destroySession, userFromRequest };
}

module.exports = {
    createAuth,
    hashPassword,
    hashPasswordSync,
    hashToken,
    normalizeEmail,
    validEmail,
    verifyPassword
};