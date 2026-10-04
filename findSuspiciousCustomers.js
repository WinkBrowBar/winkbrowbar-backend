// findSuspiciousCustomers.js
require('dotenv').config();
const { connectDB } = require('./src/db/connection');
const Customer = require('./src/db/models/Customer');

(async () => {
  await connectDB();
  const suspects = await Customer.find({
    $or: [
      { email: /test|backend|@techarchsoftwares\.com|@example\.com/i },
      { firstName: /test|backend/i },
      { lastName: /test|backend/i },
    ],
  });
  suspects.forEach((c) => console.log(`${c.firstName} ${c.lastName} | ${c.email} | ${c._id}`));
  console.log(`\n${suspects.length} suspicious customer(s) found.`);
  process.exit(0);
})();