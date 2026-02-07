import { chromium } from "playwright";
import fetch from "node-fetch";
import fs from "fs";

/* ================= ENV ================= */
const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;
const VIASOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;

console.log("🔧 ENV CHECK", {
  PORTAL_EMAIL: !!EMAIL,
  PORTAL_PASSWORD: !!PASSWORD,
  VIASOCKET_WEBHOOK: !!VIASOCKET_WEBHOOK
});

if (!EMAIL || !PASSWORD || !VIASOCKET_WEBHOOK) {
  throw new Error("❌ Missing environment variables");
}

/* ================= HELPERS ================= */

// IMPORTANT: UI uses MM/DD/YYYY
const formatDate = (d) => {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
};

// Last 30 days
const startDate = formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
const endDate = formatDate(new Date());
const DATE_FILTER = `${startDate} - ${endDate}`;

console.log("📅 DATE_FILTER:", DATE_FILTER);

// Normalize values
const normalize = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
};

/* ================= MAIN ================= */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 }
  });

  let finalRows = [];

  try {
    /* ========= LOGIN ========= */
    console.log("🔐 Opening portal...");
    await page.goto("https://svform.urbanriseprojects.in/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForSelector('input[type="password"]', { timeout: 60000 });

    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);

    await page.waitForTimeout(2000);

    const loginBtn =
      (await page.$('button:has-text("Login")')) ||
      (await page.$('button:has-text("Sign In")')) ||
      (await page.$('button'));

    if (!loginBtn) throw new Error("❌ Login button not found");

    await loginBtn.click();
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    console.log("✅ Login successful");

    /* ========= COOKIES ========= */
    const cookies = await page.context().cookies();
    console.log("🍪 Cookies:", cookies.map(c => c.name));

    const xsrf = cookies.find(c => c.name === "XSRF-TOKEN");
    const session = cookies.find(c => c.name === "sv_forms_session");

    if (!xsrf || !session) {
      throw new Error("❌ Required auth cookies missing");
    }

    const XSRF_TOKEN = decodeURIComponent(xsrf.value);
    const SESSION = session.value;

    /* ========= FETCH DATA ========= */
    let pageNo = 1;

    while (true) {
      console.log(`📡 Fetching page ${pageNo}`);

      const apiPayload = {
        searchBy: "contact",
        dateFilter: DATE_FILTER,
        project: 13
      };

      console.log("➡️ API PAYLOAD:", apiPayload);

      const res = await page.request.post(
        `https://svform.urbanriseprojects.in/leadList?page=${pageNo}`,
        {
          headers: {
            "Content-Type": "application/json",
            "X-XSRF-TOKEN": XSRF_TOKEN,
            "Cookie": `XSRF-TOKEN=${XSRF_TOKEN}; sv_forms_session=${SESSION}`
          },
          data: apiPayload
        }
      );

      console.log("⬅️ API STATUS:", res.status());

      const json = await res.json();
      const rows = Object.values(json.data || {});

      console.log(`📦 Records on page ${pageNo}:`, rows.length);

      if (rows.length && pageNo === 1) {
        console.log("🧪 Sample record:", rows[0]);
      }

      for (const r of rows) {
        finalRows.push({
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

      if (!json.next_page_url) break;
      pageNo++;
    }

    console.log("📊 TOTAL RECORDS COLLECTED:", finalRows.length);

    /* ========= SAVE PAYLOAD PREVIEW ========= */
    const previewPayload = {
      source: "urbanrise_portal",
      date_filter: DATE_FILTER,
      total_records: finalRows.length,
      records: finalRows.slice(0, 5)
    };

    fs.writeFileSync(
      "viasocket_payload_preview.json",
      JSON.stringify(previewPayload, null, 2)
    );

    console.log("📝 Saved viasocket_payload_preview.json");

    /* ========= SEND TO VIASOCKET ========= */
    console.log("🚀 Sending data to Viasocket...");

    const vsRes = await fetch(VIASOCKET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "urbanrise_portal",
        fetched_at: new Date().toISOString(),
        date_filter: DATE_FILTER,
        total_records: finalRows.length,
        records: finalRows
      })
    });

    console.log("📬 Viasocket status:", vsRes.status);
    console.log("📬 Viasocket response:", await vsRes.text());

    console.log("✅ SCRIPT COMPLETED SUCCESSFULLY");
  } catch (err) {
    console.error("❌ SCRIPT ERROR:", err.message);
    await page.screenshot({ path: "error.png", fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
})();
