# CoinVault — Firebase + Binance live market mobile web app

This project is a mobile-first web app/PWA intended for GitHub Pages. It uses your Firebase project for authentication, Realtime Database, user wallets and requests. Public market prices come from Binance's public market-data API and WebSocket streams.

## Features

- Gmail/password registration and login
- User name + Pakistan mobile number
- Real-time cash balance from Firebase
- Portfolio value changes with live selected-coin price
- Active Binance USDT spot coin list with search
- Interactive candlestick chart with 1m/5m/15m/1h/4h/1d controls, zoom, crosshair and fullscreen
- Randomized package cards using active Binance coins
- First purchase fee waived; later purchases use admin-configured fee
- Server-side price validation before purchases/conversions
- Coin conversion with server-calculated quote and fee
- Add Money request workflow
- Withdrawal request workflow with balance hold; rejection refunds the user
- Referral code tracking and configurable reward
- Admin console for settings, deposits, withdrawals and users
- Free WhatsApp click-to-chat fallback for manual notification
- Optional automatic WhatsApp webhook on the server (requires a compatible provider)

## Important architecture/security

Do NOT put Firebase Admin SDK credentials, a service-account JSON, WhatsApp tokens, or exchange private keys in GitHub. The browser only contains the normal Firebase Web config. Balance-changing operations are Cloud Functions callable endpoints and the RTDB rules make the wallet nodes read-only to users.

For this version, the PKR valuation uses the admin-configured `USDT → PKR` reference rate because Binance's public spot market feed is primarily the exchange market price (for example `BTCUSDT`) rather than a guaranteed PKR cash-out rate.

## Step 1 — Firebase Console

1. In Firebase Authentication, enable **Email/Password**.
2. Make sure Realtime Database is enabled.
3. Replace your existing Realtime Database Rules with `database.rules.json` from this project.
4. Deploy Cloud Functions (steps below).
5. Create your own admin account in Authentication.
6. Copy that account's Firebase Auth UID and add this RTDB node manually:

```json
coinvault
  admins
    YOUR_ADMIN_UID: true
```

The app's admin page checks this server-side. A normal user cannot make themselves an admin.

## Step 2 — Firebase CLI

Install Firebase CLI if you do not have it:

```bash
npm install -g firebase-tools
firebase login
```

Open a terminal inside this project folder and run:

```bash
firebase use own-live-steam-web-default
firebase deploy --only functions,database
```

Cloud Functions may require the Firebase/Google Cloud billing setup supported by your project. The functions use Node.js 22.

## Step 3 — GitHub Pages

Upload these root files to your repository:

- `index.html`
- `admin.html`
- `styles.css`
- `app.js`
- `admin.js`
- `firebase-config.js`
- `manifest.json`
- `sw.js`

You do not need to upload the `functions/` folder for GitHub Pages to serve the UI, but you DO need to deploy the `functions/` folder once using Firebase CLI.

Then enable GitHub Pages for the repository branch/folder you use.

## Step 4 — WhatsApp notification

The app already provides a free `wa.me` button in the admin dashboard. That means when a pending withdrawal appears, you can open WhatsApp with a pre-filled message and tap Send.

For a truly automatic WhatsApp message when the withdrawal request is created and when it is approved/rejected, you need a WhatsApp provider/API and a secure webhook. This project includes a server-only `WHATSAPP_WEBHOOK_URL` hook. Set it as a Cloud Functions environment/secret rather than putting it in GitHub.

## Step 5 — First settings

From `admin.html`, set:

- USDT → PKR reference rate
- Trading fee %
- Minimum/maximum buy amount
- Referral bonus % and cap

Recommended: start with very small test amounts and verify the complete flow before using real money.

## Database shape

```text
coinvault/admins/{uid}
coinvault/publicSettings/{setting}
coinvault/users/{uid}
coinvault/wallets/{uid}
coinvault/moneyRequests/{uid}/{requestId}
coinvault/adminRequests/deposits/{requestId}
coinvault/adminRequests/withdrawals/{requestId}
coinvault/ledger/{uid}/{entryId}
coinvault/referralCodes/{code}
coinvault/processed/{uid}/{operation}/{clientTxnId}
```

## Notes about market data

The frontend reads the active Binance USDT spot market list from:

`https://data-api.binance.vision/api/v3/exchangeInfo`

It reads historical candles from `/api/v3/klines` and the live selected ticker from the public market WebSocket stream. Public market data does not require a Binance API key.

The app does not execute orders on Binance and does not ask users for Binance API keys.

## Before production

- Enable Firebase App Check for the web app.
- Add proper WhatsApp/transaction notification provider credentials only in server-side secrets.
- Add audit logging, rate limiting and stronger identity verification for any real-money launch.
- Have the cash-in/cash-out and crypto-related business model reviewed for the laws, licensing and payment-provider rules that apply to your target users.
