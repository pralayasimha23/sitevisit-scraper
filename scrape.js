import { chromium } from "playwright";
import fetch from "node-fetch";

const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;
const VIASOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;

if (!EMAIL || !PASSWORD || !VIASOCKET_WEBHOOK) {
  throw new Error("Missing environment variables");
}

// Normalize values for Viasocket / Sheets
const normalize = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    /* ================= LOGIN ================= */
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

    /* ================= AUTH COOKIES ================= */
    const cookies = await page.context().cookies();
    const xsrf = cookies.find(c => c.name === "XSRF-TOKEN");
    const session = cookies.find(c => c.name === "sv_forms_session");

    if (!xsrf || !session) {
      throw new Error("Auth cookies missing");
    }

    const XSRF_TOKEN = decodeURIComponent(xsrf.value);
    const SESSION = session.value;

    /* ================= FETCH DATA ================= */
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
            project: 13
          }
        }
      );

      const json = await res.json();
      const rows = Object.values(json.data || {});

      for (const r of rows) {
        finalRows.push({
          recent_site_visit_date: normalize(r.recent_date), // UI column
          name: normalize(r.first_name),
          contact: normalize(r.contact), // full number (UI masks it)
          lead_source: normalize(r.lead_source),
          lead_sub_source: normalize(r.lead_sub_source),
          lead_stage: normalize(r.lead_stage),
          lead_number: normalize(r.lead_number),
          status: normalize(r.status),
          created_at: normalize(r.created_at),
          updated_at: normalize(r.updated_at),
          total_time: normalize(r.total_time),
          site_visit_count: normalize(r.site_visit_count),
          is_qr: normalize(r.is_qr),
          raw_lead_id: normalize(r.lead_id) // keep for reference
        });
      }

      if (!json.next_page_url) break;
      pageNo++;
    }

    /* ================= SEND TO VIASOCKET ================= */
    await fetch(VIASOCKET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "urbanrise_portal",
        fetched_at: new Date().toISOString(),
        total_records: finalRows.length,
        records: finalRows
      })
    });

    console.log(`✅ Sent ${finalRows.length} records to Viasocket`);
  } catch (err) {
    console.error("❌ ERROR:", err.message);
    await page.screenshot({ path: "error.png", fullPage: true });
    throw err;
  } finally {
    await browser.close();
  }
})();
