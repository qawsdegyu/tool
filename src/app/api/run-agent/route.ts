import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface AgentLog {
  level: 'info' | 'success' | 'warn' | 'error' | 'debug';
  message: string;
  ts: number;
}

export interface BigPipeParams {
  __dyn?: string;
  __hs?: string;
  __hsi?: string;
  __s?: string;
  __rev?: string | number;
  __req?: number;
  __spin_r?: string | number;
  __spin_b?: string;
  __spin_t?: string | number;
  __a?: string;
  jazoest?: string;
  fb_dtsg?: string;
  lsd?: string;
  [key: string]: string | number | undefined;
}

export interface InterceptedRequest {
  url: string;
  method: string;
  postData?: string;
  headers?: Record<string, string>;
  parsedParams?: Record<string, string>;
}

export interface AgentResult {
  logs: AgentLog[];
  bigpipeParams: BigPipeParams;
  interceptedRequests: InterceptedRequest[];
  htmlTokens: BigPipeParams;
  mergedParams: BigPipeParams;
  pageTitle: string;
  captchaDetected: boolean;
  formData?: Record<string, string>;
}

// ─── CDP WebSocket Helper ─────────────────────────────────────────────────────
class CDPSession {
  private ws: import('ws').WebSocket;
  private msgId = 1;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private eventHandlers = new Map<string, ((params: unknown) => void)[]>();
  private ready: Promise<void>;

  constructor(wsUrl: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WebSocket = require('ws');
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) {
        const handlers = this.eventHandlers.get(msg.method) ?? [];
        handlers.forEach((h) => h(msg.params));
      }
    });
  }

  async waitReady() { await this.ready; }

  send<T = unknown>(method: string, params?: object): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
  }

  on(event: string, handler: (params: unknown) => void) {
    const list = this.eventHandlers.get(event) ?? [];
    list.push(handler);
    this.eventHandlers.set(event, list);
  }

  close() { this.ws.close(); }
}

// ─── Param Extractors ─────────────────────────────────────────────────────────

/** Extract BigPipe params from a raw POST body string */
function parsePostBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    const params = new URLSearchParams(body);
    params.forEach((v, k) => { result[k] = v; });
  } catch { /* ignore */ }
  return result;
}

/** Extract BigPipe params from page HTML via regex */
function extractFromHtml(html: string): BigPipeParams {
  const out: BigPipeParams = {};
  const patterns: [keyof BigPipeParams, RegExp][] = [
    ['__dyn',    /"__dyn"\s*:\s*"([^"]+)"/],
    ['__hs',     /"__hs"\s*:\s*"([^"]+)"/],
    ['__hsi',    /"__hsi"\s*:\s*"([^"]+)"/],
    ['__s',      /"__s"\s*:\s*"([^"]+)"/],
    ['__rev',    /"__rev"\s*:\s*(\d+)/],
    ['__spin_r', /"\__spin_r"\s*:\s*(\d+)/],
    ['__spin_b', /"\__spin_b"\s*:\s*"([^"]+)"/],
    ['__spin_t', /"\__spin_t"\s*:\s*(\d+)/],
    ['jazoest',  /name="jazoest"\s+value="([^"]+)"/],
    ['lsd',      /name="lsd"\s+value="([^"]+)"/],
    ['fb_dtsg',  /name="fb_dtsg"[^>]*value="([^"]+)"/],
  ];
  for (const [key, rx] of patterns) {
    const m = html.match(rx);
    if (m) out[key] = m[1] as string;
  }
  // Also try DTSGInitialData style
  const dtsg = html.match(/"token"\s*:\s*"([^"]+)"/);
  if (dtsg && !out.fb_dtsg) out.fb_dtsg = dtsg[1];
  return out;
}

/** Pull BigPipe globals from the page via Runtime.evaluate */
async function extractFromPageRuntime(cdp: CDPSession, logs: AgentLog[]): Promise<BigPipeParams> {
  const out: BigPipeParams = {};
  try {
    const script = `(function() {
      try {
        var env = window.__env || window.Env || {};
        var site = window.SiteData || {};
        var r = {};
        ['__dyn','__hs','__hsi','__s','__rev','__spin_r','__spin_b','__spin_t'].forEach(k => {
          if (env[k] !== undefined) r[k] = String(env[k]);
          if (site[k] !== undefined) r[k] = String(site[k]);
        });
        // Try require
        try {
          var dtsg = require('DTSGInitialData') || require('DTSGInitData') || {};
          if (dtsg.token) r.fb_dtsg = dtsg.token;
        } catch(e) {}
        try {
          var envData = require('EnvironmentConfig') || {};
          ['__dyn','__hs','__hsi','__s','__rev','__spin_r','__spin_b','__spin_t'].forEach(k => {
            if (envData[k] !== undefined) r[k] = String(envData[k]);
          });
        } catch(e) {}
        // Also grab from __d registry if available
        if (window.__d) {
          try {
            var ld = window.__d['DTSGInitData'];
            if (ld && ld.exports && ld.exports.token) r.fb_dtsg = ld.exports.token;
          } catch(e) {}
        }
        return JSON.stringify(r);
      } catch(e) { return '{}'; }
    })()`;

    const res = await cdp.send<{ result: { value: string } }>('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    const parsed = JSON.parse(res.result.value || '{}');
    Object.assign(out, parsed);
    logs.push({ level: 'debug', message: `[Runtime] Extracted ${Object.keys(out).length} params from JS globals`, ts: Date.now() });
  } catch (e: unknown) {
    logs.push({ level: 'warn', message: `[Runtime] Could not eval page globals: ${(e as Error).message}`, ts: Date.now() });
  }
  return out;
}

// ─── Main POST Handler ────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const logs: AgentLog[] = [];
  const log = (level: AgentLog['level'], message: string) => {
    logs.push({ level, message, ts: Date.now() });
    console.log(`[${level.toUpperCase()}] ${message}`);
  };

  const interceptedRequests: InterceptedRequest[] = [];
  let htmlTokens: BigPipeParams = {};
  let bigpipeParams: BigPipeParams = {};

  let cdp: CDPSession | null = null;

  try {
    const body = await req.json();
    const cdpPort: number = body.port ?? 9222;
    const targetUrl: string = body.url ?? 'https://www.facebook.com';

    log('info', `Connecting to Chrome CDP on port ${cdpPort}…`);

    // 1. Get list of targets
    const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    if (!versionRes.ok) throw new Error(`CDP not reachable on port ${cdpPort}`);
    const targets: { webSocketDebuggerUrl?: string; url: string; type: string }[] =
      await versionRes.json();

    // Pick the first 'page' target that is a facebook tab, or just first page
    const fbTarget =
      targets.find((t) => t.type === 'page' && t.url.includes('facebook.com')) ??
      targets.find((t) => t.type === 'page') ??
      targets[0];

    if (!fbTarget?.webSocketDebuggerUrl) {
      throw new Error('No suitable browser tab found. Open Facebook first.');
    }

    log('info', `Found tab: ${fbTarget.url}`);
    cdp = new CDPSession(fbTarget.webSocketDebuggerUrl);
    await cdp.waitReady();
    log('success', 'CDP connected ✓');

    // 2. Enable domains
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    log('info', 'CDP domains enabled');

    // 3. Hook Network events to capture BigPipe params from REAL requests
    const seenRequestIds = new Set<string>();

    cdp.on('Network.requestWillBeSent', (params: unknown) => {
      const p = params as {
        requestId: string;
        request: { url: string; method: string; postData?: string; headers?: Record<string, string> };
      };
      const { url, method, postData, headers } = p.request;

      const isFbRequest =
        url.includes('facebook.com') &&
        (url.includes('/ajax/') || url.includes('/api/graphql') || url.includes('/support/') || method === 'POST');

      if (!isFbRequest || seenRequestIds.has(p.requestId)) return;
      seenRequestIds.add(p.requestId);

      const parsedParams = postData ? parsePostBody(postData) : {};
      interceptedRequests.push({ url, method, postData, headers, parsedParams });

      // Extract BigPipe params from request body
      const BIGPIPE_KEYS = ['__dyn','__hs','__hsi','__s','__rev','__req','__spin_r','__spin_b','__spin_t','__a','jazoest','fb_dtsg','lsd'];
      let extracted = 0;
      for (const key of BIGPIPE_KEYS) {
        if (parsedParams[key] && !bigpipeParams[key as keyof BigPipeParams]) {
          (bigpipeParams as Record<string, string>)[key] = parsedParams[key];
          extracted++;
        }
      }

      if (extracted > 0) {
        log('success', `[Network] Captured ${extracted} params from ${method} ${url.substring(0, 80)}`);
      }
    });

    // 4. Navigate to Facebook (or use current tab if already there)
    const currentUrl: { result: { value: string } } = await cdp.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });

    const isAlreadyOnFb = currentUrl.result.value?.includes('facebook.com');
    if (!isAlreadyOnFb) {
      log('info', `Navigating to ${targetUrl}…`);
      await cdp.send('Page.navigate', { url: targetUrl });
      await new Promise<void>((res) => {
        const timeout = setTimeout(res, 15000);
        cdp!.on('Page.loadEventFired', () => { clearTimeout(timeout); res(); });
      });
      log('success', 'Page loaded');
    } else {
      log('info', `Already on Facebook (${currentUrl.result.value.substring(0, 60)}), using current page`);
    }

    // 5. Wait a bit for XHR warmup requests to fire
    await new Promise((r) => setTimeout(r, 3000));

    // 6. Extract from page HTML
    log('info', 'Extracting tokens from page HTML…');
    const htmlResult: { result: { value: string } } = await cdp.send('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    const html = htmlResult.result.value ?? '';
    htmlTokens = extractFromHtml(html);
    log(
      Object.keys(htmlTokens).length > 0 ? 'success' : 'warn',
      `HTML tokens found: ${Object.keys(htmlTokens).join(', ') || 'none'}`
    );

    // 7. Extract from page JS runtime globals
    log('info', 'Extracting BigPipe params from JS runtime…');
    const runtimeParams = await extractFromPageRuntime(cdp, logs);
    log(
      Object.keys(runtimeParams).length > 0 ? 'success' : 'warn',
      `Runtime params found: ${Object.keys(runtimeParams).join(', ') || 'none'}`
    );

    // 8. Merge all sources: network (most accurate) > runtime > html
    const mergedParams: BigPipeParams = {
      ...htmlTokens,
      ...runtimeParams,
      ...bigpipeParams, // network-intercepted wins
    };

    // Ensure __req starts at 1 if not captured
    if (!mergedParams.__req) mergedParams.__req = 1;

    // 9. Detect CAPTCHA
    const captchaDetected =
      html.includes('captcha') ||
      html.includes('checkpoint') ||
      html.includes('are you a human') ||
      interceptedRequests.some((r) =>
        r.url.includes('captcha') || (r.parsedParams?.captcha_persist_data !== undefined)
      );

    log(captchaDetected ? 'warn' : 'info', captchaDetected ? '⚠️ CAPTCHA detected on page' : 'No CAPTCHA detected');

    const pageTitle: { result: { value: string } } = await cdp.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });

    log('success', `Done. Merged ${Object.keys(mergedParams).length} params total.`);

    return NextResponse.json({
      logs,
      bigpipeParams,
      interceptedRequests: interceptedRequests.slice(0, 30),
      htmlTokens,
      mergedParams,
      pageTitle: pageTitle.result.value ?? '',
      captchaDetected,
    } satisfies AgentResult);

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log('error', `Fatal: ${msg}`);
    return NextResponse.json({ logs, error: msg } as { logs: AgentLog[]; error: string }, { status: 500 });
  } finally {
    cdp?.close();
  }
}
