# License requests, issuance and payments

## Request before installation

Share the public `/request-license` page. Customers select a product and requested plan, enter their name and email, and receive a private status link. No installation or operator account is required. Email is customer-provided and unverified; there is no email sending or payment gateway. The customer must save the link. Anyone holding it can retrieve the issued key, so it must not be shared publicly.

Operators open **Licenses → License requests**, review contact information, and choose **Issue license**. Selecting an existing active plan shows its terms, entitlements and ETB price. Operators may choose a different plan after agreeing it with the customer. The private request page polls status; after issuance the customer clicks **Retrieve license key** and uses the key in the app after installation. A retrieved key still requires normal activation; delivery does not consume a seat.

For existing customers, issuance can instead target a registered installation. The dependent app polls its authenticated notifications and uses the returned `collectPath` to retrieve the key with its installation credential. A manually shared key remains available for service customers. No automatic email is claimed.

## Plans and automatic sales

The catalog calls plan presets **Plans**. Add or edit price and ETB currency alongside duration, activation seats and entitlements. Prices are integer santim in the existing price records; the UI accepts birr with up to two decimal places. Explicit plan prices override the existing product fallback. A missing price blocks issuance; 0 explicitly means complimentary.

Issuance only accepts an existing plan; it cannot override entitlement, expiry or seat configuration. It snapshots plan terms into the license and the plan price/currency into an initial sale. License, sale, optional full payment, request approval and delivery record commit atomically in the existing database. No database reset or destructive schema change is needed. Existing users, licenses, sales, receipts and refunds remain intact. Existing licenses without sales remain distinguishable; they are never presumed paid.

The sale defaults to Unpaid. Check **Already paid** to record the full price received with payment method and transaction reference on today's UTC date. Zero-price sales are Complimentary and do not create a receipt. Changes to default prices never alter historical sales. Payment status never changes signing, validation, seats or expiry.

Every issuance carries a UUID request ID. Exact retries by the same operator return the original license/key and sale. A changed payload or operator returns a conflict. The CLI prints its request ID before sending; reuse `--request-id` on retry. The UI retains its ID while the dialog remains open. Plan revision and price checks prevent issuing against a stale preview.

## Payments and reports

**Sales & payments → Mark as paid** records the outstanding balance against the existing sale, with method, UTC date and transaction reference. It does not create another license or sale. Receipt retries reuse their UUID and do not duplicate cash. Partial receipts, refunds, credits, renewals and historical initial-sale entry remain available in the existing transaction workflows. Backdated entries cannot precede a sale or make historical balances negative.

Financial reports separate sales value, recorded receipts, refunds, credits and outstanding balances. They use the sale date for sales and each entry's own date for cash. ETB is the only supported currency. CSV and Print / Save PDF retain the active product/customer/date scope; CSV amounts are integer santim.

## Delivery status and failures

Available means the key is ready in the dependent app or private status link, not proof that the customer received it. Retrieved means an authenticated key retrieval succeeded. Manual means the operator must share it. Failures appear in license details and the private status page; the customer can retry after the operator fixes the encryption-key configuration. Notifications never contain the raw key. Private links put their credential in a URL fragment and send it only as an Authorization bearer header, not a query parameter. Retain the encryption key ring for later retrieval.

## Navigation and settings

Settings has Account, Preferences, Notifications, admin-only Backups (when enabled), and admin-only System tabs. Old Notifications/Backups URLs redirect there, and the notification bell opens the Notifications tab. The sidebar Reports group contains Reports, Financial Report (admins) and Audit (when enabled). Account places the ReUI avatar uploader above contact fields and retains explicit Save profile, password security and session management.
