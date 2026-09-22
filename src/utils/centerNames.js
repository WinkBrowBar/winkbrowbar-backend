// Maps Zenoti center_id (UUID) -> human-readable studio name.
// Confirmed by cross-referencing invoice_number_prefix in raw Zenoti payloads:
// CH-prefixed invoices -> Cobble Hill, WV-prefixed invoices -> West Village.
const CENTER_NAMES = {
  '23c89dee-8285-4c13-b081-12652173dc17': 'Cobble Hill',
  'fe6b4dd3-1c8c-4f6e-84ac-42e6f81a001a': 'West Village',
  '188b010f-a060-4ba9-a5c0-56ffb4339479': 'Upper East Side',
};

function centerName(centerId) {
  if (!centerId) return null;
  return CENTER_NAMES[centerId] || null;
}

module.exports = { CENTER_NAMES, centerName };