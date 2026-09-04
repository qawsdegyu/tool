import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { accountId, country, message, reqCounter, captchaToken, port } = body;
    let { cookies, fbDtsg, jazoest, formUrl } = body;

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    if (!cookies) {
      return NextResponse.json({ success: false, error: "Cookies are required.", status: 400 });
    }

    if (!formUrl) {
      formUrl = "https://www.facebook.com/help/contact/649167531904667";
    }

    let html = "";
    let cdpWs: any = null;
    let usedCDP = false;
    
    // CDP Helper
    const sendCDP = (ws: any, method: string, params: any = {}) => new Promise<any>((resolve) => {
      const id = Math.floor(Math.random() * 100000);
      const listener = (data: any) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          ws.removeListener('message', listener);
          resolve(msg.result);
        }
      };
      ws.on('message', listener);
      ws.send(JSON.stringify({ id, method, params }));
    });

    if (port) {
      try {
        const WebSocket = require('ws');
        const versionRes = await fetch(`http://127.0.0.1:${port}/json`);
        const targets: any[] = await versionRes.json();
        const fbTarget = targets.find((t: any) => t.type === 'page' && t.url.includes('facebook.com')) || targets.find((t: any) => t.type === 'page');
        
        if (fbTarget?.webSocketDebuggerUrl) {
          usedCDP = true;
          cdpWs = new WebSocket(fbTarget.webSocketDebuggerUrl);
          await new Promise((res, rej) => { cdpWs.on('open', res); cdpWs.on('error', rej); });
          
          let currentUrlResult: any = await sendCDP(cdpWs, 'Runtime.evaluate', { expression: 'location.href', returnByValue: true });
          if (!currentUrlResult?.value?.includes('facebook.com')) {
            await sendCDP(cdpWs, 'Page.navigate', { url: formUrl });
            await new Promise(r => setTimeout(r, 4000)); // wait for navigation
          }
          
          // Scrape HTML directly from the live Chrome tab
          const htmlResult: any = await sendCDP(cdpWs, 'Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
          html = htmlResult?.value || "";
        }
      } catch (e) {
        console.log("CDP connection failed for scraping, falling back to Node fetch", e);
        usedCDP = false;
      }
    }

    if (!usedCDP) {
      // 1. Scrape via Node.js fetch (Fallback)
      const reqScrape = await fetch(formUrl, {
        headers: {
          "Cookie": cookies,
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Cache-Control": "max-age=0",
          "Sec-Ch-Prefers-Color-Scheme": "dark",
          "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1"
        }
      });
      html = await reqScrape.text();
    }

    const extractPattern = (pattern: RegExp, source: string) => {
      const match = source.match(pattern);
      return match ? match[1] : "";
    };

    if (!fbDtsg) fbDtsg = extractPattern(/name="fb_dtsg"\s*value="([^"]+)"/i, html) || extractPattern(/"token"\s*:\s*"([^"]+)"/i, html);
    if (!jazoest) jazoest = extractPattern(/name="jazoest"\s*value="([^"]+)"/i, html) || extractPattern(/jazoest=(\d+)/i, html);

    if (!fbDtsg) {
      return NextResponse.json({ success: false, error: "Could not extract fb_dtsg. Cookies might be invalid or expired.", status: 400 });
    }

    // BigPipe Params extraction
    const dyn = extractPattern(/"__dyn"\s*:\s*"([^"]+)"/i, html);
    const hs = extractPattern(/"__hs"\s*:\s*"([^"]+)"/i, html);
    const hsi = extractPattern(/"__hsi"\s*:\s*"([^"]+)"/i, html);
    const s = extractPattern(/"__s"\s*:\s*"([^"]+)"/i, html);
    const rev = extractPattern(/"__rev"\s*:\s*(\d+)/i, html);
    const spinR = extractPattern(/"__spin_r"\s*:\s*(\d+)/i, html);
    const spinB = extractPattern(/"__spin_b"\s*:\s*"([^"]+)"/i, html);
    const spinT = extractPattern(/"__spin_t"\s*:\s*(\d+)/i, html);
    const lsd = extractPattern(/name="lsd"\s*value="([^"]+)"/i, html);

    const reqId = reqCounter > 0 ? reqCounter.toString() : Math.floor(Math.random() * 90 + 10).toString();

    // 2. Submit form with ALL parameters
    const payload = new URLSearchParams();
    payload.append("jazoest", jazoest);
    payload.append("fb_dtsg", fbDtsg);
    payload.append("__req", reqId);
    payload.append("__a", "1");
    payload.append("__be", "1");
    payload.append("__pc", "PHASED:DEFAULT");
    payload.append("__d", "www");
    payload.append("account_id", accountId || "");
    payload.append("country", country || "");
    payload.append("message", message || "");

    if (dyn) payload.append("__dyn", dyn);
    if (hs) payload.append("__hs", hs);
    if (hsi) payload.append("__hsi", hsi);
    if (s) payload.append("__s", s);
    if (rev) payload.append("__rev", rev);
    if (spinR) payload.append("__spin_r", spinR);
    if (spinB) payload.append("__spin_b", spinB);
    if (spinT) payload.append("__spin_t", spinT);
    if (lsd) payload.append("lsd", lsd);

    let resText = "";
    let statusCode = 200;
    let redirectUrl = null;

    if (usedCDP && cdpWs) {
      try {
        // Inject JS into the browser to do the fetch
        const fetchScript = `
          new Promise(async (resolve) => {
            try {
              const res = await fetch("${formUrl}", {
                method: "POST",
                headers: { 
                  "Content-Type": "application/x-www-form-urlencoded",
                  "X-ASBD-ID": "129477",
                  "X-FB-LSD": "${lsd || ''}",
                  "Origin": "https://www.facebook.com",
                  "Referer": "${formUrl}"
                },
                body: "${payload.toString().replace(/"/g, '\\"')}",
                redirect: "manual",
                credentials: "include"
              });
              const text = await res.text();
              resolve(JSON.stringify({ status: res.status, url: res.url, redirected: res.redirected, text: text, headers: [...res.headers] }));
            } catch(e) {
              resolve(JSON.stringify({ error: e.message }));
            }
          })
        `;
        const result: any = await sendCDP(cdpWs, 'Runtime.evaluate', { expression: fetchScript, awaitPromise: true, returnByValue: true });
        cdpWs.close();
        
        const fetchRes = JSON.parse(result?.value || "{}");
        if (fetchRes.error) throw new Error(fetchRes.error);
        
        resText = fetchRes.text || "";
        statusCode = fetchRes.status || 200;
        if (statusCode >= 300 && statusCode < 400) {
          redirectUrl = fetchRes.headers?.find((h: any) => h[0].toLowerCase() === 'location')?.[1] || "Redirected";
        }
      } catch (e) {
         console.log("CDP execution failed", e);
         usedCDP = false;
      }
    }

    if (!usedCDP) {
      const resSubmit = await fetch(formUrl, {
        method: "POST",
        headers: {
          "Cookie": cookies,
          "User-Agent": userAgent,
          "Accept": "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Origin": "https://www.facebook.com",
          "Priority": "u=1, i",
          "Referer": formUrl,
          "Sec-Ch-Prefers-Color-Scheme": "dark",
          "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          "X-ASBD-ID": "129477",
          "X-FB-LSD": lsd || "",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: payload.toString(),
        redirect: "manual"
      });

      resText = await resSubmit.text();
      statusCode = resSubmit.status;
      redirectUrl = resSubmit.headers.get("location");
    }

    // Detect Facebook captcha response
    let captchaRequired = false;
    let captchaPersistData: string | null = null;
    if (resText.includes('captcha_persist_data')) {
      captchaRequired = true;
      const match = resText.match(/captcha_persist_data[^>]*>\s*([^<]+)\s*<\/[^>]+>/i);
      if (match) captchaPersistData = match[1].trim();
    }

    let ticketId = null;
    const cleanText = resText.replace(/\\/g, "");
    const ticketMatch = cleanText.match(/(?:ticket_id|support_case_id)=([0-9]+)/);
    if (ticketMatch) {
      ticketId = ticketMatch[1];
    } else {
      const redirectMatch = cleanText.match(/"redirect_uri"\s*:\s*"([^"]+)"/);
      if (redirectMatch) {
        const redirectUriMatch = redirectMatch[1].match(/(?:ticket_id|support_case_id|id)=([0-9]+)/);
        if (redirectUriMatch) ticketId = redirectUriMatch[1];
      }
    }

    const success = statusCode === 200 && (ticketId !== null || (!resText.toLowerCase().includes("error") && !captchaRequired));

    let parsedResponse = resText;
    try {
        if (resText.startsWith('for (;;);')) {
            const clean = resText.replace('for (;;);', '');
            const jsonObj = JSON.parse(clean);
            if (jsonObj.errorSummary || jsonObj.errorDescription) {
                parsedResponse = `${jsonObj.errorSummary || ''} - ${jsonObj.errorDescription || ''}`;
            } else {
                parsedResponse = JSON.stringify(jsonObj, null, 2);
            }
        }
    } catch(e) {}

    return NextResponse.json({
      success,
      status: statusCode,
      ticketId,
      redirectUrl,
      response: parsedResponse.length > 1000 ? parsedResponse.substring(0, 1000) : parsedResponse,
      captchaRequired,
      captchaPersistData,
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message, status: 500 });
  }
}
