// testGoogleOAuthOnly.js
//
// Isolates the OAuth token refresh step (clientId/clientSecret/refreshToken
// only) and prints Google's FULL error body, not just the generic
// "Request failed with status code 401" that testGoogleAdsFlow.js showed.
// Google's real error ("invalid_client", "invalid_grant", etc.) tells us
// exactly which of the three values is wrong.
//
// Usage:
//   node testGoogleOAuthOnly.js

require('dotenv').config();
const axios = require('axios');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return value;
}

const clientId = requireEnv('GOOGLE_ADS_CLIENT_ID');
const clientSecret = requireEnv('GOOGLE_ADS_CLIENT_SECRET');
const refreshToken = requireEnv('GOOGLE_ADS_REFRESH_TOKEN');

console.log('clientId (masked):', clientId.slice(0, 15) + '...' + clientId.slice(-20));
console.log('clientSecret length:', clientSecret.length, '(starts with:', clientSecret.slice(0, 6) + '...)');
console.log('refreshToken length:', refreshToken.length, '(starts with:', refreshToken.slice(0, 8) + '..., ends with:', refreshToken.slice(-8) + ')');
console.log('');

axios.post('https://oauth2.googleapis.com/token', {
  client_id: clientId,
  client_secret: clientSecret,
  refresh_token: refreshToken,
  grant_type: 'refresh_token',
})
  .then((res) => {
    console.log('SUCCESS. Access token obtained (not printed). Expires in:', res.data.expires_in, 'seconds.');
  })
  .catch((err) => {
    console.log('FAILED.');
    console.log('HTTP status:', err.response ? err.response.status : '(no response)');
    console.log('Google error body:', JSON.stringify(err.response ? err.response.data : err.message, null, 2));
  });