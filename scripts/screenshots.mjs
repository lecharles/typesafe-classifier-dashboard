// Drives the running dev server with a headless browser and captures dashboard
// screenshots into ./screenshots. Usage: BASE=http://localhost:3001 node scripts/screenshots.mjs
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:3001";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function shot(name) {
  await sleep(1500); // let charts settle
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`captured ${name}`);
}

// 1. Home
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await shot("1-home");

// 2. Playground — classify the pre-filled sample
await page.goto(`${BASE}/playground`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Classify", exact: true }).click();
await page.getByText(/tokens:/).waitFor({ timeout: 60000 });
await shot("2-playground");

// 3. Email triage — classify all, wait for the stats + table
await page.goto(`${BASE}/emails`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /^Classify \d+/ }).click();
await page.getByText("Emails classified").waitFor({ timeout: 180000 });
await page.getByText("Every email").waitFor({ timeout: 180000 });
await shot("3-emails");

// 4. YouTube analyzer — analyze all, wait for stats + table
await page.goto(`${BASE}/youtube`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Analyze/ }).click();
await page.getByText("Videos analyzed").waitFor({ timeout: 180000 });
await page.getByText("Every video").waitFor({ timeout: 180000 });
await shot("4-youtube");

await browser.close();
console.log("done");
