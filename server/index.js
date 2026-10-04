const path = require("node:path");
const rootDirectory = path.resolve(__dirname, "..");
require("dotenv").config({ path: path.join(rootDirectory, ".env") });

const express = require("express");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const crypto = require("node:crypto");
const { createDatabase } = require("./database");
const { createOrderNotifier } = require("./email");
const {
    createAuth,
    hashPassword,
    hashToken,
    normalizeEmail,
    validEmail,
    verifyPassword
} = require("./auth");
const { streamReceipt } = require("./receipt");

const ORDER_STATUSES = ["pending", "preparing", "shipped", "completed", "cancelled"];
const CUSTOMER_CANCELLABLE_STATUSES = ["pending"];
const PRODUCT_CATEGORIES = ["classic", "loaded", "spicy", "sharing"];
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const PASSWORD_RESET_LENGTH = 30 * 60 * 1000;
const EMAIL_VERIFICATION_LENGTH = 24 * 60 * 60 * 1000;
const GOOGLE_STATE_LENGTH = 10 * 60 * 1000;
const googleAuthConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const phoneAuthConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_VERIFY_SERVICE_SID
);
const authRateLimits = new Map();

const app = express();
const database = createDatabase(
    process.env.DATABASE_PATH || path.join(rootDirectory, ".data", "orders.sqlite")
);
const orderNotifier = createOrderNotifier();
const cloudinaryConfigured = Boolean(
    process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
);
if (cloudinaryConfigured) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true
    });
}
const productImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10, fieldSize: 2048 },
    fileFilter(request, file, callback) {
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) {
            callback(new Error("Upload a JPG, PNG, or WebP image."));
            return;
        }
        callback(null, true);
    }
});
const auth = createAuth(database, {
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    secureCookies: process.env.NODE_ENV === "production"
});

app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

function mapProduct(row) {
    return {
        id: row.id,
        name: row.name,
        price: row.price,
        deliveryFee: row.delivery_fee,
        description: row.description,
        contents: JSON.parse(row.contents),
        imageUrl: row.image_url,
        category: row.category,
        tag: row.tag
    };
}

function readProducts() {
    return database.prepare("SELECT * FROM products ORDER BY rowid").all().map(mapProduct);
}

let productById = new Map(readProducts().map((product) => [product.id, product]));

function applicationBaseUrl() {
    return (process.env.APP_BASE_URL || `http://localhost:${Number(process.env.PORT) || 3000}`).replace(/\/+$/, "");
}

async function notifyOrderStatusChange(orderId, status) {
    const order = database.prepare(`
        SELECT orders.customer_name AS customerName, COALESCE(users.email, orders.customer_email) AS customerEmail
        FROM orders LEFT JOIN users ON users.id = orders.user_id
        WHERE orders.id = ?
    `).get(orderId);
    if (!order?.customerEmail) {
        console.warn(`Order #${orderId} status changed to ${status}; no customer email is available.`);
        return;
    }

    try {
        const result = await orderNotifier.sendOrderStatusNotification(order.customerEmail, {
            id: orderId,
            customerName: order.customerName,
            status
        });
        if (!result.sent) {
            console.warn(`Order #${orderId} status email was not sent: ${result.reason}.`);
        }
    } catch (error) {
        console.error(`Order #${orderId} status email failed:`, error.message);
    }
}

function cookieFromRequest(request, name) {
    const cookie = request.headers.cookie?.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`));
    return cookie ? cookie.slice(name.length + 1) : "";
}

function setOAuthStateCookie(response, state, maxAge) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    response.setHeader(
        "Set-Cookie",
        `fryday_oauth_state=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
    );
}

function resetCookie(response) {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    const expiredCookie = `fryday_oauth_state=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
    const existingCookies = response.getHeader("Set-Cookie");
    response.setHeader("Set-Cookie", existingCookies
        ? [...(Array.isArray(existingCookies) ? existingCookies : [existingCookies]), expiredCookie]
        : expiredCookie);
}

function imageFormat(buffer) {
    if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "jpg";
    if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
    return "";
}

function validateProductFields(fields) {
    const name = typeof fields.name === "string" ? fields.name.trim() : "";
    const description = typeof fields.description === "string" ? fields.description.trim() : "";
    const category = fields.category;
    const tag = typeof fields.tag === "string" ? fields.tag.trim() : "";
    const contents = typeof fields.contents === "string"
        ? fields.contents.split(",").map((item) => item.trim()).filter(Boolean)
        : [];
    const price = Number(fields.price);
    const deliveryFee = Number(fields.deliveryFee);
    if (name.length < 2 || name.length > 80
        || description.length < 5 || description.length > 500
        || !Number.isSafeInteger(price) || price < 1 || price > 50000000
        || !Number.isSafeInteger(deliveryFee) || deliveryFee < 0 || deliveryFee > 5000000
        || !PRODUCT_CATEGORIES.includes(category)
        || tag.length > 40
        || contents.length > 10
        || contents.some((item) => item.length < 1 || item.length > 80)) {
        return { error: "Enter a valid name, description, price, delivery fee, category, tag, and up to 10 comma-separated contents." };
    }
    return { product: { name, description, price, deliveryFee, category, tag: tag || name.toUpperCase(), contents } };
}

function slugify(value) {
    const slug = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
    return `${slug || "food"}-${crypto.randomBytes(4).toString("hex")}`;
}

function consumeRateLimit(key, limit, windowLength) {
    const keyHash = hashToken(key);
    const now = Date.now();
    const existing = authRateLimits.get(keyHash);
    if (existing && now - existing.startedAt < windowLength) {
        if (existing.count >= limit) return false;
        existing.count += 1;
        return true;
    }
    authRateLimits.set(keyHash, { startedAt: now, count: 1 });
    if (authRateLimits.size > 10000) {
        for (const [storedKey, entry] of authRateLimits) {
            if (now - entry.startedAt >= windowLength) authRateLimits.delete(storedKey);
        }
    }
    return true;
}

function consumeAuthRateLimit(request, identifier, limit, windowLength) {
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    return consumeRateLimit(`identifier:${identifier}`, limit, windowLength)
        && consumeRateLimit(`ip:${ip}`, limit * 4, windowLength);
}

async function sendEmailVerification(userId, email) {
    if (!orderNotifier.configured) return false;

    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_LENGTH).toISOString();
    database.prepare("DELETE FROM email_verification_tokens WHERE user_id = ?").run(userId);
    database.prepare("DELETE FROM email_verification_tokens WHERE expires_at <= ?").run(new Date().toISOString());
    database.prepare("INSERT INTO email_verification_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(tokenHash, userId, expiresAt);

    const verificationUrl = new URL("/api/auth/email/verify", applicationBaseUrl());
    verificationUrl.searchParams.set("token", token);
    try {
        const result = await orderNotifier.sendEmailVerification(email, verificationUrl.toString());
        if (!result.sent) {
            database.prepare("DELETE FROM email_verification_tokens WHERE token_hash = ?").run(tokenHash);
            console.warn(`Email verification message was not sent: ${result.reason}.`);
            return false;
        }
        return true;
    } catch (error) {
        database.prepare("DELETE FROM email_verification_tokens WHERE token_hash = ?").run(tokenHash);
        console.error("Email verification message failed:", error.message);
        return false;
    }
}

async function twilioVerifyRequest(action, values) {
    const serviceId = encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID);
    const url = `https://verify.twilio.com/v2/Services/${serviceId}/${action}`;
    const authorization = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Basic ${authorization}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams(values),
        signal: AbortSignal.timeout(15000)
    });
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.message || "Phone verification is temporarily unavailable.");
        error.status = response.status;
        throw error;
    }
    return result;
}

app.get("/api/health", (request, response) => {
    response.json({
        status: "ok",
        emailNotificationsConfigured: orderNotifier.configured,
        emailNotificationsStatus: orderNotifier.status,
        passwordResetConfigured: orderNotifier.configured,
        googleAuthenticationConfigured: googleAuthConfigured,
        phoneAuthenticationConfigured: phoneAuthConfigured,
        menuImageUploadsConfigured: cloudinaryConfigured
    });
});

app.get("/api/menu", (request, response) => {
    response.json(readProducts());
});

app.post("/api/auth/register", async (request, response) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (name.length < 2 || name.length > 80) {
        return response.status(400).json({ error: "Enter a name between 2 and 80 characters." });
    }
    if (!validEmail(email)) {
        return response.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
        return response.status(400).json({ error: "Use a password between 12 and 128 characters." });
    }
    if (!orderNotifier.configured) {
        return response.status(503).json({ error: "Email verification is unavailable. Ask the site administrator to configure email delivery." });
    }

    const credentials = await hashPassword(password);
    try {
        const result = database.prepare(`
            INSERT INTO users (name, email, password_salt, password_hash)
            VALUES (?, ?, ?, ?)
        `).run(name, email, credentials.salt, credentials.hash);
        const userId = Number(result.lastInsertRowid);
        if (!await sendEmailVerification(userId, email)) {
            database.prepare("DELETE FROM users WHERE id = ? AND email_verified_at IS NULL").run(userId);
            return response.status(503).json({ error: "We could not send your verification email. Check your email settings and try signing up again." });
        }
        return response.status(202).json({
            verificationRequired: true,
            email,
            message: "Check your email for a verification link to finish creating your account."
        });
    } catch (error) {
        if (error.errcode === 2067) {
            return response.status(409).json({ error: "An account with that email already exists." });
        }
        throw error;
    }
});

app.post("/api/auth/login", async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const password = request.body?.password;
    if (!validEmail(email) || typeof password !== "string" || password.length > 128) {
        return response.status(400).json({ error: "Enter your email and password." });
    }
    const record = database.prepare(`
        SELECT id, name, email, role, password_salt, password_hash, email_verified_at FROM users WHERE email = ?
    `).get(email);
    if (!record?.password_salt || !record.password_hash
        || !(await verifyPassword(password, record.password_salt, record.password_hash))) {
        return response.status(401).json({ error: "Email or password is incorrect." });
    }
    if (!record.email_verified_at) {
        return response.status(403).json({
            error: "Verify your email before signing in. Use the verification link we emailed you, or request another."
        });
    }
    const user = { id: record.id, name: record.name, email: record.email, role: record.role };
    auth.createSession(user.id, response);
    response.json({ user });
});

app.get("/api/auth/email/verify", (request, response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
        return response.redirect("/?emailVerification=invalid");
    }
    database.exec("BEGIN IMMEDIATE");
    let userId;
    try {
        const verified = database.prepare(`
            DELETE FROM email_verification_tokens WHERE token_hash = ? AND expires_at > ?
            RETURNING user_id
        `).get(hashToken(token), new Date().toISOString());
        if (!verified) {
            database.exec("COMMIT");
            return response.redirect("/?emailVerification=invalid");
        }
        userId = verified.user_id;
        database.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?")
            .run(new Date().toISOString(), userId);
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
    auth.createSession(userId, response);
    response.redirect("/?emailVerification=success");
});

app.post("/api/auth/email/verification/resend", async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const genericResponse = {
        message: "If an unverified account exists for that email, a verification link will be sent."
    };
    if (!validEmail(email)) return response.json(genericResponse);
    if (!consumeAuthRateLimit(request, `verify:${email}`, 3, 60 * 60 * 1000)) {
        return response.status(429).json({ error: "Too many verification requests. Try again later." });
    }
    const user = database.prepare(`
        SELECT id, email FROM users WHERE email = ? AND email_verified_at IS NULL AND password_hash IS NOT NULL
    `).get(email);
    if (user && !await sendEmailVerification(user.id, user.email)) {
        return response.status(503).json({ error: "We could not send your verification email. Try again later." });
    }
    response.json(genericResponse);
});

app.post("/api/auth/password-reset/request", async (request, response) => {
    const email = normalizeEmail(request.body?.email);
    const genericResponse = {
        message: "If an account with that email and a password exists, a reset link will be sent."
    };
    if (!validEmail(email)) return response.status(200).json(genericResponse);
    if (!consumeAuthRateLimit(request, email, 5, 60 * 60 * 1000)) {
        return response.status(200).json(genericResponse);
    }

    const user = database.prepare(`
        SELECT id FROM users
        WHERE email = ? AND password_salt IS NOT NULL AND password_hash IS NOT NULL
            AND email_verified_at IS NOT NULL
    `).get(email);
    if (!user) return response.status(200).json(genericResponse);
    if (!orderNotifier.configured) {
        console.warn("Password reset email was not sent because SMTP is not configured.");
        return response.status(200).json(genericResponse);
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_LENGTH).toISOString();
    database.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(user.id);
    database.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?").run(new Date().toISOString());
    database.prepare("INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(tokenHash, user.id, expiresAt);
    try {
        const resetUrl = new URL("/", `${applicationBaseUrl()}/`);
        resetUrl.searchParams.set("resetToken", token);
        const result = await orderNotifier.sendPasswordReset(email, resetUrl.toString());
        if (!result.sent) {
            database.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
            console.warn(`Password reset email was not sent: ${result.reason}.`);
        }
    } catch (error) {
        database.prepare("DELETE FROM password_reset_tokens WHERE token_hash = ?").run(tokenHash);
        console.error("Password reset email failed:", error.message);
    }
    response.json(genericResponse);
});

app.post("/api/auth/password-reset/complete", async (request, response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const password = request.body?.password;
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
        return response.status(400).json({ error: "This password reset link is invalid or has expired." });
    }
    if (typeof password !== "string" || password.length < 12 || password.length > 128) {
        return response.status(400).json({ error: "Use a password between 12 and 128 characters." });
    }
    const reset = database.prepare(`
        SELECT user_id FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?
    `).get(hashToken(token), new Date().toISOString());
    if (!reset) {
        return response.status(400).json({ error: "This password reset link is invalid or has expired." });
    }

    const credentials = await hashPassword(password);
    database.exec("BEGIN IMMEDIATE");
    try {
        const consumed = database.prepare(`
            DELETE FROM password_reset_tokens WHERE token_hash = ? AND expires_at > ?
        `).run(hashToken(token), new Date().toISOString());
        if (consumed.changes === 0) {
            database.exec("ROLLBACK");
            return response.status(400).json({ error: "This password reset link is invalid or has expired." });
        }
        database.prepare("UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?")
            .run(credentials.salt, credentials.hash, reset.user_id);
        database.prepare("DELETE FROM sessions WHERE user_id = ?").run(reset.user_id);
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
    response.json({ message: "Your password has been reset. Sign in with your new password." });
});

app.post("/api/auth/phone/send", async (request, response) => {
    const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const createAccount = request.body?.createAccount === true;
    if (!PHONE_PATTERN.test(phone)
        || name.length > 80
        || createAccount && name.length < 2) {
        return response.status(400).json({
            error: createAccount
                ? "Enter your name and a phone number in international format, such as +2348012345678."
                : "Enter a phone number in international format, such as +2348012345678."
        });
    }
    if (!phoneAuthConfigured) {
        return response.status(503).json({ error: "Phone sign-in is not configured yet. Contact the site administrator." });
    }
    if (!consumeAuthRateLimit(request, phone, 3, 10 * 60 * 1000)) {
        return response.status(429).json({ error: "Too many code requests. Try again later." });
    }
    try {
        const verification = await twilioVerifyRequest("Verifications", {
            To: phone,
            Channel: "sms",
            Locale: process.env.TWILIO_VERIFY_LOCALE || "en"
        });
        if (verification.status !== "pending") {
            console.error("Twilio returned an unexpected verification state:", verification.status);
            return response.status(502).json({ error: "Could not start phone verification. Please try again." });
        }
        response.json({ message: "A verification code has been sent." });
    } catch (error) {
        console.error("Twilio could not send a verification code:", error.message);
        response.status(502).json({ error: "Could not send a verification code. Check the phone number and try again." });
    }
});

app.post("/api/auth/phone/verify", async (request, response) => {
    const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
    const code = typeof request.body?.code === "string" ? request.body.code.trim() : "";
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const createAccount = request.body?.createAccount === true;
    if (!PHONE_PATTERN.test(phone) || !/^\d{4,10}$/.test(code)
        || name.length > 80 || createAccount && name.length < 2) {
        return response.status(400).json({ error: "Enter a valid international phone number and verification code." });
    }
    if (!phoneAuthConfigured) {
        return response.status(503).json({ error: "Phone sign-in is not configured yet. Contact the site administrator." });
    }
    if (!consumeAuthRateLimit(request, phone, 10, 60 * 60 * 1000)) {
        return response.status(429).json({ error: "Too many verification attempts. Try again later." });
    }
    let result;
    try {
        result = await twilioVerifyRequest("VerificationCheck", { To: phone, Code: code });
    } catch (error) {
        console.error("Twilio phone verification failed:", error.message);
        return response.status(error.status === 429 ? 429 : 502).json({
            error: "Could not verify that code. Request a new code and try again."
        });
    }
    if (result.status !== "approved") {
        return response.status(401).json({ error: "That verification code is incorrect or expired." });
    }

    let user = database.prepare("SELECT id, name, email, phone, role FROM users WHERE phone = ?").get(phone);
    if (!user) {
        if (!createAccount) {
            return response.status(404).json({ error: "No Fryday account is linked to that phone number. Create an account first." });
        }
        try {
            const inserted = database.prepare("INSERT INTO users (name, phone) VALUES (?, ?)").run(name, phone);
            user = database.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?")
                .get(Number(inserted.lastInsertRowid));
        } catch (error) {
            if (error.errcode === 2067) {
                return response.status(409).json({ error: "That phone number is already connected to an account." });
            }
            throw error;
        }
    }
    auth.createSession(user.id, response);
    response.json({ user });
});

app.get("/api/auth/google", (request, response) => {
    if (!googleAuthConfigured) {
        return response.redirect("/?authError=google");
    }
    const state = crypto.randomBytes(32).toString("base64url");
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    database.prepare("DELETE FROM google_oauth_states WHERE expires_at <= ?").run(new Date().toISOString());
    database.prepare("INSERT INTO google_oauth_states (state_hash, code_verifier, expires_at) VALUES (?, ?, ?)")
        .run(hashToken(state), codeVerifier, new Date(Date.now() + GOOGLE_STATE_LENGTH).toISOString());
    setOAuthStateCookie(response, state, Math.floor(GOOGLE_STATE_LENGTH / 1000));
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${applicationBaseUrl()}/api/auth/google/callback`;
    const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorizationUrl.search = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email profile",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256"
    }).toString();
    response.redirect(authorizationUrl.toString());
});

app.get("/api/auth/google/callback", async (request, response) => {
    const redirectError = () => {
        resetCookie(response);
        response.redirect("/?authError=google");
    };
    const state = typeof request.query.state === "string" ? request.query.state : "";
    const stateCookie = cookieFromRequest(request, "fryday_oauth_state");
    if (!googleAuthConfigured || !/^[A-Za-z0-9_-]{40,50}$/.test(state) || state !== stateCookie) {
        return redirectError();
    }
    const oauthState = database.prepare(`
        DELETE FROM google_oauth_states WHERE state_hash = ? AND expires_at > ?
        RETURNING code_verifier
    `).get(hashToken(state), new Date().toISOString());
    if (!oauthState || typeof request.query.code !== "string") return redirectError();

    try {
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${applicationBaseUrl()}/api/auth/google/callback`;
        const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                code: request.query.code,
                client_id: process.env.GOOGLE_CLIENT_ID,
                client_secret: process.env.GOOGLE_CLIENT_SECRET,
                redirect_uri: redirectUri,
                grant_type: "authorization_code",
                code_verifier: oauthState.code_verifier
            })
        });
        if (!tokenResponse.ok) throw new Error("Google token exchange was rejected.");
        const tokenResult = await tokenResponse.json();
        const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${tokenResult.access_token}` }
        });
        if (!profileResponse.ok) throw new Error("Google profile lookup failed.");
        const profile = await profileResponse.json();
        const email = normalizeEmail(profile.email);
        if (typeof profile.sub !== "string" || !validEmail(email)
            || profile.email_verified !== true && profile.email_verified !== "true") {
            throw new Error("Google did not return a verified email address.");
        }

        let user = database.prepare("SELECT id, name, email, phone, role, google_sub FROM users WHERE google_sub = ?")
            .get(profile.sub);
        if (!user) {
            const matchingEmail = database.prepare("SELECT id, google_sub FROM users WHERE email = ?").get(email);
            if (matchingEmail?.google_sub && matchingEmail.google_sub !== profile.sub) {
                throw new Error("This email is already linked to another Google account.");
            }
            if (matchingEmail) {
                database.prepare(`
                    UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?
                `).run(profile.sub, new Date().toISOString(), matchingEmail.id);
                user = database.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?")
                    .get(matchingEmail.id);
            } else {
                const name = typeof profile.name === "string" && profile.name.trim()
                    ? profile.name.trim().slice(0, 80)
                    : email.slice(0, 80);
                const inserted = database.prepare(`
                    INSERT INTO users (name, email, google_sub, email_verified_at) VALUES (?, ?, ?, ?)
                `).run(name, email, profile.sub, new Date().toISOString());
                user = database.prepare("SELECT id, name, email, phone, role FROM users WHERE id = ?")
                    .get(Number(inserted.lastInsertRowid));
            }
        } else {
            user = { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role };
        }
        auth.createSession(user.id, response);
        resetCookie(response);
        response.redirect("/?auth=google");
    } catch (error) {
        console.error("Google sign-in failed:", error.message);
        redirectError();
    }
});

app.get("/api/auth/me", (request, response) => {
    const user = auth.userFromRequest(request);
    response.json({ user });
});

app.post("/api/auth/logout", (request, response) => {
    auth.destroySession(request, response);
    response.json({ ok: true });
});

function requireUser(request, response) {
    const user = auth.userFromRequest(request);
    if (!user) {
        response.status(401).json({ error: "Sign in to continue." });
        return null;
    }
    return user;
}

function requireAdmin(request, response) {
    const user = requireUser(request, response);
    if (user && user.role !== "admin") {
        response.status(403).json({ error: "Admin access is required." });
        return null;
    }
    return user;
}

app.post("/api/admin/menu", (request, response, next) => {
    if (!requireAdmin(request, response)) return;
    next();
}, productImageUpload.single("image"), async (request, response) => {
    if (!cloudinaryConfigured) {
        return response.status(503).json({ error: "Menu photo uploads are not configured. Contact the site administrator." });
    }
    if (!request.file || imageFormat(request.file.buffer) !== request.file.mimetype.split("/")[1].replace("jpeg", "jpg")) {
        return response.status(400).json({ error: "Upload a valid JPG, PNG, or WebP image." });
    }
    const validation = validateProductFields(request.body);
    if (validation.error) return response.status(400).json({ error: validation.error });

    const image = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({
            folder: "fryday/menu",
            resource_type: "image",
            allowed_formats: ["jpg", "jpeg", "png", "webp"],
            transformation: [{ width: 1200, height: 1200, crop: "limit" }]
        }, (error, result) => error ? reject(error) : resolve(result))
            .end(request.file.buffer);
    });
    const product = validation.product;
    const id = slugify(product.name);
    try {
        database.prepare(`
            INSERT INTO products
                (id, name, price, delivery_fee, description, contents, image_url, image_public_id, category, tag)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            product.name,
            product.price,
            product.deliveryFee,
            product.description,
            JSON.stringify(product.contents),
            image.secure_url,
            image.public_id,
            product.category,
            product.tag
        );
    } catch (error) {
        try {
            await cloudinary.uploader.destroy(image.public_id, { resource_type: "image" });
        } catch (cleanupError) {
            console.error("Uploaded menu photo cleanup failed:", cleanupError.message);
        }
        throw error;
    }
    const savedProduct = mapProduct(database.prepare("SELECT * FROM products WHERE id = ?").get(id));
    productById = new Map([...productById, [savedProduct.id, savedProduct]]);
    response.status(201).json({ product: savedProduct });
});

app.delete("/api/admin/menu/:productId", async (request, response) => {
    if (!requireAdmin(request, response)) return;
    const product = database.prepare("SELECT id, image_public_id FROM products WHERE id = ?")
        .get(request.params.productId);
    if (!product) return response.status(404).json({ error: "Menu item not found." });

    database.prepare("DELETE FROM products WHERE id = ?").run(product.id);
    productById.delete(product.id);
    let warning;
    if (product.image_public_id && cloudinaryConfigured) {
        try {
            const result = await cloudinary.uploader.destroy(product.image_public_id, { resource_type: "image" });
            if (!["ok", "not found"].includes(result.result)) {
                warning = "The menu item was deleted, but Cloudinary did not confirm photo removal.";
            }
        } catch (error) {
            warning = "The menu item was deleted, but its photo could not be removed from Cloudinary.";
            console.error(`Cloudinary could not delete menu photo ${product.image_public_id}:`, error.message);
        }
    }
    response.json({ deleted: product.id, ...(warning ? { warning } : {}) });
});

function cancellationConflictMessage(status) {
    return status === "cancelled"
        ? "This order has already been cancelled."
        : status === "preparing"
            ? "This order is already being prepared and can no longer be cancelled."
        : "This order can no longer be cancelled because it has been shipped or completed.";
}

app.get("/api/account/orders", (request, response) => {
    const user = requireUser(request, response);
    if (!user) return;
    const orders = database.prepare(`
        SELECT id, fulfillment, payment_method, subtotal, delivery_fee, discount, total, status, created_at
        FROM orders WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).all(user.id).map((order) => ({
        id: order.id,
        fulfillment: order.fulfillment,
        paymentMethod: order.payment_method,
        subtotal: order.subtotal,
        deliveryFee: order.delivery_fee,
        discount: order.discount,
        total: order.total,
        status: order.status,
        createdAt: order.created_at,
        items: database.prepare(`
            SELECT product_name AS name, quantity, unit_price AS unitPrice
            FROM order_items WHERE order_id = ? ORDER BY id
        `).all(order.id)
    }));
    response.json({ orders });
});

app.post("/api/account/orders/:orderId/cancel", async (request, response) => {
    const user = requireUser(request, response);
    if (!user) return;

    const orderId = Number(request.params.orderId);
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
        return response.status(400).json({ error: "Enter a valid order number." });
    }

    const result = database.prepare(`
        UPDATE orders SET status = 'cancelled'
        WHERE id = ? AND user_id = ? AND status = ?
    `).run(orderId, user.id, ...CUSTOMER_CANCELLABLE_STATUSES);
    if (result.changes === 0) {
        const order = database.prepare("SELECT status FROM orders WHERE id = ? AND user_id = ?")
            .get(orderId, user.id);
        return response.status(order ? 409 : 404).json({
            error: order
                ? cancellationConflictMessage(order.status)
                : "Order not found."
        });
    }

    await notifyOrderStatusChange(orderId, "cancelled");
    response.json({ order: { id: orderId, status: "cancelled" } });
});

app.post("/api/orders/:orderId/cancel", async (request, response) => {
    const orderId = Number(request.params.orderId);
    const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !/^[+()\d\s-]{7,20}$/.test(phone)) {
        return response.status(400).json({ error: "Enter a valid order number and phone number." });
    }

    const result = database.prepare(`
        UPDATE orders SET status = 'cancelled'
        WHERE id = ? AND phone = ? AND status = ?
    `).run(orderId, phone, ...CUSTOMER_CANCELLABLE_STATUSES);
    if (result.changes === 0) {
        const order = database.prepare("SELECT status FROM orders WHERE id = ? AND phone = ?")
            .get(orderId, phone);
        return response.status(order ? 409 : 404).json({
            error: order
                ? cancellationConflictMessage(order.status)
                : "We couldn't find an order with those details."
        });
    }

    await notifyOrderStatusChange(orderId, "cancelled");
    response.json({ order: { id: orderId, status: "cancelled" } });
});

app.get("/api/admin/orders", (request, response) => {
    if (!requireAdmin(request, response)) return;
    const orders = database.prepare(`
        SELECT orders.id, orders.customer_name AS customerName, orders.phone, orders.address,
               orders.notes, orders.fulfillment, orders.payment_method AS paymentMethod,
               orders.subtotal, orders.delivery_fee AS deliveryFee, orders.discount, orders.total,
               orders.status, orders.created_at AS createdAt,
               COALESCE(users.email, orders.customer_email) AS customerEmail
        FROM orders LEFT JOIN users ON users.id = orders.user_id
        ORDER BY orders.created_at DESC, orders.id DESC
    `).all().map((order) => ({
        ...order,
        items: database.prepare(`
            SELECT product_name AS name, quantity, unit_price AS unitPrice
            FROM order_items WHERE order_id = ? ORDER BY id
        `).all(order.id)
    }));
    response.json({ orders });
});

app.patch("/api/admin/orders/:orderId", async (request, response) => {
    if (!requireAdmin(request, response)) return;
    const orderId = Number(request.params.orderId);
    const { status } = request.body || {};
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !ORDER_STATUSES.includes(status)) {
        return response.status(400).json({ error: `Choose ${ORDER_STATUSES.join(", ")}.` });
    }
    const result = database.prepare(`
        UPDATE orders SET status = ? WHERE id = ? AND status NOT IN ('cancelled', ?)
    `).run(status, orderId, status);
    if (result.changes === 0) {
        const order = database.prepare("SELECT status FROM orders WHERE id = ?").get(orderId);
        if (order?.status === status) {
            return response.json({ order: { id: orderId, status } });
        }
        return response.status(order ? 409 : 404).json({
            error: order ? "Cancelled orders cannot be changed." : "Order not found."
        });
    }
    await notifyOrderStatusChange(orderId, status);
    response.json({ order: { id: orderId, status } });
});

app.post("/api/orders/:orderId/receipt", (request, response) => {
    const orderId = Number(request.params.orderId);
    const phone = typeof request.body?.phone === "string" ? request.body.phone.trim() : "";
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !/^[+()\d\s-]{7,20}$/.test(phone)) {
        return response.status(400).json({ error: "Enter a valid order number and phone number." });
    }

    const order = database.prepare(`
        SELECT id, customer_name, phone, notes, address, fulfillment, payment_method,
               subtotal, delivery_fee, discount, total, status, created_at
        FROM orders WHERE id = ? AND phone = ?
    `).get(orderId, phone);
    if (!order) {
        return response.status(404).json({ error: "We couldn't find an order with those details." });
    }

    order.items = database.prepare(`
        SELECT product_name, unit_price, quantity, line_total, delivery_fee, delivery_total
        FROM order_items WHERE order_id = ? ORDER BY id
    `).all(orderId);
    streamReceipt(response, order);
});

app.get("/api/orders/:orderId", (request, response) => {
    const orderId = Number(request.params.orderId);
    const phone = typeof request.query.phone === "string" ? request.query.phone.trim() : "";
    if (!Number.isSafeInteger(orderId) || orderId < 1 || !/^[+()\d\s-]{7,20}$/.test(phone)) {
        return response.status(400).json({ error: "Enter a valid order number and phone number." });
    }

    const order = database.prepare(`
        SELECT id, phone, fulfillment, payment_method, subtotal, delivery_fee, discount, total, status, created_at
        FROM orders WHERE id = ? AND phone = ?
    `).get(orderId, phone);
    if (!order) {
        return response.status(404).json({ error: "We couldn't find an order with those details." });
    }

    const items = database.prepare(`
        SELECT product_name AS name, quantity, unit_price AS unitPrice,
               delivery_fee AS deliveryFee, delivery_total AS deliveryTotal
        FROM order_items WHERE order_id = ? ORDER BY id
    `).all(orderId);
    response.json({
        order: {
            id: order.id,
            fulfillment: order.fulfillment,
            paymentMethod: order.payment_method,
            subtotal: order.subtotal,
            deliveryFee: order.delivery_fee,
            discount: order.discount,
            total: order.total,
            status: order.status,
            createdAt: order.created_at,
            items
        }
    });
});

app.post("/api/orders", async (request, response) => {
    const {
        customerName, phone, notes = "", items,
        address = "", fulfillment = "pickup", paymentMethod, promoCode = "", email = ""
    } = request.body || {};
    const cleanName = typeof customerName === "string" ? customerName.trim() : "";
    const cleanPhone = typeof phone === "string" ? phone.trim() : "";
    const cleanNotes = typeof notes === "string" ? notes.trim() : null;
    const cleanAddress = typeof address === "string" ? address.trim() : null;
    const cleanPromoCode = typeof promoCode === "string" ? promoCode.trim().toUpperCase() : null;
    const cleanEmail = typeof email === "string" ? normalizeEmail(email) : null;

    if (cleanName.length < 2 || cleanName.length > 80) {
        return response.status(400).json({ error: "Enter a name between 2 and 80 characters." });
    }

    if (!/^[+()\d\s-]{7,20}$/.test(cleanPhone)) {
        return response.status(400).json({ error: "Enter a valid phone number." });
    }

    if (cleanNotes === null || cleanNotes.length > 300) {
        return response.status(400).json({ error: "Notes must be 300 characters or fewer." });
    }

    if (cleanEmail === null || cleanEmail && !validEmail(cleanEmail)) {
        return response.status(400).json({ error: "Enter a valid email address or leave it blank." });
    }

    if (!["delivery", "pickup"].includes(fulfillment)) {
        return response.status(400).json({ error: "Choose delivery or pickup." });
    }

    if (fulfillment === "delivery" && (!cleanAddress || cleanAddress.length > 240)) {
        return response.status(400).json({ error: "Enter a delivery address of 240 characters or fewer." });
    }

    if (fulfillment === "pickup" && cleanAddress === null) {
        return response.status(400).json({ error: "Delivery address must be text." });
    }

    const requiredPaymentMethod = fulfillment === "delivery" ? "cash_on_delivery" : "cash_on_pickup";
    if (paymentMethod !== undefined && paymentMethod !== requiredPaymentMethod) {
        return response.status(400).json({
            error: fulfillment === "delivery"
                ? "Orders are paid in cash when delivered. Online and POS payments are not available."
                : "Pickup orders are paid in cash at collection."
        });
    }
    const paymentMethodToSave = requiredPaymentMethod;

    if (cleanPromoCode === null || cleanPromoCode.length > 30
        || (cleanPromoCode !== "" && cleanPromoCode !== "FRYDAY10")) {
        return response.status(400).json({ error: "That promo code is not valid." });
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > productById.size) {
        return response.status(400).json({ error: "Add at least one menu item to your order." });
    }

    const quantities = new Map();
    for (const item of items) {
        if (!item || typeof item.productId !== "string" || !Number.isInteger(item.quantity)) {
            return response.status(400).json({ error: "Each item needs a product and quantity." });
        }

        if (!productById.has(item.productId) || item.quantity < 1 || item.quantity > 20) {
            return response.status(400).json({ error: "One or more order items are invalid." });
        }

        quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
    }

    if ([...quantities.values()].some((quantity) => quantity > 20)) {
        return response.status(400).json({ error: "The maximum quantity per menu item is 20." });
    }

    const orderItems = [...quantities].map(([productId, quantity]) => {
        const product = productById.get(productId);
        return {
            ...product,
            quantity,
            lineTotal: product.price * quantity,
            deliveryFee: fulfillment === "delivery" ? product.deliveryFee : 0,
            deliveryTotal: fulfillment === "delivery" ? product.deliveryFee * quantity : 0
        };
    });
    const subtotal = orderItems.reduce((sum, item) => sum + item.lineTotal, 0);
    const deliveryFee = orderItems.reduce((sum, item) => sum + item.deliveryTotal, 0);
    const discount = cleanPromoCode === "FRYDAY10" ? Math.min(Math.floor(subtotal * 0.1), 1500) : 0;
    const total = subtotal + deliveryFee - discount;
    const user = auth.userFromRequest(request);
    const insertOrder = database.prepare(
        `INSERT INTO orders
            (user_id, customer_name, phone, customer_email, notes, address, fulfillment, payment_method, promo_code,
             subtotal, delivery_fee, discount, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertItem = database.prepare(`
        INSERT INTO order_items
            (order_id, product_id, product_name, unit_price, quantity, line_total, delivery_fee, delivery_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    try {
        database.exec("BEGIN IMMEDIATE");
        const result = insertOrder.run(
            user?.id ?? null, cleanName, cleanPhone, user?.email || cleanEmail, cleanNotes,
            fulfillment === "delivery" ? cleanAddress : "",
            fulfillment, paymentMethodToSave, cleanPromoCode, subtotal, deliveryFee, discount, total
        );
        const orderId = Number(result.lastInsertRowid);

        for (const item of orderItems) {
            insertItem.run(
                orderId, item.id, item.name, item.price, item.quantity, item.lineTotal,
                item.deliveryFee, item.deliveryTotal
            );
        }

        database.exec("COMMIT");
        const createdAt = database.prepare("SELECT created_at FROM orders WHERE id = ?").get(orderId).created_at;
        const order = {
            id: orderId,
            customerName: cleanName,
            phone: cleanPhone,
            notes: cleanNotes,
            address: fulfillment === "delivery" ? cleanAddress : "",
            fulfillment,
            paymentMethod: paymentMethodToSave,
            promoCode: cleanPromoCode,
            subtotal,
            deliveryFee,
            discount,
            total,
            status: "pending",
            createdAt,
            items: orderItems
        };

        let notificationSent = false;
        try {
            const notification = await orderNotifier.sendOrderNotification(order);
            notificationSent = notification.sent;
            if (!notificationSent) {
                console.warn(`Order #${orderId} email notification was not sent: ${notification.reason}.`);
            }
        } catch (error) {
            console.error(`Order #${orderId} email notification failed:`, error.message);
        }

        return response.status(201).json({ order, notification: { sent: notificationSent } });
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
});

app.use("/api", (request, response) => {
    response.status(404).json({ error: "API endpoint not found." });
});

app.use((request, response, next) => {
    if (request.path.startsWith("/server/")) {
        return response.sendStatus(404);
    }
    next();
});

app.use(express.static(path.join(rootDirectory, "dist"), { dotfiles: "deny" }));

app.use((request, response, next) => {
    if (request.method !== "GET" || !request.accepts("html")) return next();
    response.sendFile(path.join(rootDirectory, "dist", "index.html"), (error) => {
        if (error) next(error);
    });
});

app.use((error, request, response, next) => {
    if (response.headersSent) {
        return next(error);
    }

    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
        return response.status(400).json({ error: "Request body must be valid JSON." });
    }
    if (error instanceof multer.MulterError) {
        return response.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
            error: error.code === "LIMIT_FILE_SIZE"
                ? "Food photos must be 5 MB or smaller."
                : "Upload one valid food photo."
        });
    }
    if (error.message === "Upload a JPG, PNG, or WebP image.") {
        return response.status(400).json({ error: error.message });
    }

    console.error(error);
    response.status(500).json({ error: "Something went wrong. Please try again." });
});

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    if (orderNotifier.configured) {
        orderNotifier.verify().then(() => {
            console.log(`Order email notifications are connected for ${orderNotifier.recipient}.`);
        }).catch((error) => {
            console.error("Order email SMTP verification failed:", error.message);
        });
    } else {
        console.warn("Order email notifications are not configured. Copy .env.example to .env and add SMTP credentials.");
    }
    app.listen(port, () => {
        console.log(`Fryday is ready at http://localhost:${port}`);
    });
}

module.exports = { app, cloudinary, database, orderNotifier };