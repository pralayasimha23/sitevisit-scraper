import { chromium } from "playwright";
import fetch from "node-fetch";

const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;
const VIASOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;

if (!EMAIL || !PASSWORD || !VIASOCKET_WEBHOOK) {
  throw new Error("Missing required environment variables");
}

(async () => {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 }
  });

  try {
    // 1️⃣ Open login page
    await page.goto("https://svform.urbanriseprojects.in/", {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    // 2️⃣ Wait for login inputs
    await page.waitForSelector('input[type="password"]', { timeout: 60000 });

    // 3️⃣ Fill credentials
    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);

    // Small delay helps in CI
    await page.waitForTimeout(2000);

    // 4️⃣ Click login button (robust)
    const loginButton =
      (await page.$('button:has-text("Login")')) ||
      (await page.$('button:has-text("Sign In")')) ||
      (await page.$('button:has-text("Submit")')) ||
      (await page.$('button'));

    if (!loginButton) {
      throw new Error("Login button not found");
    }

    await loginButton.click();

    // 5️⃣ Wait for authenticated state
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    // 6️⃣ Extract cookies
    const cookies = await page.context().cookies();

    const xsrfCookie = cookies.find(c => c.name === "XSRF-TOKEN");
    const sessionCookie = cookies.find(c => c.name === "sv_forms_session");

    if (!xsrfCookie || !sessionCookie) {
      throw new Error("Auth cookies not found");
    }

    const XSRF_TOKEN = decodeURIComponent(xsrfCookie.value);
    const SESSION = sessionCookie.value;

    // 7️⃣ Fetch paginated data
    let pageNo = 1;
    let allRecords = [];

    while (true) {
      const response = await page.request.post(
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

      if (!response.ok()) {
        throw new Error(`API failed on page ${pageNo}`);
      }

      const json = await response.json();
      const records = Object.values(json.data || {});

      allRecords.push(...records);

      if (!json.next_page_url) break;
      pageNo++;
    }

    // 8️⃣ Send to Viasocket
    await fetch(VIASOCKET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "urbanrise_portal",
        fetched_at: new Date().toISOString(),
        total_records: allRecords.length,
        records: allRecords
      })
    });

    console.log(`✅ Sent ${allRecords.length} records to Viasocket`);
  } catch (err) {
    console.error("❌ Scraper failed:", err.message);

    // Screenshot for debugging if login fails
    await page.screenshot({ path: "error.png", fullPage: true });

    throw err;
  } finally {
    await browser.close();
  }
})();
