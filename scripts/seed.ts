// Set mock mode before config is imported; never seed a live PayPal account.
process.env.PAYPAL_MODE = "mock";
const { seed } = await import("../server/seed.js");
const { db } = await import("../server/db.js");
try { await seed(); } finally { db.close(); }
