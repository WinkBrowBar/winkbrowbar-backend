// setGoogleCredentials.js
//
// Creates (or updates) the MarketingPlatform record Google conversions
// actually get sent from. This is the piece that's missing right now -
// checkGoogleCredentials.js confirmed zero "google" records exist.
//
// Two fields below are still blank / unconfirmed - fill them in before
// running:
//   - developerToken: from Google Ads UI -> Tools & Settings -> API Center
//     (this is separate from the OAuth client id/secret above it)
//   - conversionActionId: must be the NUMERIC Google Ads conversion action
//     ID (Goals -> Conversions -> click the action -> ID is numeric, e.g.
//     876543210), NOT a gtag conversion label like "AW-xxx/nRNYCPvhl0..."
/