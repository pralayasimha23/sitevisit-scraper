import { chromium } from "playwright";
import fetch from "node-fetch";
import fs from "fs";

/* ================= CONFIG ================= */
const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;
const VIASOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;

if (!EMAIL || !PASSWORD || !VIASOCKET_WEBHOOK) {
  throw new Error("❌ Missing environment variables");
}

/* ================= CURSOR ================= */
let LAST_CREATED_AT = "1970-01-01 00:00:00";

if (fs.existsSync("cursor.json")) {
  const cursor = JSON.parse(fs.readFileSync("cursor.json", "utf8"));
  LAST_CREATED_AT = cursor.last_created_at || LAST_CREATED_AT;
}

console.log("⏱ LAST_CREATED_AT:", LAST_CREATED_AT);

/* ================= HELPERS ================= */

// UI uses MM/DD/YYYY
const formatDate = (d) => {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
};

// last 30 days
const DATE_FILTER = `${formatDate(
  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
)} - ${formatDate(new Date())}`;

console.log("📅 DATE_FILTER:", DATE_FILTER);

const normalize = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
};

/* ================= MAIN ================= */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  let newRecords = [];

  try {
    /* ===== LOGIN ===== */
    await page.goto("https://svform.urbanriseprojects.in/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForSelector('input[type="password"]', { timeout: 60000 });

    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.waitForTimeout(1500);

    const loginBtn =
      (await page.$('button:has-text("Login")')) ||
      (await page.$('button'));

    await loginBtn.click();
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    console.log("✅ Logged in");

    /* ===== COOKIES ===== */
    const cookies = await page.context().cookies();
    const xsrf = cookies.find(c => c.name === "XSRF-TOKEN");
    const session = cookies.find(c => c.name === "sv_forms_session");

    if (!xsrf || !session) throw new Error("Auth cookies missing");

    const XSRF_TOKEN = decodeURIComponent(xsrf.value);
    const SESSION = session.value;

    /* ===== FETCH DATA ===== */
    let pageNo = 1;

    while (true) {
      const res = await page.request.post(
        `https://svform.urbanriseprojects.in/leadList?page=${pageNo}`,
        {
          headers: {
            "Content-Type": "application/json",
            "X-XSRF-TOKEN": XSRF_TOKEN,
            "Cookie": `XSRF-TOKEN=${XSRF_TOKEN}; sv_forms_session=${SESSION}`
          },
          data: {
            searchBy: "contact",
            dateFilter: DATE_FILTER,
            project: 13
          }
        }
      );

      const json = await res.json();
      const rows = Object.values(json.data || {});
      console.log(`📄 Page ${pageNo}: ${rows.length} records`);

      for (const r of rows) {
        // 🔑 INCREMENTAL FILTER
        if (r.created_at > LAST_CREATED_AT) {
          newRecords.push({
            recent_site_visit_date: normalize(r.recent_date),
            name: normalize(r.first_name),
            contact: normalize(r.contact),
            lead_source: normalize(r.lead_source),
            lead_sub_source: normalize(r.lead_sub_source),
            lead_stage: normalize(r.lead_stage),
            lead_number: normalize(r.lead_number),
            created_at: normalize(r.created_at),
            updated_at: normalize(r.updated_at)
          });
        }
      }

      if (!json.next_page_url) break;
      pageNo++;
    }

    console.log("🆕 NEW RECORDS FOUND:", newRecords.length);

    if (newRecords.length === 0) {
      console.log("ℹ️ No new records. Exiting.");
      return;
    }

    /* ===== SEND TO VIASOCKET ===== */
    await fetch(VIASOCKET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        meta: {
          source: "urbanrise_portal",
          date_filter: DATE_FILTER,
          previous_cursor: LAST_CREATED_AT,
          new_records: newRecords.length
        },
        records: newRecords
      })
    });

    console.log("🚀 Sent new records to Viasocket");

    /* ===== UPDATE CURSOR FILE ===== */
    const newestCreatedAt = newRecords
      .map(r => r.created_at)
      .sort()
      .slice(-1)[0];

    fs.writeFileSync(
      "cursor.json",
      JSON.stringify({ last_created_at: newestCreatedAt }, null, 2)
    );

    console.log("✅ Cursor updated to:", newestCreatedAt);

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
})();
