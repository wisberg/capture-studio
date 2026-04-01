import express from "express";
import cors from "cors";
import { chromium } from "playwright";
import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8787;
const MAX_URLS = 200;
const JOB_TTL_MS = 10 * 60 * 1000;
const jobs = new Map();

function normalizeUrl(rawUrl) {
  const candidate =
    rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? rawUrl
      : `https://${rawUrl}`;
  return new URL(candidate).toString();
}

function sanitizeFilePart(value) {
  return (
    (value || "page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "page"
  );
}

function extractLocUrls(xmlText) {
  return [...xmlText.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => match[1].trim())
    .map((value) => value.replace(/<!\[CDATA\[(.*?)\]\]>/gis, "$1").trim())
    .filter(Boolean);
}

async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function collectSitemapUrls(startSitemapUrl) {
  const visitedSitemaps = new Set();
  const queue = [startSitemapUrl];
  const pageUrls = [];

  while (queue.length && pageUrls.length < MAX_URLS) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);

    let xml;
    try {
      xml = await fetchText(sitemapUrl);
    } catch {
      continue;
    }

    const locs = extractLocUrls(xml);
    for (const loc of locs) {
      if (pageUrls.length >= MAX_URLS) break;
      if (loc.endsWith(".xml")) {
        if (!visitedSitemaps.has(loc)) queue.push(loc);
      } else {
        pageUrls.push(loc);
      }
    }
  }

  return [...new Set(pageUrls)];
}

async function createPdf(page, url, viewport, options = {}) {
  const { hideSticky = true, waitAfterLoadMs = 0, detachSelectors = [] } =
    options;
  await page.setViewportSize(viewport);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page
    .waitForLoadState("networkidle", { timeout: 60_000 })
    .catch(() => {});
  await page.emulateMedia({ media: "screen" });

  await dismissCookieBanners(page);
  await page.waitForTimeout(300);
  await scrollPageForLazyLoad(page);
  await page.waitForTimeout(200);
  await normalizeForFullPageCapture(page);
  const detached = await captureDetachedElements(page, detachSelectors);
  if (detachSelectors.length) {
    await hideDetachedElements(page, detachSelectors);
  }
  if (hideSticky) {
    await hideStickyElements(page);
  }
  await ensureScrollTop(page);
  if (waitAfterLoadMs > 0) {
    await page.waitForTimeout(waitAfterLoadMs);
  }

  const pageTitle = await page.title();
  const pageTitleRaw = pageTitle?.trim() || "Untitled page";
  const measured = await getDocumentSize(page);
  const targetWidth = Math.max(viewport.width, measured.width, 320);

  await page.setViewportSize({ width: targetWidth, height: viewport.height });
  await page.waitForTimeout(150);

  const finalSize = await getDocumentSize(page);
  const targetHeight = Math.max(finalSize.height, viewport.height, 640);

  const png = await page.screenshot({
    fullPage: true,
    type: "png",
    captureBeyondViewport: true,
  });
  const preview = await page.screenshot({
    fullPage: true,
    type: "jpeg",
    quality: 60,
    captureBeyondViewport: true,
  });
  const pdf = await renderImagePdf(page, png, targetWidth, targetHeight);

  return {
    title: sanitizeFilePart(pageTitleRaw),
    titleRaw: pageTitleRaw,
    pdf,
    preview,
    detached,
  };
}

async function captureDetachedElements(page, selectors) {
  if (!Array.isArray(selectors) || selectors.length === 0) return [];
  const results = [];

  for (const selector of selectors) {
    if (!selector) continue;
    const locator = page.locator(selector);
    const count = Math.min(await locator.count(), 3);
    for (let i = 0; i < count; i += 1) {
      const element = locator.nth(i);
      const visible = await element.isVisible().catch(() => false);
      if (!visible) continue;
      try {
        const buffer = await element.screenshot({ type: "png" });
        results.push({
          label: selector,
          buffer,
        });
      } catch {
        // ignore screenshot failures
      }
    }
  }

  return results;
}

async function hideDetachedElements(page, selectors) {
  await page.evaluate((list) => {
    if (!list.length) return;
    const styleId = "detached-elements-style";
    const existing = document.getElementById(styleId);
    const styleTag = existing || document.createElement("style");
    styleTag.id = styleId;
    styleTag.textContent = list
      .map((selector) => `${selector} { display: none !important; }`)
      .join("\n");
    if (!existing) {
      document.head.appendChild(styleTag);
    }

    list.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        el.style.setProperty("display", "none", "important");
        el.setAttribute("data-detached", "true");
      });
    });
  }, selectors);
}

async function scrollPageForLazyLoad(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const viewportHeight = window.innerHeight;
    const root = document.scrollingElement || document.documentElement;

    const candidates = Array.from(document.querySelectorAll("body *")).filter(
      (el) => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if (!["auto", "scroll"].includes(overflowY)) return false;
        if (el.scrollHeight <= el.clientHeight + 100) return false;
        const rect = el.getBoundingClientRect();
        return (
          rect.height >= viewportHeight * 0.6 &&
          rect.width >= window.innerWidth * 0.6
        );
      },
    );

    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const main = candidates[0] || root;

    const getScrollHeight = (el) => {
      if (el === root) {
        return Math.max(
          document.body.scrollHeight,
          document.documentElement.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.offsetHeight,
        );
      }
      return el.scrollHeight;
    };

    const scrollTo = (pos) => {
      if (main === root) {
        window.scrollTo(0, pos);
      } else {
        main.scrollTop = pos;
      }
    };

    const maxTries = 50;
    let lastHeight = 0;

    for (let i = 0; i < maxTries; i += 1) {
      scrollTo(getScrollHeight(main));
      await delay(300);
      const height = getScrollHeight(main);
      if (height === lastHeight) break;
      lastHeight = height;
    }

    scrollTo(0);
    if (main !== root) {
      window.scrollTo(0, 0);
    }
  });
}

async function normalizeForFullPageCapture(page) {
  await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const viewportHeight = window.innerHeight;

    html.style.height = "auto";
    html.style.overflow = "visible";
    body.style.height = "auto";
    body.style.overflow = "visible";

    const candidates = Array.from(document.querySelectorAll("body *")).filter(
      (el) => {
        const style = window.getComputedStyle(el);
        const overflowY = style.overflowY;
        if (!["auto", "scroll"].includes(overflowY)) return false;
        if (el.scrollHeight <= el.clientHeight + 100) return false;
        const rect = el.getBoundingClientRect();
        return (
          rect.height >= viewportHeight * 0.6 &&
          rect.width >= window.innerWidth * 0.6
        );
      },
    );

    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    const main = candidates[0];
    if (main) {
      main.style.overflow = "visible";
      main.style.height = "auto";
      main.style.maxHeight = "none";
    }
  });
}

async function ensureScrollTop(page) {
  await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    root.scrollTop = 0;
    window.scrollTo(0, 0);
  });
}

async function hideStickyElements(page) {
  await page.evaluate(() => {
    const viewportHeight = window.innerHeight || 0;
    const viewportWidth = window.innerWidth || 0;
    const candidates = Array.from(document.querySelectorAll("body *"));

    candidates.forEach((el) => {
      const style = window.getComputedStyle(el);
      if (!["fixed", "sticky"].includes(style.position)) return;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const viewportArea = viewportWidth * viewportHeight;
      const isFullWidth = rect.width >= viewportWidth * 0.85;
      const isBottom = rect.bottom >= viewportHeight - 4;
      const isLarge = viewportArea > 0 ? area / viewportArea > 0.05 : false;
      const isOverlayish =
        Number(style.zIndex || 0) > 1000 || style.position === "fixed";

      if ((isBottom && isFullWidth && isLarge) || (isOverlayish && isLarge)) {
        el.style.setProperty("display", "none", "important");
        el.setAttribute("data-capture-hidden", "true");
      }
    });
  });
}

async function renderImagePdf(page, pngBuffer, width, height) {
  const imagePage = await page.context().newPage();
  const dataUrl = `data:image/png;base64,${pngBuffer.toString("base64")}`;
  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          html, body { margin: 0; padding: 0; background: #fff; }
          img { display: block; width: ${width}px; height: ${height}px; }
        </style>
      </head>
      <body>
        <img src="${dataUrl}" alt="Full page screenshot" />
      </body>
    </html>`;
  await imagePage.setContent(html, { waitUntil: "load" });

  const pdf = await imagePage.pdf({
    printBackground: true,
    width: `${width}px`,
    height: `${height}px`,
    margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
  });
  await imagePage.close();
  return pdf;
}

async function getDocumentSize(page) {
  return page.evaluate(() => {
    const body = document.body;
    const html = document.documentElement;
    const width = Math.max(
      body?.scrollWidth || 0,
      html?.scrollWidth || 0,
      html?.clientWidth || 0,
    );
    const height = Math.max(
      body?.scrollHeight || 0,
      html?.scrollHeight || 0,
      html?.clientHeight || 0,
    );
    return { width, height };
  });
}

async function dismissCookieBanners(page) {
  const acceptPattern =
    /accept|agree|allow all|allow|ok|got it|continue|yes|i agree/i;
  const rejectPattern =
    /reject|decline|deny|no thanks|necessary only|essential only/i;

  const clickFirstVisible = async (locator) => {
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const candidate = locator.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) continue;
      await candidate.click({ timeout: 1500, force: true }).catch(() => {});
      return true;
    }
    return false;
  };

  const candidates = [
    page.getByRole("button", { name: acceptPattern }),
    page.getByRole("link", { name: acceptPattern }),
    page.locator(
      `button:has-text("Accept"), button:has-text("I agree"), button:has-text("Allow all")`,
    ),
    page
      .locator(`text=/accept|agree|allow all|allow|ok|got it|continue|yes/i`)
      .locator(".."),
  ];

  for (const candidate of candidates) {
    if (await clickFirstVisible(candidate)) break;
  }

  const rejectCandidates = [
    page.getByRole("button", { name: rejectPattern }),
    page.getByRole("link", { name: rejectPattern }),
    page.locator(
      `button:has-text("Reject"), button:has-text("Decline"), button:has-text("Deny")`,
    ),
  ];

  for (const candidate of rejectCandidates) {
    if (await clickFirstVisible(candidate)) break;
  }

  await page.evaluate(() => {
    const selectors = [
      '[id*="cookie"]',
      '[class*="cookie"]',
      '[aria-label*="cookie"]',
      '[data-testid*="cookie"]',
      '[id*="consent"]',
      '[class*="consent"]',
      '[aria-label*="consent"]',
      "[data-consent]",
      ".cookie",
      ".cookies",
    ];
    const viewportArea = window.innerWidth * window.innerHeight;
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const area = rect.width * rect.height;
        const isOverlay =
          style.position === "fixed" ||
          style.position === "sticky" ||
          Number(style.zIndex || 0) > 1000;
        if (isOverlay || area / viewportArea > 0.15) {
          el.remove();
        }
      });
    });
  });
}

function sendEvent(job, type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  job.clients.forEach((res) => {
    res.write(data);
  });
}

function updateJob(job, updates) {
  job.stage = updates.stage ?? job.stage;
  job.message = updates.message ?? job.message;
  job.completed = updates.completed ?? job.completed;
  job.total = updates.total ?? job.total;
  job.currentUrl = updates.currentUrl ?? job.currentUrl;
  sendEvent(job, "progress", {
    stage: job.stage,
    message: job.message,
    completed: job.completed,
    total: job.total,
    currentUrl: job.currentUrl,
  });
}

function normalizeDevices(devices) {
  const defaults = [
    { id: "desktop", label: "Desktop", width: 1920, height: 1080 },
    { id: "mobile", label: "Mobile", width: 390, height: 844 },
  ];

  if (!Array.isArray(devices) || devices.length === 0) {
    return defaults;
  }

  const normalized = devices
    .map((device) => {
      if (!device) return null;
      const width = Number.parseInt(device.width, 10);
      const height = Number.parseInt(device.height, 10);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      const label = String(device.label || device.name || device.id || "Device");
      const id = String(device.id || sanitizeFilePart(label));
      return {
        id,
        label,
        width: Math.min(Math.max(width, 240), 4000),
        height: Math.min(Math.max(height, 320), 4000),
      };
    })
    .filter(Boolean);

  return normalized.length ? normalized : defaults;
}

function normalizeAuth(auth) {
  if (!auth || typeof auth !== "object") return null;
  const username = String(auth.username || "").trim();
  const password = String(auth.password || "").trim();
  if (!username || !password) return null;
  const mode =
    auth.mode === "basic" || auth.mode === "form" ? auth.mode : "auto";
  return { username, password, mode };
}

function injectExamineHtml(html, baseUrl) {
  const safeBase = String(baseUrl || "").replace(/"/g, "&quot;");
  const script = `
    (() => {
      const overlay = document.createElement("div");
      overlay.id = "cs-hover-overlay";
      overlay.style.position = "fixed";
      overlay.style.border = "2px solid rgba(16,185,129,0.9)";
      overlay.style.background = "rgba(16,185,129,0.08)";
      overlay.style.pointerEvents = "none";
      overlay.style.zIndex = "2147483647";
      overlay.style.display = "none";

      const label = document.createElement("div");
      label.id = "cs-hover-label";
      label.style.position = "fixed";
      label.style.background = "rgba(0,0,0,0.8)";
      label.style.color = "#fff";
      label.style.fontSize = "10px";
      label.style.fontWeight = "600";
      label.style.padding = "4px 8px";
      label.style.borderRadius = "999px";
      label.style.pointerEvents = "none";
      label.style.zIndex = "2147483647";
      label.style.display = "none";

      document.addEventListener("DOMContentLoaded", () => {
        document.body.appendChild(overlay);
        document.body.appendChild(label);
      });

      const describe = (el) => {
        if (!el) return "(no class)";
        const classes = el.classList ? Array.from(el.classList) : [];
        return classes.length ? "." + classes.join(" .") : "(no class)";
      };

      const update = (target) => {
        if (!target || target === overlay || target === label) return;
        const rect = target.getBoundingClientRect();
        overlay.style.display = "block";
        label.style.display = "block";
        overlay.style.top = rect.top + "px";
        overlay.style.left = rect.left + "px";
        overlay.style.width = rect.width + "px";
        overlay.style.height = rect.height + "px";
        label.textContent = describe(target);
        label.style.top = Math.max(0, rect.top - 22) + "px";
        label.style.left = Math.max(0, rect.left) + "px";
      };

      document.addEventListener("mousemove", (event) => update(event.target));
      document.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const target = event.target;
        if (!target) return;
        const classes = target.classList ? Array.from(target.classList) : [];
        const payload = {
          type: "cs-examine-class",
          classes,
          label: classes.length ? "." + classes.join(" .") : "(no class)",
        };
        window.parent?.postMessage(payload, "*");
      });
      document.addEventListener("mouseleave", () => {
        overlay.style.display = "none";
        label.style.display = "none";
      });
    })();
  `;

  const scriptTag = `<script>${script}</script>`;
  const baseTag = `<base href="${safeBase}">`;
  const sanitized = html.replace(
    /<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi,
    "",
  );

  if (/<head[^>]*>/i.test(sanitized)) {
    return sanitized.replace(
      /<head[^>]*>/i,
      (match) => `${match}\n${baseTag}\n${scriptTag}`,
    );
  }

  if (/<html[^>]*>/i.test(sanitized)) {
    return sanitized.replace(
      /<html[^>]*>/i,
      (match) => `${match}\n<head>${baseTag}${scriptTag}</head>`,
    );
  }

  return `<!doctype html><html><head>${baseTag}${scriptTag}</head><body>${sanitized}</body></html>`;
}

async function hasVisiblePasswordField(page) {
  const locator = page.locator('input[type="password"]');
  if ((await locator.count()) === 0) return false;
  return locator.first().isVisible().catch(() => false);
}

async function attemptFormLogin(page, auth) {
  const passwordInput = page.locator('input[type="password"]').first();
  if ((await passwordInput.count()) === 0) return false;
  const isVisible = await passwordInput.isVisible().catch(() => false);
  if (!isVisible) return false;

  const form = passwordInput.locator("xpath=ancestor::form[1]");
  const scope = (await form.count()) > 0 ? form : page.locator("body");
  const usernameInputCandidates = [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="login" i]',
    'input[type="text"]',
  ];

  for (const selector of usernameInputCandidates) {
    const candidate = scope.locator(selector).first();
    if ((await candidate.count()) === 0) continue;
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    await candidate.fill(auth.username).catch(() => {});
    break;
  }

  await passwordInput.fill(auth.password).catch(() => {});

  const submitCandidates = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
  ];

  let submitted = false;
  for (const selector of submitCandidates) {
    const candidate = scope.locator(selector).first();
    if ((await candidate.count()) === 0) continue;
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    await candidate.click({ timeout: 1500 }).catch(() => {});
    submitted = true;
    break;
  }

  if (!submitted) {
    await passwordInput.press("Enter").catch(() => {});
  }

  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

async function ensureAuthenticated(page, targetUrl, auth) {
  if (!auth) return;

  const response = await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});

  if (auth.mode === "basic") {
    if (response?.status() === 401) {
      throw new Error("Authentication failed (HTTP 401). Check credentials.");
    }
    return;
  }

  const needsFormLogin = await hasVisiblePasswordField(page);
  if (needsFormLogin || auth.mode === "form") {
    await attemptFormLogin(page, auth);
    if (await hasVisiblePasswordField(page)) {
      throw new Error("Authentication failed. Please verify credentials.");
    }
  }
}

async function exportSite(normalizedUrl, options = {}, onProgress, onPreview) {
  const devices = normalizeDevices(options.devices);
  const hideSticky = options.hideSticky !== false;
  const detachSelectors = Array.isArray(options.detachSelectors)
    ? options.detachSelectors.filter(Boolean)
    : [];
  const auth = normalizeAuth(options.auth);
  const sitemapUrl = normalizedUrl.endsWith(".xml")
    ? normalizedUrl
    : new URL("/sitemap.xml", normalizedUrl).toString();
  onProgress?.({
    stage: "sitemap",
    message: `Discovering URLs from ${sitemapUrl}`,
  });

  const discoveredUrls = await collectSitemapUrls(sitemapUrl);
  if (discoveredUrls.length === 0) {
    throw new Error(`No page URLs discovered from sitemap: ${sitemapUrl}`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "site-export-"));
  const previewDir = path.join(tempRoot, "Previews");
  const detachedDir = path.join(tempRoot, "Detached");
  await fs.mkdir(previewDir, { recursive: true });
  await fs.mkdir(detachedDir, { recursive: true });
  const deviceDirs = new Map();
  for (const device of devices) {
    const slug = sanitizeFilePart(device.label || device.id);
    const dir = path.join(tempRoot, slug);
    deviceDirs.set(device.id, { dir, slug, label: device.label });
    await fs.mkdir(dir, { recursive: true });
  }

  onProgress?.({
    stage: "browser",
    message: "Launching browser…",
    total: discoveredUrls.length,
    completed: 0,
  });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext(
      auth?.mode === "basic" || auth?.mode === "auto"
        ? { httpCredentials: { username: auth.username, password: auth.password } }
        : undefined,
    );
    const page = await context.newPage();
    const authTargetUrl = normalizedUrl.endsWith(".xml")
      ? new URL("/", normalizedUrl).toString()
      : normalizedUrl;
    await ensureAuthenticated(page, authTargetUrl, auth);
    const usedNames = new Map();
    const previews = [];

    let completed = 0;
    for (const pageUrl of discoveredUrls) {
      onProgress?.({
        stage: "capture",
        message: `Capturing ${pageUrl}`,
        currentUrl: pageUrl,
        completed,
        total: discoveredUrls.length,
      });
      try {
        let pageTitleRaw = null;
        const deviceOutputs = [];
        for (const device of devices) {
          const result = await createPdf(
            page,
            pageUrl,
            { width: device.width, height: device.height },
            { hideSticky, detachSelectors },
          );
          if (!pageTitleRaw) pageTitleRaw = result.titleRaw;
          deviceOutputs.push({ device, result });
        }

        const baseTitle = sanitizeFilePart(pageTitleRaw || "page");
        const currentCount = usedNames.get(baseTitle) || 0;
        usedNames.set(baseTitle, currentCount + 1);
        const suffix = currentCount === 0 ? "" : `_${currentCount + 1}`;
        const baseName = `${baseTitle}${suffix}`;

        const devicePreviews = [];
        for (const { device, result } of deviceOutputs) {
          const deviceMeta = deviceDirs.get(device.id);
          const deviceSlug = deviceMeta?.slug || sanitizeFilePart(device.id);
          const pdfName = `${baseName}_${deviceSlug}.pdf`;
          const previewName = `${baseName}_${deviceSlug}.jpg`;
          await fs.writeFile(
            path.join(deviceMeta?.dir || tempRoot, pdfName),
            result.pdf,
          );
          await fs.writeFile(path.join(previewDir, previewName), result.preview);
          devicePreviews.push({
            id: device.id,
            label: device.label,
            slug: deviceSlug,
            previewName,
          });

          if (result.detached?.length) {
            let detachedIndex = 1;
            for (const detached of result.detached) {
              const detachedName = `${baseName}_${deviceSlug}_detached_${detachedIndex}.png`;
              await fs.writeFile(
                path.join(detachedDir, detachedName),
                detached.buffer,
              );
              devicePreviews.push({
                id: `${device.id}_detached_${detachedIndex}`,
                label: `Detached ${device.label || device.id} ${detachedIndex}`,
                slug: deviceSlug,
                previewName: detachedName,
              });
              detachedIndex += 1;
            }
          }
        }

        const previewEntry = {
          id: baseName,
          title: baseName,
          displayTitle: pageTitleRaw || baseName,
          pageUrl,
          devices: devicePreviews,
        };
        previews.push(previewEntry);
        onPreview?.(previewEntry);
      } catch {
        // skip pages that fail
      } finally {
        completed += 1;
        onProgress?.({
          stage: "capture",
          message: `Captured ${completed}/${discoveredUrls.length} pages`,
          completed,
          total: discoveredUrls.length,
          currentUrl: pageUrl,
        });
      }
    }

    onProgress?.({
      stage: "zip",
      message: "Creating export ZIP…",
      completed,
      total: discoveredUrls.length,
    });

    const archiveName = `${sanitizeFilePart(
      new URL(normalizedUrl).hostname,
    )}_exports.zip`;
    const archivePath = path.join(tempRoot, archiveName);
    const deviceFolders = [...deviceDirs.values()].map((entry) => entry.slug);
    await execFileAsync(
      "zip",
      ["-r", archivePath, ...deviceFolders, "Detached"],
      {
      cwd: tempRoot,
      },
    );

    return { archiveName, archivePath, tempRoot, previews, devices };
  } finally {
    if (browser) await browser.close();
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/export/stream/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Export job not found." });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write("\n");
  job.clients.add(res);

  sendEvent(job, "progress", {
    stage: job.stage,
    message: job.message,
    completed: job.completed,
    total: job.total,
    currentUrl: job.currentUrl,
  });

  req.on("close", () => {
    job.clients.delete(res);
  });
});

app.get("/api/export/previews/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: "Export job not found." });
  }
  const items = (job.previews || []).map((item) => ({
    id: item.id,
    title: item.title,
    displayTitle: item.displayTitle || item.title,
    pageUrl: item.pageUrl,
    devices: (item.devices || []).map((device) => ({
      id: device.id,
      label: device.label,
      url: `/api/export/preview/${jobId}/${encodeURIComponent(
        device.previewName,
      )}`,
    })),
  }));
  return res.json({ items, devices: job.devices || [] });
});

app.get("/api/export/preview/:jobId/:fileName", async (req, res) => {
  const { jobId, fileName } = req.params;
  const job = jobs.get(jobId);
  if (!job || !job.tempRoot) {
    return res.status(404).json({ error: "Export job not found." });
  }
  const safeName = path.basename(fileName);
  const previewPath = path.join(job.tempRoot, "Previews", safeName);
  const detachedPath = path.join(job.tempRoot, "Detached", safeName);
  try {
    let buffer;
    let contentType = "image/jpeg";
    try {
      buffer = await fs.readFile(previewPath);
    } catch {
      buffer = await fs.readFile(detachedPath);
      contentType = "image/png";
    }
    res.setHeader("Content-Type", contentType);
    return res.send(buffer);
  } catch (error) {
    return res
      .status(404)
      .json({ error: error.message || "Preview not found." });
  }
});

app.post("/api/export/start", async (req, res) => {
  const { url, options } = req.body || {};

  if (!url || typeof url !== "string") {
    return res
      .status(400)
      .json({ error: "A sitemap or website URL is required." });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL." });
  }

  const jobId = randomUUID();
  const job = {
    id: jobId,
    stage: "queued",
    message: "Queued for processing…",
    completed: 0,
    total: 0,
    currentUrl: "",
    clients: new Set(),
    archiveName: null,
    archivePath: null,
    tempRoot: null,
    previews: [],
  };
  jobs.set(jobId, job);

  res.json({ jobId });

  try {
    updateJob(job, { stage: "starting", message: "Starting export…" });
    const result = await exportSite(
      normalizedUrl,
      options || {},
      (progress) => updateJob(job, progress),
      (previewEntry) => {
        job.previews = [...(job.previews || []), previewEntry];
        sendEvent(job, "preview", {
          item: previewEntry,
          jobId,
        });
      },
    );
    job.archiveName = result.archiveName;
    job.archivePath = result.archivePath;
    job.tempRoot = result.tempRoot;
    job.previews = result.previews || [];
    job.devices = result.devices || [];
    sendEvent(job, "done", { archiveName: job.archiveName });
  } catch (error) {
    sendEvent(job, "failed", {
      error: error.message || "Export generation failed.",
    });
  }

  setTimeout(() => {
    if (jobs.has(jobId)) {
      const existing = jobs.get(jobId);
      if (existing?.tempRoot) {
        fs.rm(existing.tempRoot, { recursive: true, force: true }).catch(
          () => {},
        );
      }
      jobs.delete(jobId);
    }
  }, JOB_TTL_MS);
});

app.get("/api/export/download/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job || !job.archivePath || !job.archiveName) {
    return res.status(404).json({ error: "Export file not found." });
  }

  try {
    const zipBuffer = await fs.readFile(job.archivePath);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${job.archiveName}"`,
    );
    res.send(zipBuffer);
  } catch (error) {
    res
      .status(500)
      .json({ error: error.message || "Failed to read export archive." });
  }
});

app.post("/api/export", async (req, res) => {
  const { url, options } = req.body || {};

  if (!url || typeof url !== "string") {
    return res
      .status(400)
      .json({ error: "A sitemap or website URL is required." });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL." });
  }

  let result;
  try {
    result = await exportSite(normalizedUrl, options || {});
    const zipBuffer = await fs.readFile(result.archivePath);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.archiveName}"`,
    );
    return res.send(zipBuffer);
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Export generation failed." });
  } finally {
    if (result?.tempRoot) {
      await fs
        .rm(result.tempRoot, { recursive: true, force: true })
        .catch(() => {});
    }
  }
});

app.get("/api/examine", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).json({ error: "A URL is required." });
  }

  let normalizedUrl;
  try {
    normalizedUrl = normalizeUrl(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL." });
  }

  try {
    const response = await fetch(normalizedUrl, { redirect: "follow" });
    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Failed to fetch: HTTP ${response.status}` });
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return res.status(400).json({ error: "URL did not return HTML." });
    }
    const html = await response.text();
    const baseUrl = response.url || normalizedUrl;
    const injected = injectExamineHtml(html, baseUrl);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(injected);
  } catch (error) {
    return res
      .status(500)
      .json({ error: error.message || "Failed to load URL." });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
