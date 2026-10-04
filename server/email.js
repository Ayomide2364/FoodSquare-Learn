const nodemailer = require("nodemailer");

const defaultRecipient = "ayomideguru2365@gmail.com";

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function formatAmount(amount) {
    return `NGN ${new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 }).format(amount)}`;
}

function emailFailureStatus(error, fallback = "send_failed") {
    return error.code === "EAUTH" || error.responseCode === 535
        || error.statusCode === 401 || error.statusCode === 403
        ? "authentication_failed"
        : fallback;
}

function createResendTransporter(apiKey, fetchImpl) {
    async function request(endpoint, options = {}) {
        const response = await fetchImpl(`https://api.resend.com${endpoint}`, {
            ...options,
            headers: {
                Authorization: `Bearer ${apiKey}`,
                ...(options.body ? { "Content-Type": "application/json" } : {}),
                ...options.headers
            },
            signal: AbortSignal.timeout(12000)
        });
        const body = await response.text();
        let result = {};
        if (body) {
            try {
                result = JSON.parse(body);
            } catch {
                throw new Error("Resend returned an invalid response.");
            }
        }
        if (!response.ok) {
            const error = new Error(result.message || `Resend API request failed (HTTP ${response.status}).`);
            error.statusCode = response.status;
            if (response.status === 401 || response.status === 403) error.code = "EAUTH";
            throw error;
        }
        return result;
    }

    return {
        async verify() {
            await request("/domains");
        },
        async sendMail(message) {
            const result = await request("/emails", {
                method: "POST",
                body: JSON.stringify(message)
            });
            if (typeof result.id !== "string" || !result.id) {
                throw new Error("Resend did not return an email ID.");
            }
            return { messageId: result.id };
        }
    };
}

function createOrderNotifier({ env = process.env, transporter: suppliedTransporter, fetchImpl = fetch } = {}) {
    const port = Number(env.SMTP_PORT);
    const password = typeof env.SMTP_PASS === "string" ? env.SMTP_PASS.replace(/\s/g, "") : "";
    const resendApiKey = typeof env.RESEND_API_KEY === "string" ? env.RESEND_API_KEY.trim() : "";
    const resendFrom = typeof env.RESEND_FROM === "string" ? env.RESEND_FROM.trim() : "";
    const resendSelected = Boolean(resendApiKey);
    const fromAddress = resendSelected ? resendFrom : env.SMTP_FROM || env.SMTP_USER;
    const smtpConfigured = Boolean(
        env.SMTP_HOST && env.SMTP_USER && password
        && Number.isInteger(port) && port > 0 && port <= 65535
    );
    const emailConfigured = resendSelected ? Boolean(resendApiKey && resendFrom) : smtpConfigured;
    const transporter = suppliedTransporter || (resendSelected && emailConfigured
        ? createResendTransporter(resendApiKey, fetchImpl)
        : !resendSelected && smtpConfigured
        ? nodemailer.createTransport({
            host: env.SMTP_HOST,
            port,
            secure: env.SMTP_SECURE === "true" || port === 465,
            auth: { user: env.SMTP_USER, pass: password },
            connectionTimeout: 8000,
            greetingTimeout: 8000,
            socketTimeout: 12000
        })
        : null);
    const recipient = env.ORDER_NOTIFICATION_EMAIL || defaultRecipient;
    let connectionStatus = transporter ? "not_verified" : "not_configured";

    return {
        configured: Boolean(transporter),
        recipient,
        get status() {
            return connectionStatus;
        },
        async         verify() {
            if (!transporter) return false;
            try {
                if (typeof transporter.verify === "function") await transporter.verify();
                connectionStatus = "connected";
                return true;
            } catch (error) {
                connectionStatus = emailFailureStatus(error, "connection_failed");
                throw error;
            }
        },
        async sendPasswordReset(email, resetUrl) {
            if (!transporter) return { sent: false, reason: "not_configured" };

            const safeUrl = escapeHtml(resetUrl);
            const info = await transporter.sendMail({
                from: fromAddress,
                to: email,
                subject: "Reset your Fryday password",
                text: `Use this link to reset your Fryday password. It expires in 30 minutes.\n\n${resetUrl}\n\nIf you do not see this email in your inbox, check your spam or junk folder. If you did not request this, you can ignore this email.`,
                html: `
                    <h1>Reset your Fryday password</h1>
                    <p>This link expires in 30 minutes.</p>
                    <p><a href="${safeUrl}">Choose a new password</a></p>
                    <p>If you do not see this email in your inbox, check your spam or junk folder.</p>
                    <p>If you did not request this, you can ignore this email.</p>
                `
            });
            const wasRejected = Array.isArray(info.rejected)
                && info.rejected.some((address) => String(address).toLowerCase() === email.toLowerCase());
            if (wasRejected) return { sent: false, reason: "rejected" };
            return { sent: true, messageId: info.messageId };
        },
        async sendEmailVerification(email, verificationUrl) {
            if (!transporter) return { sent: false, reason: "not_configured" };

            const safeUrl = escapeHtml(verificationUrl);
            const info = await transporter.sendMail({
                from: fromAddress,
                to: email,
                subject: "Verify your Fryday email",
                text: `Verify your Fryday email address using this link. It expires in 24 hours.\n\n${verificationUrl}\n\nIf you did not create this account, you can ignore this email.`,
                html: `
                    <h1>Welcome to Fryday</h1>
                    <p>Verify your email address to finish creating your account.</p>
                    <p>This link expires in 24 hours.</p>
                    <p><a href="${safeUrl}">Verify my email</a></p>
                    <p>If you did not create this account, you can ignore this email.</p>
                `
            });
            return { sent: true, messageId: info.messageId };
        },
        async sendOrderNotification(order) {
            if (!transporter) return { sent: false, reason: "not_configured" };

            const itemLines = order.items.map((item) => {
                const delivery = item.deliveryTotal ? ` + ${formatAmount(item.deliveryTotal)} delivery` : "";
                return `${item.quantity} x ${item.name}: ${formatAmount(item.lineTotal)}${delivery}`;
            });
            const fulfillment = order.fulfillment === "delivery" ? "Delivery" : "Pickup";
            const payment = order.paymentMethod === "cash_on_delivery" ? "Cash on delivery" : "Cash at pickup";
            const text = [
                `New Fryday order #${order.id}`,
                `Customer: ${order.customerName}`,
                `Phone: ${order.phone}`,
                `Fulfillment: ${fulfillment}`,
                order.address ? `Address: ${order.address}` : "",
                `Payment: ${payment}`,
                "",
                ...itemLines,
                "",
                `Subtotal: ${formatAmount(order.subtotal)}`,
                `Delivery fees: ${formatAmount(order.deliveryFee)}`,
                `Discount: ${formatAmount(order.discount)}`,
                `Total: ${formatAmount(order.total)}`,
                order.notes ? `Order note: ${order.notes}` : ""
            ].filter(Boolean).join("\n");
            const itemRows = order.items.map((item) => `
                <tr>
                    <td>${item.quantity} &times; ${escapeHtml(item.name)}</td>
                    <td>${escapeHtml(formatAmount(item.lineTotal))}</td>
                    <td>${escapeHtml(formatAmount(item.deliveryTotal))}</td>
                </tr>
            `).join("");
            const addressRow = order.address
                ? `<p><strong>Address:</strong> ${escapeHtml(order.address)}</p>`
                : "";
            const notesRow = order.notes
                ? `<p><strong>Order note:</strong> ${escapeHtml(order.notes)}</p>`
                : "";

            const info = await transporter.sendMail({
                from: fromAddress,
                to: recipient,
                subject: `New Fryday order #${order.id}`,
                text,
                html: `
                    <h1>New Fryday order #${order.id}</h1>
                    <p><strong>Customer:</strong> ${escapeHtml(order.customerName)}</p>
                    <p><strong>Phone:</strong> ${escapeHtml(order.phone)}</p>
                    <p><strong>Fulfillment:</strong> ${fulfillment}</p>
                    ${addressRow}
                    <p><strong>Payment:</strong> ${payment}</p>
                    ${notesRow}
                    <table border="1" cellpadding="8" cellspacing="0">
                        <thead><tr><th>Item</th><th>Food</th><th>Delivery</th></tr></thead>
                        <tbody>${itemRows}</tbody>
                    </table>
                    <p>Subtotal: ${formatAmount(order.subtotal)}<br>
                    Delivery fees: ${formatAmount(order.deliveryFee)}<br>
                    Discount: ${formatAmount(order.discount)}<br>
                    <strong>Total: ${formatAmount(order.total)}</strong></p>
                `
            }).catch((error) => {
                connectionStatus = emailFailureStatus(error);
                throw error;
            });

            connectionStatus = "connected";
            return { sent: true, messageId: info.messageId };
        },
        async sendOrderStatusNotification(email, order) {
            if (!transporter) return { sent: false, reason: "not_configured" };

            const status = order.status[0].toUpperCase() + order.status.slice(1);
            const info = await transporter.sendMail({
                from: fromAddress,
                to: email,
                subject: `Fryday order #${order.id} update: ${status}`,
                text: `Hi ${order.customerName},\n\nYour Fryday order #${order.id} is now ${order.status}.\n\nThank you for ordering with Fryday.`,
                html: `
                    <h1>Your order status has changed</h1>
                    <p>Hi ${escapeHtml(order.customerName)},</p>
                    <p>Your Fryday order <strong>#${order.id}</strong> is now <strong>${escapeHtml(status)}</strong>.</p>
                    <p>Thank you for ordering with Fryday.</p>
                `
            }).catch((error) => {
                connectionStatus = emailFailureStatus(error);
                throw error;
            });

            connectionStatus = "connected";
            return { sent: true, messageId: info.messageId };
        }
    };
}

module.exports = { createOrderNotifier, defaultRecipient };