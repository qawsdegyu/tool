import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────
interface SubmitBody {
  /** Port CDP is listening on (default 9222) */
  port?: number;
  /** The support form endpoint, e.g. https://www.facebook.com/help/contact/649167531904667 */
  formUrl: string;
  /** All fields for the form (including specific values like account_id, message, etc.) */
  formFields: Record<string, string>;
  /** BigPipe params captured from run-agent (merged params) */
  bigpipeParams: Record<string, string | number | undefined>;
  /** If true, send to web.facebook.com instead of www.facebook.com */
  useWebSubdomain?: boolean;
  /** CAPTCHA token if solving after challenge */
  captchaToken?: string;
  /** captcha_persist_data value from prior response */
  captchaPersistData?: string;
  /** Current __req counter (incremented per call) */
  reqCounter?: number;
  /** Manual cookies to override CDP live cookies */
  manualCookies?: string;
}

interface SubmitResult {
  success: boolean;
  status: number;
  responseText: string;
  submittedUrl: string;
  submittedBody: string;
  captchaRequired: boolean;
  captchaPersistData?: string;
  ticketId?: string;
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Get cookies from live Chrome tab via CDP */
async function getLiveCookies(port: number, domain: string): Promise<string> {
  try {
    const targetsRes = await fetch(`http://127.0.0.1:${port}/json`);
    const targets: { webSocketDebuggerUrl?: string; url: string; type: string }[] = await targetsRes.json();
    const tab = targets.find((t) => t.type === 'page' && t.url.includes('facebook.com')) ?? targets.find((t) => t.type === 'page');
    if (!tab?.webSocketDebuggerUrl) return '';

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require('ws');
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise<void>((r) => ws.on('open', r));

    const cookieResult = await new Promise<{ result: { cookies: { name: string; value: string; domain: string }[] } }>((res) => {
      ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [`https://${domain}`] } }));
      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === 1) res(msg.result as typeof cookieResult);
      });
    });
    ws.close();

    return cookieResult.result.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

/** Scrape BigPipe params (fb_dtsg, etc.) using manual cookies */
async function scrapeTokens(cookieStr: string, userAgent: string): Promise<Record<string, string>> {
  try {
    // We use mbasic.facebook.com because it always serves plain HTML with fb_dtsg in hidden inputs, bypassing JS challenges.
    const res = await fetch('https://mbasic.facebook.com/', {
      headers: {
        'Cookie': cookieStr,
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      }
    });
    const html = await res.text();
    
    const out: Record<string, string> = {};
    const patterns: [string, RegExp][] = [
      ['__dyn',    /"__dyn"\s*:\s*"([^"]+)"/],
      ['__hs',     /"__hs"\s*:\s*"([^"]+)"/],
      ['__hsi',    /"__hsi"\s*:\s*"([^"]+)"/],
      ['__s',      /"__s"\s*:\s*"([^"]+)"/],
      ['__rev',    /"__rev"\s*:\s*(\d+)/],
      ['__spin_r', /"\__spin_r"\s*:\s*(\d+)/],
      ['__spin_b', /"\__spin_b"\s*:\s*"([^"]+)"/],
      ['__spin_t', /"\__spin_t"\s*:\s*(\d+)/],
      ['lsd',      /name="lsd"\s*value="([^"]+)"/],
    ];
    for (const [key, rx] of patterns) {
      const m = html.match(rx);
      if (m) out[key] = m[1];
    }
    
    // fb_dtsg robust extraction
    const fbDtsgMatch = html.match(/name="fb_dtsg"\s*value="([^"]+)"/i) || 
                        html.match(/"DTSGInitialData"[^}]*"token"\s*:\s*"([^"]+)"/) ||
                        html.match(/\["DTSGInitData"[^}]*"token"\s*:\s*"([^"]+)"/);
    if (fbDtsgMatch) out.fb_dtsg = fbDtsgMatch[1];

    // jazoest robust extraction
    const jazoestMatch = html.match(/name="jazoest"\s*value="([^"]+)"/i) ||
                         html.match(/jazoest=(\d+)/);
    if (jazoestMatch) out.jazoest = jazoestMatch[1];
    
    return out;
  } catch {
    return {};
  }
}

/** Get User-Agent from Chrome */
async function getLiveUserAgent(port: number): Promise<string> {
  try {
    const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`);
    const v: { 'User-Agent'?: string } = await versionRes.json();
    return v['User-Agent'] ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  } catch {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
}

// ─── Main POST Handler ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const {
    port = 9222,
    formUrl,
    formFields = {},
    bigpipeParams = {},
    useWebSubdomain = false,
    captchaToken,
    captchaPersistData,
    reqCounter = 1,
    manualCookies,
  } = body;

  if (!formUrl) {
    return NextResponse.json({ error: 'formUrl is required' }, { status: 400 });
  }

  // Build the actual submission URL
  // Facebook's mobile/compat endpoint accepts both www and web subdomains
  let submitUrl = formUrl;
  if (useWebSubdomain) {
    submitUrl = submitUrl.replace('www.facebook.com', 'web.facebook.com');
  }

  // Normalize to /ajax/ submit endpoint — the contact form POSTs to the same URL
  // but with __a=1 for XHR mode (returns JSON instead of full page)
  const urlObj = new URL(submitUrl);

  // 1. Grab live cookies and User-Agent from Chrome
  const cookieStr = manualCookies || await getLiveCookies(port, urlObj.hostname);
  const userAgent = await getLiveUserAgent(port);

  // If we have cookies but no fb_dtsg, try to scrape it automatically
  if (cookieStr && !bigpipeParams['fb_dtsg']) {
    const scraped = await scrapeTokens(cookieStr, userAgent);
    Object.assign(bigpipeParams, scraped);
  }

  // 2. Build the full parameter set (BigPipe params first, then form fields, then captcha)
  const params: Record<string, string> = {};

  // BigPipe infrastructure params (THE FIX: these were missing before)
  const bpKeys = ['__dyn', '__hs', '__hsi', '__s', '__rev', '__spin_r', '__spin_b', '__spin_t', 'jazoest', 'lsd', 'fb_dtsg'] as const;
  for (const k of bpKeys) {
    const v = bigpipeParams[k];
    if (v !== undefined) params[k] = String(v);
  }

  // __req counter (increments per submission attempt — the missing piece!)
  params.__req = String(reqCounter);
  params.__a = '1';
  params.__be = '-1';
  params.__pc = 'PHASED:DEFAULT';

  // Form-specific fields
  Object.assign(params, formFields);

  // CAPTCHA resolution (only include if we have a token)
  if (captchaToken) {
    params['captcha[type]'] = 'resolved';
    params['captcha[value]'] = captchaToken;
    params['captcha_response'] = captchaToken;
    params.__req = String(reqCounter + 1); // bump req for resubmit
  }
  if (captchaPersistData) {
    params.captcha_persist_data = captchaPersistData;
  }

  const formBody = new URLSearchParams(params).toString();

  // 3. Build headers (mimicking what the browser would send)
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Cache-Control': 'no-cache',
    'Origin': `https://${urlObj.hostname}`,
    'Referer': submitUrl,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'User-Agent': userAgent,
    'X-FB-Friendly-Name': 'ContactFormSubmit',
    'X-ASBD-ID': '129477',
    'X-FB-LSD': params.lsd ?? '',
  };

  if (cookieStr) {
    headers['Cookie'] = cookieStr;
  }

  console.log('[submit-form] POST to:', submitUrl);
  console.log('[submit-form] params:', Object.keys(params).join(', '));

  // 4. Send the request
  let response: Response;
  try {
    response = await fetch(submitUrl, {
      method: 'POST',
      headers,
      body: formBody,
      redirect: 'follow',
    });
  } catch (fetchErr: unknown) {
    return NextResponse.json(
      { success: false, error: `Fetch failed: ${(fetchErr as Error).message}` },
      { status: 500 }
    );
  }

  const responseText = await response.text();
  const status = response.status;

  // 5. Detect CAPTCHA in response
  const captchaRequired =
    responseText.includes('captcha') ||
    responseText.includes('checkpoint') ||
    responseText.includes('"captcha_persist_data"') ||
    status === 503 || status === 429;

  // Extract captcha_persist_data from response for the next call
  let newCaptchaPersistData: string | undefined;
  const persistMatch = responseText.match(/"captcha_persist_data"\s*:\s*"([^"]+)"/);
  if (persistMatch) newCaptchaPersistData = persistMatch[1];

  // Try to extract Ticket ID from response
  let ticketId: string | undefined;
  const ticketMatch = responseText.match(/(?:ticket_id|support_case_id)=([0-9]+)/);
  if (ticketMatch) {
    ticketId = ticketMatch[1];
  } else {
    const redirectMatch = responseText.match(/"redirect_uri"\s*:\s*"([^"]+)"/);
    if (redirectMatch) {
      const parsedRedirect = redirectMatch[1].replace(/\\/g, '');
      const redirectUriMatch = parsedRedirect.match(/(?:ticket_id|support_case_id|id)=([0-9]+)/);
      if (redirectUriMatch) ticketId = redirectUriMatch[1];
    }
  }

  const result: SubmitResult = {
    success: !captchaRequired && status >= 200 && status < 400,
    status,
    responseText: responseText.substring(0, 5000), // limit size
    submittedUrl: submitUrl,
    submittedBody: formBody,
    captchaRequired,
    captchaPersistData: newCaptchaPersistData,
    ticketId,
  };

  return NextResponse.json(result);
}
