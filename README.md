# Attribution System — Setup Guide

A multi-brand marketing attribution backend connecting Shopify, Zenoti, and
AWIN/Meta/Google/Klaviyo. Built as discussed: modular connectors, brand
isolation, event replay, last-touch attribution by default.

**Updated:** database migrated from PostgreSQL to MongoDB, and Shopify
integration now uses a real OAuth flow instead of a manually-copied static
token, since the Dev Dashboard app was created without legacy install flow
support for static tokens working end-to-end.

## What's included

- Full Express + MongoDB (Mongoose) backend
- Collections: brands, customers, visits, appointments, invoices,
  conversions, raw event log
- Identity resolution (email/phone matching), with first-touch/latest-touch
  tracked permanently on each customer record (first-touch is set once and
  never overwritten, per the "always append" requirement)
- Lifetime revenue and first purchase date tracked automatically on each
  customer as invoices close
- Attribution logic (last-touch by default, first-touch supported, configurable per brand)
- Modular connector pattern:
  - **AWIN** — fully implemented (Phase 1)
  - **Meta** — implemented, verify against current CAPI docs before going live
  - **Klaviyo** — fully implemented
  - **Google** — stubbed only; build during Phase 3 against the Data Manager
    API once access is confirmed (flagged earlier as the highest-uncertainty piece)
- Zenoti webhook receiver with raw-event logging (enables replay), now
  including Guest.Merged handling so duplicate profiles consolidate cleanly
- Real Shopify OAuth install flow (`/shopify/install`, `/shopify/callback`) -
  the Admin API token is fetched and stored automatically once a merchant
  approves the app, no manual token copying needed
- Shopify tracking snippet

## 1. Install dependencies

```bash
npm install
```

## 2. Set up your .env

```bash
cp .env.example .env
```

Fill in every value in `.env`. **Never commit this file** - it's already in
`.gitignore`. If you're reading this because `.env` was previously committed
to this repo, treat every credential it contained as compromised and rotate
all of them immediately (Meta token, internal API key, database credentials).

## 3. Create your MongoDB database

Sign up for a free MongoDB Atlas cluster at mongodb.com/atlas (no card
required for the free tier), create a database user, and copy the connection
string into `DATABASE_URL` in `.env`. It looks like:

```
mongodb+srv://username:password@cluster.mongodb.net/attribution_db
```

No separate migration step is needed - Mongoose creates collections
automatically the first time data is written to them.

## 4. Create your first brand

```bash
curl -X POST http://localhost:4000/api/brands \
  -H "x-api-key: YOUR_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Wink Brow Bar","slug":"wink-brow-bar","shopifyStoreUrl":"winkbrow-bar.myshopify.com","zenotiCenterId":"YOUR_CENTER_ID"}'
```

Save the returned brand `_id` - you'll need it for the Shopify snippet and
for attaching platform credentials.

## 5. Attach AWIN credentials to the brand

```bash
curl -X POST http://localhost:4000/api/brands/BRAND_ID/platforms \
  -H "x-api-key: YOUR_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"platform":"awin","credentials":{"advertiserId":"xxx","apiToken":"xxx"}}'
```

## 6. Connect Shopify (real OAuth flow, replaces manual token copying)

This is the piece that unblocks the "no static token available" issue from
the Dev Dashboard.

1. In `.env`, fill in `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` - these come
   from your Shopify app's Settings > Credentials page (Client ID and
   Client Secret - the same values shown as "Client ID" / "Secret" that
   didn't give you a usable static token).
2. Set `APP_URL` to your real, deployed backend URL (not the Netlify
   placeholder - your actual Express server needs to be live and reachable
   for this step, since Shopify calls back into it directly).
3. In your Shopify app's Settings (Dev Dashboard), set:
   - **App URL**: `https://your-real-backend-url.com/shopify/install`
   - **Redirect URLs**: `https://your-real-backend-url.com/shopify/callback`
4. Deploy your backend so it's live.
5. Visit `https://your-real-backend-url.com/shopify/install?shop=winkbrow-bar.myshopify.com`
   in your browser (or click "Install app" again from the Dev Dashboard).
6. Approve the app on the Shopify screen that appears.
7. You'll land on a confirmation page showing your Brand ID - the Admin API
   token has now been automatically saved to that brand's record in MongoDB.
   No manual copying required.

## 7. Register the Zenoti webhook

In your Zenoti account, register this URL for Guest (Created/Updated/Merged),
AppointmentGroup (Created), and Invoice (Closed) events:

```
https://your-backend-url.com/webhooks/zenoti?brandId=BRAND_ID
```

## 8. Add the Shopify tracking snippet

Copy `shopify-snippet/attribution-tracking.liquid` into your theme's
`theme.liquid`, just before `</body>`. Replace the placeholder values at the
top with your actual backend URL, brand ID, and API key.

**Important security note:** this snippet runs in the browser, which means
the API key inside it is technically visible to anyone who views page
source. For a production deployment, it's worth replacing the API-key check
on the `/api/attribution/capture` endpoint specifically with a lighter,
public-safe method (e.g. a per-brand public token that can only write
attribution data, not read anything) - flagged here so it doesn't get missed.

## Run it

```bash
npm start
```

Or for auto-reload during development:

```bash
npm run dev
```

## What each variable in .env means

| Variable | Where to get it |
|---|---|
| `DATABASE_URL` | MongoDB Atlas connection string (free tier available) |
| `INTERNAL_API_KEY` | Any random string you generate yourself (`openssl rand -hex 32`) |
| `ZENOTI_API_KEY` / `ZENOTI_WEBHOOK_SECRET` | Zenoti account settings / API access request |
| `AWIN_ADVERTISER_ID` / `AWIN_API_TOKEN` | AWIN Advertiser API credentials page |
| `META_PIXEL_ID` / `META_CONVERSIONS_API_TOKEN` | Meta Events Manager |
| `GOOGLE_ADS_*` | Google Cloud project + Data Manager API setup (Phase 3) |
| `KLAVIYO_PRIVATE_API_KEY` | Klaviyo account settings |
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Your Shopify app's Settings > Credentials page |
| `APP_URL` | Your real, deployed backend URL |

## What's a stub vs. fully built

- Core engine, database, identity resolution, attribution logic - solid
- Customer lifetime revenue, first purchase date, first/latest touch - now tracked automatically
- AWIN connector - ready to test against a real account
- Meta, Klaviyo connectors - implemented, need testing against live credentials
- Shopify OAuth flow - implemented, needs a live deployed backend to complete end-to-end
- Google connector - intentionally stubbed; build once Data Manager API access is confirmed
- Event replay - now fully wired (raw event saved, replay endpoint reprocesses it through the same handler)
- Linear attribution - not yet implemented, only last-touch/first-touch currently supported
- No dashboard yet - that's Phase 5, separate scope

## Security note on this repo

If `.env` was ever committed to this repository's git history, removing it
in a new commit does not erase it from history - anyone with repo access
could still find it in old commits. If real credentials were exposed:
1. Rotate every credential that was in that file immediately
2. Make the repository private if it isn't already
3. Consider scrubbing git history (e.g. via `git filter-repo`) if the repo
   must stay public long-term
