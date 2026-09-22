const awinConnector = require('./awinConnector');
const metaConnector = require('./metaConnector');
const googleConnector = require('./googleConnector');
const klaviyoConnector = require('./klaviyoConnector');

const registry = {
  awin: awinConnector,
  meta: metaConnector,
  google: googleConnector,
  klaviyo: klaviyoConnector,
};

/**
 * Routes a conversion to the correct platform connector.
 * Adding a 5th platform later = add one line here + one new connector file.
 * Nothing else in the system needs to change.
 */
function getConnector(platform) {
  const connector = registry[platform];
  if (!connector) throw new Error(`No connector registered for platform: ${platform}`);
  return connector;
}

module.exports = { getConnector };
