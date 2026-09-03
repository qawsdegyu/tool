import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { accountId, country, message, reqCounter } = body;
    let { cookies, fbDtsg, jazoest } = body;

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    if (!cookies) {
      return NextResponse.json({ success: false, error: "Cookies are required.", status: 400 });
    }

    const formUrl = "https://www.facebook.com/help/contact/649167531904667";

    // 1. Scrape full BigPipe parameters from the actual form page
    const reqScrape = await fetch(formUrl, {
      headers: {
        "Cookie": cookies,
        "User-Agent": userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1"
      }
    });

    let html = await reqScrape.text();

    const extractPattern = (pattern: RegExp, source: string) => {
      const match = source.match(pattern);
      return match ? match[1] : "";
    };

    if (!fbDtsg) fbDtsg = extractPattern(/name="fb_dtsg"\s*value="([^"]+)"/i, html) || extractPattern(/"token"\s*:\s*"([^"]+)"/i, html);
    if (!jazoest) jazoest = extractPattern(/name="jazoest"\s*value="([^"]+)"/i, html) || extractPattern(/jazoest=(\d+)/i, html);

    // Fallback to mbasic if www failed to provide fb_dtsg
    if (!fbDtsg) {
      const fallbackReq = await fetch("https://mbasic.facebook.com/", {
        headers: {
          "Cookie": cookies,
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Upgrade-Insecure-Requests": "1",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Sec-Fetch-User": "?1"
        }
      });
      html = await fallbackReq.text();
      if (!fbDtsg) fbDtsg = extractPattern(/name="fb_dtsg"\s*value="([^"]+)"/i, html) || extractPattern(/"token"\s*:\s*"([^"]+)"/i, html);
      if (!jazoest) jazoest = extractPattern(/name="jazoest"\s*value="([^"]+)"/i, html) || extractPattern(/jazoest=(\d+)/i, html);
    }

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
    payload.append("__be", "-1");
    payload.append("__pc", "PHASED:DEFAULT");
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

    const resSubmit = await fetch(formUrl, {
      method: "POST",
      headers: {
        "Cookie": cookies,
        "User-Agent": userAgent,
        "Origin": "https://www.facebook.com",
        "Referer": formUrl,
        "X-FB-LSD": lsd || "",
        "X-ASBD-ID": "129477",
        "Content-Type": "application/x-www-form-urlencoded",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin"
      },
      body: payload.toString()
    });

    const resText = await resSubmit.text();
    const statusCode = resSubmit.status;

    let ticketId = null;
    const ticketMatch = resText.replace(/\\/g, "").match(/(?:ticket_id|support_case_id|id)=([0-9]+)/);
    if (ticketMatch) {
      ticketId = ticketMatch[1];
    }

    const success = statusCode === 200 && !resText.toLowerCase().includes("error");

    return NextResponse.json({
      success,
      status: statusCode,
      ticketId,
      response: resText.length > 500 ? resText.substring(0, 500) : resText
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message, status: 500 });
  }
}
