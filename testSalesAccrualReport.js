// testSalesAccrualReport.js
//
// Diagnostic only - writes nothing. The empty-body call already proved the
// endpoint authorizes correctly but returns total:0 with no date filter, so
// SOME filter is required to get real rows back. Zenoti's own docs don't
// spell out the exact shape (invoice_closed_date is typed as a single
// DateTime?, not an obvious range), so this tries a few plausible shapes
// against the real API and prints what each one actually does - rather
// than guessing once and silently building on a wrong assumption.
//
// Usage:
//   node testSalesAccrualReport.js

require('dotenv').config();
const axios = require('axios');

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';
const ZENOTI_API_KEY = process.env.ZENOTI_API_KEY;
const url = `${ZENOTI_API_BASE}/v1/reports/sales/accrual_basis/flat_file`;

// Wide window on purpose - if ANY of these work, we should see real rows.
const START = '2026-08-01T00:00:00';
const END = '2026-09-26T23:59:59';

const attempts = [
  {
    label: 'A: body.invoice_closed_date as {from,to}',
    params: { Page: 1, Size: 5 },
    body: { invoice_closed_date: { from: START, to: END } },
  },
  {
    label: 'B: body.invoice_closed_date as {start_date,end_date}',
    params: { Page: 1, Size: 5 },
    body: { invoice_closed_date: { start_date: START, end_date: END } },
  },
  {
    label: 'C: top-level start_date/end_date in body (ignoring documented field name)',
    params: { Page: 1, Size: 5 },
    body: { start_date: START, end_date: END },
  },
  {
    label: 'D: StartDate/EndDate as QUERY params (same convention as invoices_by_date)',
    params: { Page: 1, Size: 5, StartDate: START, EndDate: END },
    body: {},
  },
  {
    label: 'E: date_type=1 plus body.invoice_closed_date as plain ISO date string (range via date_type)',
    params: { Page: 1, Size: 5 },
    body: { invoice_closed_date: END, date_type: 1 },
  },
];

async function run() {
  if (!ZENOTI_API_KEY) {
    console.error('ZENOTI_API_KEY is not set in .env');
    process.exit(1);
  }

  for (const attempt of attempts) {
    console.log(`\n=== ${attempt.label} ===`);
    try {
      const { data } = await axios.post(url, attempt.body, {
        params: attempt.params,
        headers: { Authorization: `apikey ${ZENOTI_API_KEY}`, 'Content-Type': 'application/json' },
      });
      const total = data.page_info ? data.page_info.total : '(no page_info)';
      console.log(`total: ${total}, rows returned: ${(data.sales || []).length}`);
      if ((data.sales || []).length) {
        console.log('First row:', JSON.stringify(data.sales[0], null, 2));
      }
    } catch (err) {
      console.log('FAILED:', err.response ? JSON.stringify(err.response.data) : err.message);
    }
  }
}

run();