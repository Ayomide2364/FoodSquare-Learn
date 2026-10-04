const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { createOrderNotifier } = require("../server/email");
const { hashToken } = require("../server/auth");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "fryday-orders-"));
process.env.DATABASE_PATH = path.join(temporaryDirectory, "orders.sqlite");
process.env.SMTP_HOST = "";
process.env.SMTP_PORT = "";
process.env.SMTP_USER = "";
process.env.SMTP_PASS = "";
process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_PASSWORD = "test-admin-password-123";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
process.env.GOOGLE_REDIRECT_URI = "";
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "test-twilio-token";
process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-cloudinary-key";
process.env.CLOUDINARY_API_SECRET = "test-cloudinary-secret";

const { app, cloudinary, database, orderNotifier } = require("../server");
let server;
let baseUrl;
const verificationMessages = [];
orderNotifier.configured = true;
orderNotifier.sendEmailVerification = async (email, url) => {
    verificationMessages.push({ email, url });
    return { sent: true, messageId: "test-verification-message" };
};

before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    process.env.APP_BASE_URL = baseUrl;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function registerAndVerify({ name, email, password }) {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password })
    });
    const result = await response.json();
    assert.equal(response.status, 202);
    const message = verificationMessages.filter((entry) => entry.email === email.trim().toLowerCase()).at(-1);
    assert.ok(message, "verification email should be sent");
    const verified = await fetch(message.url, { redirect: "manual" });
    assert.equal(verified.status, 302);
    assert.equal(verified.headers.get("location"), "/?emailVerification=success");
    const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("fryday_session=")).split(";")[0];
    const authenticated = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    return { response, result, user: (await authenticated.json()).user, cookie, verificationUrl: message.url };
}

test("menu endpoint returns server-owned products and prices", async () => {
    const response = await fetch(`${baseUrl}/api/menu`);
    const products = await response.json();

    assert.equal(response.status, 200);
    assert.equal(products.length, 4);
    assert.deepEqual(products[0], {
        id: "classic",
        name: "The Classic",
        price: 1800,
        deliveryFee: 300,
        description: "Golden, crispy fries finished with a simple, savoury seasoning. A forever favourite.",
        contents: ["Golden-cut fries", "House salt seasoning"],
        imageUrl: "https://images.unsplash.com/photo-1573080496219-bb080dd4f877?auto=format&fit=crop&w=700&q=90",
        category: "classic",
        tag: "THE OG"
    });
});

test("order endpoint rejects invalid customer details and products", async () => {
    const response = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName: "A", phone: "not-a-phone", items: [] })
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /name/i);
});

test("order endpoint ignores client prices and stores order items", async () => {
    const response = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerName: "Ada Student",
            phone: "+234 801 234 5678",
            notes: "No pepper",
            items: [
                { productId: "classic", quantity: 2, price: 1 },
                { productId: "loaded-lovely", quantity: 1, price: 1 }
            ]
        })
    });
    const { order } = await response.json();

    assert.equal(response.status, 201);
    assert.equal(order.total, 6600);
    assert.equal(order.items[0].price, 1800);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 2);

    const wrongPhoneCancellation = await fetch(`${baseUrl}/api/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "+234 801 000 0000" })
    });
    assert.equal(wrongPhoneCancellation.status, 404);

    const cancellation = await fetch(`${baseUrl}/api/orders/${order.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: order.phone })
    });
    assert.equal(cancellation.status, 200);
    assert.equal((await cancellation.json()).order.status, "cancelled");

    const cancelledLookup = await fetch(`${baseUrl}/api/orders/${order.id}?phone=${encodeURIComponent(order.phone)}`);
    assert.equal((await cancelledLookup.json()).order.status, "cancelled");
});

test("delivery orders validate checkout details and calculate server-side totals", async () => {
    const response = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerName: "Ada Student",
            phone: "+234 801 234 5678",
            address: "LASU main gate, Ojo",
            fulfillment: "delivery",
            paymentMethod: "cash_on_delivery",
            promoCode: "fryday10",
            items: [{ productId: "classic", quantity: 1 }]
        })
    });
    const { order } = await response.json();

    assert.equal(response.status, 201);
    assert.equal(order.subtotal, 1800);
    assert.equal(order.deliveryFee, 300);
    assert.equal(order.discount, 180);
    assert.equal(order.total, 1920);
    assert.equal(order.fulfillment, "delivery");
    assert.equal(order.paymentMethod, "cash_on_delivery");
    assert.equal(order.items[0].deliveryFee, 300);
    assert.equal(order.items[0].deliveryTotal, 300);

    const lookup = await fetch(`${baseUrl}/api/orders/${order.id}?phone=${encodeURIComponent(order.phone)}`);
    const result = await lookup.json();
    assert.equal(lookup.status, 200);
    assert.equal(result.order.id, order.id);
    assert.equal(result.order.items[0].name, "The Classic");
    assert.equal(result.order.paymentMethod, "cash_on_delivery");
    assert.equal(result.order.deliveryFee, 300);

    const wrongPhone = await fetch(`${baseUrl}/api/orders/${order.id}?phone=%2B234%20801%20000%200000`);
    assert.equal(wrongPhone.status, 404);
});

test("order endpoint rejects invalid delivery addresses and promo codes", async () => {
    const payload = {
        customerName: "Ada Student",
        phone: "+234 801 234 5678",
        fulfillment: "delivery",
        items: [{ productId: "classic", quantity: 1 }]
    };
    const missingAddress = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    assert.equal(missingAddress.status, 400);
    assert.match((await missingAddress.json()).error, /address/i);

    const invalidPromo = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, address: "LASU", promoCode: "NOTREAL" })
    });
    assert.equal(invalidPromo.status, 400);
    assert.match((await invalidPromo.json()).error, /promo/i);
});

test("delivery charges are calculated per food and quantity; POS is rejected", async () => {
    const response = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerName: "Ada Student",
            phone: "+234 801 234 5678",
            address: "LASU main gate, Ojo",
            fulfillment: "delivery",
            paymentMethod: "cash_on_delivery",
            items: [
                { productId: "classic", quantity: 2 },
                { productId: "loaded-lovely", quantity: 1 }
            ]
        })
    });
    const { order } = await response.json();

    assert.equal(response.status, 201);
    assert.equal(order.subtotal, 6600);
    assert.equal(order.deliveryFee, 1050);
    assert.equal(order.items[0].deliveryTotal, 600);
    assert.equal(order.items[1].deliveryTotal, 450);
    assert.equal(order.total, 7650);

    const posResponse = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerName: "Ada Student",
            phone: "+234 801 234 5678",
            address: "LASU main gate, Ojo",
            fulfillment: "delivery",
            paymentMethod: "pos",
            items: [{ productId: "classic", quantity: 1 }]
        })
    });
    assert.equal(posResponse.status, 400);
    assert.match((await posResponse.json()).error, /cash when delivered/i);
});

test("receipt PDF is downloadable only with the order phone number", async () => {
    const orderResponse = await fetch(`${baseUrl}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerName: "Receipt Customer",
            phone: "+234 801 234 5678",
            address: "LASU main gate, Ojo",
            fulfillment: "delivery",
            paymentMethod: "cash_on_delivery",
            items: [{ productId: "classic", quantity: 1 }]
        })
    });
    const { order } = await orderResponse.json();
    assert.ok(order.createdAt);

    const receiptResponse = await fetch(`${baseUrl}/api/orders/${order.id}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: order.phone })
    });
    assert.equal(receiptResponse.status, 200);
    assert.match(receiptResponse.headers.get("content-type"), /application\/pdf/);
    const pdf = Buffer.from(await receiptResponse.arrayBuffer());
    assert.match(pdf.toString("latin1", 0, 5), /^%PDF-/);

    const wrongPhoneResponse = await fetch(`${baseUrl}/api/orders/${order.id}/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "+234 801 000 0000" })
    });
    assert.equal(wrongPhoneResponse.status, 404);
});

test("order email is sent to the configured inbox with escaped order details", async () => {
    const sentMessages = [];
    const notifier = createOrderNotifier({
        env: {
            ORDER_NOTIFICATION_EMAIL: "ayomideguru2365@gmail.com",
            SMTP_FROM: "Fryday Orders <orders@example.com>"
        },
        transporter: {
            verify: async () => true,
            sendMail: async (message) => {
                sentMessages.push(message);
                return { messageId: "test-message-id" };
            }
        }
    });
    const result = await notifier.sendOrderNotification({
        id: 42,
        customerName: "Test <Customer>",
        phone: "+234 801 234 5678",
        address: "LASU main gate",
        fulfillment: "delivery",
        paymentMethod: "cash_on_delivery",
        notes: "No pepper",
        subtotal: 3600,
        deliveryFee: 600,
        discount: 0,
        total: 4200,
        items: [{ name: "The Classic", quantity: 2, lineTotal: 3600, deliveryTotal: 600 }]
    });

    assert.equal(result.sent, true);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].to, "ayomideguru2365@gmail.com");
    assert.equal(sentMessages[0].subject, "New Fryday order #42");
    assert.match(sentMessages[0].text, /NGN 4,200/);
    assert.match(sentMessages[0].html, /Test &lt;Customer&gt;/);
});

test("order status email is sent to the customer with escaped details", async () => {
    const sentMessages = [];
    const notifier = createOrderNotifier({
        env: { SMTP_FROM: "Fryday <orders@example.com>" },
        transporter: {
            verify: async () => true,
            sendMail: async (message) => {
                sentMessages.push(message);
                return { messageId: "test-status-message-id" };
            }
        }
    });
    const result = await notifier.sendOrderStatusNotification("customer@example.test", {
        id: 42,
        customerName: "Test <Customer>",
        status: "preparing"
    });

    assert.deepEqual(result, { sent: true, messageId: "test-status-message-id" });
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].to, "customer@example.test");
    assert.equal(sentMessages[0].subject, "Fryday order #42 update: Preparing");
    assert.match(sentMessages[0].text, /order #42 is now preparing/);
    assert.match(sentMessages[0].html, /Test &lt;Customer&gt;/);
});

test("email notifier reports missing SMTP credentials instead of claiming delivery", async () => {
    const notifier = createOrderNotifier({ env: {} });

    assert.equal(notifier.configured, false);
    assert.equal(await notifier.verify(), false);
    assert.deepEqual(await notifier.sendOrderNotification({ id: 1, items: [] }), {
        sent: false,
        reason: "not_configured"
    });
    assert.deepEqual(await notifier.sendOrderStatusNotification("customer@example.test", {
        id: 1,
        customerName: "Customer",
        status: "shipped"
    }), { sent: false, reason: "not_configured" });
});

test("password reset mail contains a bounded-use link", async () => {
    const messages = [];
    const notifier = createOrderNotifier({
        env: { SMTP_USER: "sender@example.test", SMTP_FROM: "Fryday <sender@example.test>" },
        transporter: {
            async sendMail(message) {
                messages.push(message);
                return { messageId: "reset-message" };
            }
        }
    });
    const result = await notifier.sendPasswordReset(
        "customer@example.test",
        "https://food.example.test/?resetToken=token&source=email"
    );

    assert.equal(result.sent, true);
    assert.equal(messages[0].to, "customer@example.test");
    assert.match(messages[0].text, /expires in 30 minutes/i);
    assert.match(messages[0].text, /spam or junk folder/i);
    assert.match(messages[0].html, /spam or junk folder/i);
    assert.match(messages[0].html, /&amp;source=email/);
});

test("password reset mail reports a rejected recipient as not sent", async () => {
    const notifier = createOrderNotifier({
        env: { SMTP_USER: "sender@example.test" },
        transporter: {
            async sendMail() {
                return { rejected: ["customer@example.test"] };
            }
        }
    });
    const result = await notifier.sendPasswordReset(
        "customer@example.test",
        "https://food.example.test/?resetToken=token"
    );

    assert.deepEqual(result, { sent: false, reason: "rejected" });
});

test("email signup sends a working single-use verification link", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "Verify Customer",
            email: "verify-customer@example.test",
            password: "verify-customer-password"
        })
    });
    const pending = await response.json();
    assert.equal(response.status, 202);
    assert.equal(pending.verificationRequired, true);
    assert.equal(pending.email, "verify-customer@example.test");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(database.prepare("SELECT email_verified_at FROM users WHERE email = ?")
        .get(pending.email).email_verified_at, null);

    const blockedLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pending.email, password: "verify-customer-password" })
    });
    assert.equal(blockedLogin.status, 403);

    const firstEmail = verificationMessages.filter((message) => message.email === pending.email).at(-1);
    const oldToken = new URL(firstEmail.url).searchParams.get("token");
    const tokenRecord = database.prepare("SELECT expires_at FROM email_verification_tokens WHERE token_hash = ?")
        .get(hashToken(oldToken));
    const expiresInMs = Date.parse(tokenRecord.expires_at) - Date.now();
    assert.ok(expiresInMs > 23 * 60 * 60 * 1000 && expiresInMs <= 24 * 60 * 60 * 1000);
    const resend = await fetch(`${baseUrl}/api/auth/email/verification/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pending.email })
    });
    assert.equal(resend.status, 200);
    const latestEmail = verificationMessages.filter((message) => message.email === pending.email).at(-1);
    const latestToken = new URL(latestEmail.url).searchParams.get("token");
    assert.notEqual(latestToken, oldToken);

    const obsoleteLink = await fetch(firstEmail.url, { redirect: "manual" });
    assert.equal(obsoleteLink.headers.get("location"), "/?emailVerification=invalid");
    const verified = await fetch(latestEmail.url, { redirect: "manual" });
    assert.equal(verified.headers.get("location"), "/?emailVerification=success");
    assert.equal(verified.status, 302);
    const cookie = verified.headers.getSetCookie().find((value) => value.startsWith("fryday_session=")).split(";")[0];
    const identity = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } });
    assert.equal((await identity.json()).user.email, pending.email);
    assert.ok(database.prepare("SELECT email_verified_at FROM users WHERE email = ?")
        .get(pending.email).email_verified_at);

    const replay = await fetch(latestEmail.url, { redirect: "manual" });
    assert.equal(replay.headers.get("location"), "/?emailVerification=invalid");
    const verifiedLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: pending.email, password: "verify-customer-password" })
    });
    assert.equal(verifiedLogin.status, 200);
});

test("expired email verification links cannot activate an account", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "Expired Customer",
            email: "expired-customer@example.test",
            password: "expired-customer-password"
        })
    });
    assert.equal(response.status, 202);
    const email = verificationMessages.filter((message) => message.email === "expired-customer@example.test").at(-1);
    const token = new URL(email.url).searchParams.get("token");
    database.prepare("UPDATE email_verification_tokens SET expires_at = ? WHERE token_hash = ?")
        .run(new Date(Date.now() - 1000).toISOString(), hashToken(token));

    const expiredLink = await fetch(email.url, { redirect: "manual" });
    assert.equal(expiredLink.headers.get("location"), "/?emailVerification=invalid");
    assert.equal(database.prepare("SELECT email_verified_at FROM users WHERE email = ?")
        .get("expired-customer@example.test").email_verified_at, null);
});

test("password reset links are one-use and revoke existing sessions", async () => {
    const registered = await registerAndVerify({
        name: "Reset Customer",
        email: "reset-customer@example.test",
        password: "before-reset-password"
    });
    const oldCookie = registered.cookie;

    const resetRequest = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reset-customer@example.test" })
    });
    const genericMessage = await resetRequest.json();
    assert.equal(resetRequest.status, 200);
    assert.match(genericMessage.message, /if an account/i);

    const token = Buffer.from("single-use-reset-token").toString("base64url").padEnd(43, "a").slice(0, 43);
    database.prepare(`
        INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)
    `).run(hashToken(token), registered.user.id, new Date(Date.now() + 60_000).toISOString());
    const completion = await fetch(`${baseUrl}/api/auth/password-reset/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: "after-reset-password" })
    });
    assert.equal(completion.status, 200);

    const oldSession = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: oldCookie } });
    assert.equal((await oldSession.json()).user, null);
    const reusedToken = await fetch(`${baseUrl}/api/auth/password-reset/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: "another-reset-password" })
    });
    assert.equal(reusedToken.status, 400);

    const oldPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reset-customer@example.test", password: "before-reset-password" })
    });
    assert.equal(oldPasswordLogin.status, 401);
    const newPasswordLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "reset-customer@example.test", password: "after-reset-password" })
    });
    assert.equal(newPasswordLogin.status, 200);
});

test("phone verification creates phone-only accounts and signs them in", async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        if (String(url).includes("/VerificationCheck")) {
            assert.match(String(url), /\/Services\/VAtest\/VerificationCheck$/);
            assert.match(options.headers.Authorization, /^Basic /);
            const form = new URLSearchParams(options.body);
            return new Response(JSON.stringify({
                status: form.get("Code") === "0000" ? "pending" : "approved"
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (String(url).includes("/Verifications")) {
            assert.match(String(url), /\/Services\/VAtest\/Verifications$/);
            assert.match(options.headers.Authorization, /^Basic /);
            const form = new URLSearchParams(options.body);
            assert.equal(form.get("To"), "+2348012345678");
            assert.equal(form.get("Channel"), "sms");
            return new Response(JSON.stringify({ status: "pending" }), {
                status: 201,
                headers: { "Content-Type": "application/json" }
            });
        }
        return originalFetch(url, options);
    };
    try {
        const phone = "+2348012345678";
        const sendCode = await fetch(`${baseUrl}/api/auth/phone/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone, name: "Phone Customer", createAccount: true })
        });
        assert.equal(sendCode.status, 200);

        const invalidCode = await fetch(`${baseUrl}/api/auth/phone/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Phone Customer", phone, code: "0000", createAccount: true })
        });
        assert.equal(invalidCode.status, 401);

        const verification = await fetch(`${baseUrl}/api/auth/phone/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Phone Customer", phone, code: "123456", createAccount: true })
        });
        const result = await verification.json();
        assert.equal(verification.status, 200);
        assert.equal(result.user.phone, phone);
        assert.equal(result.user.email, null);
        assert.equal(result.user.role, "customer");
        assert.match(verification.headers.get("set-cookie"), /HttpOnly/);

        const returningVerification = await fetch(`${baseUrl}/api/auth/phone/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "Phone Customer", phone, code: "123456" })
        });
        assert.equal(returningVerification.status, 200);
        assert.equal((await returningVerification.json()).user.id, result.user.id);
    } finally {
        global.fetch = originalFetch;
    }
});

test("Google OAuth uses a one-time state and links a verified email account", async () => {
    const registered = await registerAndVerify({
        name: "Google Link Customer",
        email: "google-link@example.test",
        password: "google-link-password"
    });
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        if (String(url) === "https://oauth2.googleapis.com/token") {
            return new Response(JSON.stringify({ access_token: "test-access-token" }), {
                status: 200,
                headers: { "Content-Type": "application/json" }
            });
        }
        if (String(url) === "https://www.googleapis.com/oauth2/v3/userinfo") {
            return new Response(JSON.stringify({
                sub: "google-user-subject-123",
                name: "Google Link Customer",
                email: "google-link@example.test",
                email_verified: true
            }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return originalFetch(url, options);
    };
    try {
        const start = await fetch(`${baseUrl}/api/auth/google`, { redirect: "manual" });
        assert.equal(start.status, 302);
        const authorizationUrl = new URL(start.headers.get("location"));
        const state = authorizationUrl.searchParams.get("state");
        const stateCookie = start.headers.get("set-cookie").split(";")[0];
        assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");

        const callback = await fetch(
            `${baseUrl}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
            { headers: { Cookie: stateCookie }, redirect: "manual" }
        );
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.get("location"), "/?auth=google");
        const responseCookies = callback.headers.getSetCookie();
        const sessionCookie = responseCookies.find((cookie) => cookie.startsWith("fryday_session=")).split(";")[0];
        const authenticated = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: sessionCookie } });
        const { user } = await authenticated.json();
        assert.equal(user.id, registered.user.id);
        assert.equal(user.email, "google-link@example.test");
        assert.equal(database.prepare("SELECT google_sub FROM users WHERE id = ?").get(user.id).google_sub,
            "google-user-subject-123");

        const replay = await fetch(
            `${baseUrl}/api/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`,
            { headers: { Cookie: stateCookie }, redirect: "manual" }
        );
        assert.equal(replay.headers.get("location"), "/?authError=google");
    } finally {
        global.fetch = originalFetch;
    }
});

test("customers receive status emails for account orders while admins update them", async () => {
    const registration = await registerAndVerify({
        name: "Account Customer",
        email: "  customer@example.test ",
        password: "customer-password-123"
    });
    const customerCookie = registration.cookie;
    assert.equal(registration.response.status, 202);
    assert.equal(registration.result.email, "customer@example.test");
    assert.equal(registration.user.role, "customer");
    assert.equal("password" in registration.user, false);
    assert.match(registration.cookie, /^fryday_session=/);

    const duplicateResponse = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Again", email: "customer@example.test", password: "customer-password-123" })
    });
    assert.equal(duplicateResponse.status, 409);

    const originalNotifier = orderNotifier.sendOrderNotification;
    const originalStatusNotifier = orderNotifier.sendOrderStatusNotification;
    let notificationCalls = 0;
    const statusNotifications = [];
    orderNotifier.sendOrderNotification = async (...args) => {
        notificationCalls += 1;
        return originalNotifier(...args);
    };
    orderNotifier.sendOrderStatusNotification = async (...args) => {
        statusNotifications.push(args);
        return { sent: true };
    };
    try {
        const orderResponse = await fetch(`${baseUrl}/api/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: customerCookie },
            body: JSON.stringify({
                customerName: "Account Customer",
                phone: "+234 801 234 5678",
                items: [{ productId: "classic", quantity: 1 }]
            })
        });
        const { order } = await orderResponse.json();
        assert.equal(orderResponse.status, 201);
        assert.equal(notificationCalls, 1);

        const historyResponse = await fetch(`${baseUrl}/api/account/orders`, {
            headers: { Cookie: customerCookie }
        });
        const history = await historyResponse.json();
        assert.equal(historyResponse.status, 200);
        assert.equal(history.orders.length, 1);
        assert.equal(history.orders[0].id, order.id);

        const anonymousHistory = await fetch(`${baseUrl}/api/account/orders`);
        assert.equal(anonymousHistory.status, 401);
        const anonymousCancellation = await fetch(`${baseUrl}/api/account/orders/${order.id}/cancel`, {
            method: "POST"
        });
        assert.equal(anonymousCancellation.status, 401);

        const otherCustomer = await registerAndVerify({
            name: "Other Customer",
            email: "other-customer@example.test",
            password: "other-customer-password-123"
        });
        const otherCustomerCancellation = await fetch(`${baseUrl}/api/account/orders/${order.id}/cancel`, {
            method: "POST",
            headers: { Cookie: otherCustomer.cookie }
        });
        assert.equal(otherCustomerCancellation.status, 404);

        const deniedAdminList = await fetch(`${baseUrl}/api/admin/orders`, {
            headers: { Cookie: customerCookie }
        });
        assert.equal(deniedAdminList.status, 403);

        const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: process.env.ADMIN_EMAIL.toUpperCase(), password: process.env.ADMIN_PASSWORD })
        });
        const adminResult = await adminLogin.json();
        const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
        assert.equal(adminLogin.status, 200);
        assert.equal(adminResult.user.role, "admin");

        const preparingResponse = await fetch(`${baseUrl}/api/admin/orders/${order.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "preparing" })
        });
        assert.equal(preparingResponse.status, 200);
        assert.deepEqual(statusNotifications.at(-1), ["customer@example.test", {
            id: order.id,
            customerName: "Account Customer",
            status: "preparing"
        }]);
        const statusNotificationCount = statusNotifications.length;
        const unchangedStatusResponse = await fetch(`${baseUrl}/api/admin/orders/${order.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "preparing" })
        });
        assert.equal(unchangedStatusResponse.status, 200);
        assert.equal(statusNotifications.length, statusNotificationCount);
        const preparingHistory = await fetch(`${baseUrl}/api/account/orders`, {
            headers: { Cookie: customerCookie }
        });
        assert.equal((await preparingHistory.json()).orders[0].status, "preparing");

        const customerCancellation = await fetch(`${baseUrl}/api/account/orders/${order.id}/cancel`, {
            method: "POST",
            headers: { Cookie: customerCookie }
        });
        assert.equal(customerCancellation.status, 409);
        assert.match((await customerCancellation.json()).error, /already being prepared/i);
        assert.equal(statusNotifications.length, statusNotificationCount);

        const pendingResponse = await fetch(`${baseUrl}/api/admin/orders/${order.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "pending" })
        });
        assert.equal(pendingResponse.status, 200);

        const pendingHistory = await fetch(`${baseUrl}/api/account/orders`, {
            headers: { Cookie: customerCookie }
        });
        assert.equal((await pendingHistory.json()).orders[0].status, "pending");

        const pendingCancellation = await fetch(`${baseUrl}/api/account/orders/${order.id}/cancel`, {
            method: "POST",
            headers: { Cookie: customerCookie }
        });
        assert.equal(pendingCancellation.status, 200);
        assert.equal((await pendingCancellation.json()).order.status, "cancelled");
        assert.equal(statusNotifications.at(-1)[1].status, "cancelled");

        const immutableCustomerCancelledOrder = await fetch(`${baseUrl}/api/admin/orders/${order.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "completed" })
        });
        assert.equal(immutableCustomerCancelledOrder.status, 409);

        const shippedOrderResponse = await fetch(`${baseUrl}/api/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: customerCookie },
            body: JSON.stringify({
                customerName: "Account Customer",
                phone: "+234 801 234 5678",
                items: [{ productId: "classic", quantity: 1 }]
            })
        });
        const { order: shippedOrder } = await shippedOrderResponse.json();
        assert.equal(shippedOrderResponse.status, 201);

        const adminOrders = await fetch(`${baseUrl}/api/admin/orders`, {
            headers: { Cookie: adminCookie }
        });
        const adminOrderResult = await adminOrders.json();
        assert.ok(adminOrderResult.orders.some((adminOrder) => adminOrder.id === shippedOrder.id));

        const shippedResponse = await fetch(`${baseUrl}/api/admin/orders/${shippedOrder.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "shipped" })
        });
        assert.equal(shippedResponse.status, 200);
        assert.equal((await shippedResponse.json()).order.status, "shipped");
        assert.equal(statusNotifications.at(-1)[1].status, "shipped");

        const shippedCustomerCancellation = await fetch(`${baseUrl}/api/account/orders/${shippedOrder.id}/cancel`, {
            method: "POST",
            headers: { Cookie: customerCookie }
        });
        assert.equal(shippedCustomerCancellation.status, 409);

        const completedResponse = await fetch(`${baseUrl}/api/admin/orders/${shippedOrder.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "completed" })
        });
        assert.equal(completedResponse.status, 200);
        assert.equal((await completedResponse.json()).order.status, "completed");
        assert.equal(statusNotifications.at(-1)[1].status, "completed");
        assert.equal(notificationCalls, 2);

        const cancelledResponse = await fetch(`${baseUrl}/api/admin/orders/${shippedOrder.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "cancelled" })
        });
        assert.equal(cancelledResponse.status, 200);
        assert.equal(notificationCalls, 2);
        assert.equal(statusNotifications.at(-1)[1].status, "cancelled");

        const immutableCancelledOrder = await fetch(`${baseUrl}/api/admin/orders/${shippedOrder.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "completed" })
        });
        assert.equal(immutableCancelledOrder.status, 409);

        const refreshedHistory = await fetch(`${baseUrl}/api/account/orders`, {
            headers: { Cookie: customerCookie }
        });
        const refreshedOrders = (await refreshedHistory.json()).orders;
        assert.equal(refreshedOrders.find((accountOrder) => accountOrder.id === order.id).status, "cancelled");
        assert.equal(refreshedOrders.find((accountOrder) => accountOrder.id === shippedOrder.id).status, "cancelled");

        const guestOrderResponse = await fetch(`${baseUrl}/api/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customerName: "Guest Customer",
                phone: "+234 801 234 5678",
                email: "guest@example.test",
                items: [{ productId: "classic", quantity: 1 }]
            })
        });
        const { order: guestOrder } = await guestOrderResponse.json();
        assert.equal(guestOrderResponse.status, 201);
        const guestStatusResponse = await fetch(`${baseUrl}/api/admin/orders/${guestOrder.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: adminCookie },
            body: JSON.stringify({ status: "preparing" })
        });
        assert.equal(guestStatusResponse.status, 200);
        assert.deepEqual(statusNotifications.at(-1), ["guest@example.test", {
            id: guestOrder.id,
            customerName: "Guest Customer",
            status: "preparing"
        }]);
        const guestPreparingCancellation = await fetch(`${baseUrl}/api/orders/${guestOrder.id}/cancel`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ phone: guestOrder.phone })
        });
        assert.equal(guestPreparingCancellation.status, 409);
        assert.match((await guestPreparingCancellation.json()).error, /already being prepared/i);
    } finally {
        orderNotifier.sendOrderNotification = originalNotifier;
        orderNotifier.sendOrderStatusNotification = originalStatusNotifier;
    }
});

test("admins can upload and delete catalog items without changing order snapshots", async () => {
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })
    });
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
    const deniedUpload = await fetch(`${baseUrl}/api/admin/menu`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
    });
    assert.equal(deniedUpload.status, 401);

    const originalUploadStream = cloudinary.uploader.upload_stream;
    const originalDestroy = cloudinary.uploader.destroy;
    let deletedPhotoId = "";
    cloudinary.uploader.upload_stream = (options, callback) => ({
        end() {
            callback(null, {
                secure_url: "https://res.cloudinary.com/test-cloud/image/upload/fryday/menu/test-food.png",
                public_id: "fryday/menu/test-food"
            });
        }
    });
    cloudinary.uploader.destroy = async (publicId) => {
        deletedPhotoId = publicId;
        return { result: "ok" };
    };
    try {
        const form = new FormData();
        form.set("name", "Test Special");
        form.set("price", "1234");
        form.set("deliveryFee", "200");
        form.set("description", "A test-only addition to the menu.");
        form.set("contents", "Fries, house sauce");
        form.set("category", "loaded");
        form.set("tag", "TEST SPECIAL");
        form.set("image", new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], {
            type: "image/png"
        }), "test-special.png");
        const upload = await fetch(`${baseUrl}/api/admin/menu`, {
            method: "POST",
            headers: { Cookie: adminCookie },
            body: form
        });
        const created = await upload.json();
        assert.equal(upload.status, 201);
        assert.equal(created.product.name, "Test Special");
        assert.equal(created.product.name, "Test Special");

        const orderResponse = await fetch(`${baseUrl}/api/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customerName: "Menu Snapshot Customer",
                phone: "+2348012345678",
                items: [{ productId: created.product.id, quantity: 1 }]
            })
        });
        const { order } = await orderResponse.json();
        assert.equal(orderResponse.status, 201);
        assert.equal(order.total, 1234);

        const deletion = await fetch(`${baseUrl}/api/admin/menu/${created.product.id}`, {
            method: "DELETE",
            headers: { Cookie: adminCookie }
        });
        assert.equal(deletion.status, 200);
        assert.equal(deletedPhotoId, "fryday/menu/test-food");
        const menuResponse = await fetch(`${baseUrl}/api/menu`);
        const products = await menuResponse.json();
        assert.equal(products.some((product) => product.id === created.product.id), false);
        assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE order_id = ?")
            .get(order.id).count, 1);
    } finally {
        cloudinary.uploader.upload_stream = originalUploadStream;
        cloudinary.uploader.destroy = originalDestroy;
    }
});