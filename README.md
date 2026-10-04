# Fryday

## Run locally

Requires Node.js 22.13 or newer.

```sh
npm install
npm start
```

Open http://localhost:3000. Use this address instead of the Five Server URL so the storefront and `/api` requests share one origin.

Run the API tests with `npm test`; use `npm run dev` to restart the server when backend files change.

## Order email notifications

1. Copy `.env.example` to `.env` with `Copy-Item .env.example .env` in PowerShell.
2. Set `SMTP_USER` to the Gmail account that will send order alerts, email verification, and password recovery links, and `SMTP_PASS` to that account's Google App Password. Google requires 2-Step Verification before it will issue an App Password. Set `SMTP_FROM` to that same sending account.
3. Keep `ORDER_NOTIFICATION_EMAIL` set to `ayomideguru2365@gmail.com`, then restart the app with `npm start`.
4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` to the admin sign-in credentials. Use a unique password of at least 12 characters. The configured admin account is created or refreshed at startup; keep these credentials in `.env` only. Admin sign-in is unavailable until both values are set.
5. For email/password sign-up and password recovery, set `APP_BASE_URL` to the public site origin (including `https://` in production). New email accounts must verify their address before signing in; sign-up cannot complete unless SMTP is configured and the verification message is sent.
6. For Google sign-in, create an OAuth web client, set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and add `${APP_BASE_URL}/api/auth/google/callback` as an authorized redirect URI. Set `GOOGLE_REDIRECT_URI` only if using a different callback URL.
7. For phone sign-in, configure a Twilio Verify service and set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`. Phone numbers must be entered in international E.164 format (for example, `+2348012345678`).
8. For admin food photo uploads, set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. Admins can then add and remove items from the account menu desk. Images are limited to JPG, PNG, or WebP files up to 5 MB.

The server verifies SMTP at startup and logs whether email delivery is connected. `GET /api/health` reports whether SMTP credentials are configured. Without valid SMTP credentials, orders are still saved, but the server logs that the order email was not sent; email/password registration and recovery links require SMTP. Never put the App Password in source code or commit `.env`.

Customers with an email on their account receive an email when an order status changes. Guest customers can enter an optional email at checkout to receive the same updates; older orders without an email cannot receive status notifications. Status emails use the configured SMTP account.

After an order is saved, the customer sees a receipt dialog with the order details, cash-at-handoff amount, and options to download the receipt as a PDF or print it. The PDF endpoint checks the order number against the phone used at checkout.

## Backend

- `server/index.js` serves the storefront and JSON API.
- `server/auth.js` hashes account passwords and manages opaque, expiring HTTP-only sessions. Users can choose email/password, Google, or verified-phone sign-up and sign-in. Email/password sign-up requires a single-use verification link sent by SMTP; links expire after 24 hours, can be resent, and sign the user in after verification. Existing email accounts stay verified during database migration. Password reset links expire after 30 minutes. Customers can view their linked orders and cancel them only while pending; orders can no longer be cancelled once preparation begins. The configured admin can view all orders and update their status to pending, preparing, shipped, completed, or cancelled.
- `server/menu.js` supplies the initial catalog. The SQLite product catalog is the live source for menu prices and details; admins can upload JPG, PNG, and WebP photos to Cloudinary and add/delete food from the account menu desk. Order totals are calculated from the database-backed server catalog.
- `server/database.js` creates and migrates the SQLite schema. Users, the catalog, orders, and order line-item snapshots persist in `.data/orders.sqlite`.
- `GET /api/health` checks server availability and reports which integrations are configured; `GET /api/menu` returns the current catalog; `POST /api/orders` validates and saves an order; `GET /api/orders/:orderId?phone=...` looks up its status. `POST /api/auth/register` sends an email verification link; `GET /api/auth/email/verify?token=...` consumes it and starts a session; `POST /api/auth/email/verification/resend` resends it. `POST /api/auth/login` and `/api/auth/logout` manage password sessions; `POST /api/auth/password-reset/request` and `/api/auth/password-reset/complete` handle emailed recovery links; `/api/auth/google` starts Google OAuth; `/api/auth/phone/send` and `/api/auth/phone/verify` use Twilio Verify. `GET /api/account/orders` lists the signed-in customer's orders; `POST /api/account/orders/:orderId/cancel` cancels an owned account order, while `POST /api/orders/:orderId/cancel` lets a guest cancel with their checkout phone number. Both cancellation paths are limited to pending orders; customers cannot cancel once preparation begins. `GET /api/admin/orders`, `PATCH /api/admin/orders/:orderId`, `POST /api/admin/menu`, and `DELETE /api/admin/menu/:productId` are admin-only. Customer account order lists refresh every 15 seconds while the account page is open.

The storefront includes product search, sorting and category filters, saved favourites, a browser-persisted cart, delivery or pickup checkout, the `FRYDAY10` promotion, cash-only payment at handoff, and order lookup. Delivery fees are charged per menu item and quantity: The Classic ₦300, Loaded & Lovely ₦450, Pepper Party ₦350, and The Share Box ₦600. These are sample rates in the initial catalog in `server/menu.js`; they are copied to the database on first startup and existing catalog values persist across restarts. To change an existing item, remove it from the admin menu and upload it again with the updated values. Pickup has no delivery fee. `FRYDAY10` takes 10% off food up to ₦1,500. The server recalculates all amounts and validates the promotion.

The order endpoint accepts `customerName`, `phone`, `items` containing `productId` and `quantity`, plus optional `address`, `fulfillment` (`delivery` or `pickup`), `paymentMethod` (`cash_on_delivery` for delivery, `cash_on_pickup` for pickup), `promoCode`, and `notes`. Orders placed while signed in are linked to that account; guest ordering remains available. Admin status changes do not send or modify order email notifications. No online, card, or POS payment is enabled.