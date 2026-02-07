import { chromium } from "playwright";
import fetch from "node-fetch";

/* ================= ENV ================= */
const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;
const VIASOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;

if (!EMAIL || !PASSWORD || !VIASOCKET_WEBHOOK) {
  throw new Error("Missing environment variables");
}

/* ================= HELPERS ================= */

// Browser uses MM/DD/YYYY
const formatDate = (d) => {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
};

// last 30 days (same behavior as UI)
const startDate = formatDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
const endDate = formatDate(new Date());
const DATE_FILTER = `${startDate} - ${endDate}`;

// normalize for Viasocket / Sheets
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

  try {
    /* ========= LOGIN ========= */
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

    if (!loginBtn) throw new Error("Login button not found");

    await loginBtn.click();
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    /* ========= COOKIES ========= */
    const cookies = await page.context().cookies();
    const xsrf = cookies.find(c => c.name === "XSRF-TOKEN");
    const session = cookies.find(c => c.name === "sv_forms_session");

    if (!xsrf || !session) {
      throw new Error("Auth cookies not found");
    }

    const XSRF_TOKEN = decodeURIComponent(xsrf.value);
    const SESSION = session.value;

    /* ========= FETCH DATA ========= */
    let pageNo = 1;
    let finalRows = [];

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
            dateFilter: DATE_FILTER, // MUST MATCH UI
            project: 13
          }
        }
      );

      if (!res.ok()) {
        throw new Error(`API failed on page ${pageNo}`);
      }

      const json = await res.json();
      const rows = Object.values(json.data || {});

      console.log(`Page ${pageNo}: ${rows.length} records`);

      for (const r of rows) {
        finalRows.push({
          recent_site_visit_date: normalize(r.recent_date),
          name: normalize(r.first_name),
          contact: normalize(r.contact), // full number (UI masks)
          lead_source: normalize(r.lead_source),
          lead_sub_source: normalize(r.lead_sub_source),
          lead_stage: normalize(r.lead_stage),
          lead_number: normalize(r.lead_number),
          status: normalize(r.status),
          created_at: normalize(r.created_at),
          updated_at: normalize(r.updated_at),
          site_visit_count: normalize(r.site_visit_count),
          total_time: normalize(r.total_time),
          is_qr: normalize(r.is_qr),
          raw_lead_id: normalize(r.lead_id)
        });
      }

      if (!json.next_page_url) break;
      pageNo++;
    }

    /* ========= SEND TO VIASOCKET ========= */
    await fetch(VIASOCKET_WEBHOOK, {
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

    console.log(`✅ SUCCESS: Sent ${finalRows.length} records to Viasocket`);
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    await page.screenshot({ path: "error.png", fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
})();
