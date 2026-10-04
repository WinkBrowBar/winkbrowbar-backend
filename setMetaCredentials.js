// setMetaCredentials.js
//
// Creates (or updates) the MarketingPlatform record Meta conversions get
// sent from. checkPlatformCredentials.js showed the current "meta" record
// has placeholder values (pixelId/accessToken = "<ful...rds>", adAccountId
// = "act_...XXXX") - never actually filled in with real credentials.
//
// Reads pixelId/accessToken straight from .env (META_PIXEL_ID,
// META_CONVERSIONS_API_TOKEN) - same as every other connector's static
// credentials already work. adAccountId is NOT in .env and is optional:
// it's only used by fetchSpend() (ad-spend reporting), not by send()
// (actually sending conversions), so this can run without it. Add it
// later - Ads Manager, top-left account dropdown - and re-run this script
// to fill it in.
//
// Usage:
//   node setMetaCredentials.js <BRAND_ID>

