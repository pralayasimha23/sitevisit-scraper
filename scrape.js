import { chromium } from "playwright";
import fetch from "node-fetch";

const VIA_SOCKET_WEBHOOK = process.env.VIASOCKET_WEBHOOK;
const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 1. Login
  await page.goto("https://svform.urbanriseprojects.in/");
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForLoadState("networkidle");

  // 2. Get cookies
  const cookies = await page.context().cookies();
  const xsrf = decodeURIComponent(cookies.find(c => c.name === "XSRF-TOKEN").value);
  const session = cookies.find(c => c.name === "sv_forms_session").value;

  // 3. Fetch ALL pages
  let pageNo = 1;
  let allLeads = [];

  while (true) {
    const res = await page.request.post(
      `https://svform.urbanriseprojects.in/leadList?page=${pageNo}`,
      {
        headers: {
          "X-XSRF-TOKEN": xsrf,
          "Content-Type": "application/json",
          "Cookie": `XSRF-TOKEN=${xsrf}; sv_forms_session=${session}`
        },
        data: {
          searchBy: "contact",
          project: 13
        }
      }
    );

    const json = await res.json();
    allLeads.push(...Object.values(json.data));

    if (!json.next_page_url) break;
    pageNo++;
  }

  // 4. Send to Viasocket
  await fetch(VIA_SOCKET_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "urbanrise_portal",
      fetched_at: new Date().toISOString(),
      records: allLeads
    })
  });

  await browser.close();
})();
