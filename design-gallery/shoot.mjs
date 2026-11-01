// Usage: design-gallery/shoot.sh <url> <out.png> [width=1440] [height=900] [theme] [full=0|1], which sets up what this needs.
// Prints the page title and any console errors.
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
const [url, out, width = "1440", height = "900", theme = "", full = "0"] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), headless: true, args: ["--lang=en-US", "--no-sandbox", "--disable-gpu", "--no-zygote", "--hide-scrollbars", "--font-render-hinting=none"] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.setViewport({ width: Number(width), height: Number(height), deviceScaleFactor: Number(width) < 600 ? 2 : 1, isMobile: Number(width) < 600, hasTouch: Number(width) < 600 });
  if (theme) await page.evaluateOnNewDocument((t) => { try { localStorage.setItem("nexus.theme", t); } catch {} }, theme);
  await page.emulateTimezone("UTC").catch(() => {});
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch((e) => errors.push(`goto: ${e.message}`));
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: out, fullPage: full === "1" });
  console.log(await page.title());
  for (const e of errors) console.log("console error:", e);
} finally { await browser.close(); }
