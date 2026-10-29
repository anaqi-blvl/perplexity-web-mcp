import type { Page } from "playwright";
import { ensureBrowser, getFirstPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const AUTH_CHECK_URL = "https://www.perplexity.ai/api/auth/session?version=2.18&source=default";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

interface Session {
  user?: { id: string; email?: string };
}

export async function checkSession(page: Page): Promise<boolean> {
  try {
    const response = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: "include" });
      return res.json();
    }, AUTH_CHECK_URL);

    const session = response as Session;
    if (session?.user?.id) return true;
  } catch {
    // fall through to the DOM check
  }

  // /api/auth/session returns {} even for a signed-in Pro account as of
  // 2026-10, which made this report "No active session" on a working login and
  // made the login tool hang for the full 5-minute poll. Treat the signed-in
  // profile avatar as the authoritative signal instead.
  try {
    return (await page.locator('img[alt="Profile avatar"]').count()) > 0;
  } catch {
    return false;
  }
}

export const AUTH_REQUIRED_MESSAGE =
  "Not signed in to Perplexity. Sign in once via the noVNC window " +
  "(http://192.168.2.67:6081/vnc.html, or http://100.98.63.36:6081/vnc.html over Tailscale), " +
  "then retry.";

/** Thrown instead of returning an empty answer when the session is signed out. */
export class PerplexityAuthError extends Error {
  constructor(message: string = AUTH_REQUIRED_MESSAGE) {
    super(message);
    this.name = "PerplexityAuthError";
  }
}

/**
 * Fails fast on a signed-out session.
 *
 * Without this, `search` opens the page, types the query, and waits out the full
 * timeout while Perplexity renders "Sign up and repeat your request" instead of
 * an answer — the client sees a 90s stall and an empty result rather than the
 * one thing it needs to know. Gate before typing instead.
 *
 * Only throws on a *positive* signed-out signal; an unrecognised page proceeds
 * as before, so a UI change can't silently break all searches.
 */
export async function assertAuthenticated(page: Page): Promise<void> {
  try {
    await page.locator('img[alt="Profile avatar"]').first().waitFor({ state: "visible", timeout: 6_000 });
    return;
  } catch {
    // No avatar — decide whether that means signed out or just a slow/unfamiliar page.
  }

  const signedOut = await page
    .evaluate(() => {
      const text = document.body.innerText || "";
      if (/sign up and repeat your request/i.test(text)) return true;
      if (/sign in to save your history/i.test(text)) return true;
      return Array.from(document.querySelectorAll("button, a")).some((el) =>
        /^\s*(sign in|log in|sign up)\s*$/i.test(el.textContent || "")
      );
    })
    .catch(() => false);

  if (signedOut) throw new PerplexityAuthError();
}

export async function ensureAuthenticated(): Promise<void> {
  await ensureBrowser();
  const page = await getFirstPage();
  await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });

  const authenticated = await checkSession(page);
  if (authenticated) {
    log("Session active.");
    return;
  }

  log("No active session. Please log in to Perplexity in the browser window...");
  await waitForLogin(page);
  log("Login detected.");
}

async function waitForLogin(page: Page): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const ok = await checkSession(page);
    if (ok) return;
  }
  throw new Error("Login timeout after 5 minutes.");
}
