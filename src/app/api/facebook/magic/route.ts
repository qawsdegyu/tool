import { NextResponse } from 'next/server';

// ============================================
// CDP Helper function
// ============================================
const sendCDP = (ws: any, method: string, params: any = {}) => {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 100000);
    const listener = (msg: string) => {
      const parsed = JSON.parse(msg);
      if (parsed.id === id) {
        ws.removeListener('message', listener);
        if (parsed.error) reject(parsed.error);
        else resolve(parsed.result);
      }
    };
    ws.on('message', listener);
    ws.send(JSON.stringify({ id, method, params }));
  });
};

// ============================================
// Adaptive Rate Limiter with Profile Rotation
// ============================================
class AdaptiveRateLimiter {
  private queue: Array<{ resolve: (value: any) => void; reject: (reason: any) => void; delay: number; profileIndex: number }> = [];
  private interval: NodeJS.Timeout | null = null;
  private running = 0;
  private maxConcurrent = 1;
  private profileIndex = 0;
  private successCount = 0;
  private failureCount = 0;
  private baseDelay = 3000; // Base delay in ms
  private maxDelay = 15000; // Max delay after consecutive failures
  private failureStreak = 0;

  constructor(initialProfileIndex: number = 0) {
    this.profileIndex = initialProfileIndex;
  }

  setProfileIndex(profileIndex: number) {
    this.profileIndex = profileIndex;
  }

  // Add task to queue with current profile and adaptive delay
  enqueue() {
    const delay = this.calculateDelay();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject, delay, profileIndex: this.profileIndex });
      if (!this.interval) {
        this.interval = setInterval(() => this.processNext(), this.baseDelay);
      }
      // Try to process immediately if under concurrency limit
      if (this.running < this.maxConcurrent) {
        this.processNext();
      }
    });
  }

  private calculateDelay(): number {
    // Adaptive delay based on failure streak
    const exponentialBackoff = Math.min(
      this.baseDelay * Math.pow(1.5, this.failureStreak),
      this.maxDelay
    );
    // Add some randomness (±20%) to avoid exact patterns
    const jitter = exponentialBackoff * 0.2 * (Math.random() - 0.5);
    return Math.max(1000, Math.floor(exponentialBackoff + jitter));
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async processNext() {
    if (this.queue.length === 0) {
      clearInterval(this.interval!);
      this.interval = null;
      return;
    }

    const { resolve, reject, delay, profileIndex } = this.queue.shift()!;
    this.running++;

    try {
      // Update profile if different from current
      if (profileIndex !== this.profileIndex) {
        this.profileIndex = profileIndex;
        // Note: Profile switch would need to happen at API level
        // this.profileIndex = profileIndex;
      }

      this.failureStreak = 0; // Reset on attempt
      const result = await this.executeTask();
      this.successCount++;
      this.failureStreak = 0;
      resolve(result);
    } catch (err) {
      this.failureCount++;
      this.failureStreak++;
      this.successCount = 0;
      reject(err);
    } finally {
      this.running--;
      // Schedule next after delay
      setTimeout(() => this.processNext(), delay);
    }
  }

  private async executeTask() {
    // This will be overridden per use case
    // For CDP automation, the actual work happens in the API handler
    return Promise.resolve();
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

// ============================================
// Export API
// ============================================
export async function POST(request: Request) {
  try {
    const body = await request.json();
    
    // Configuration from body (all optional with defaults)
    const {
      port,                  // Chrome CDP port (default: 9222)
      accountId,             // Facebook Account ID
      message,               // Support message
      cookies,               // Optional cookies (leave blank if Chrome logged in)
      useGraphQL = true,     // Use GraphQL wizard bypass
      profileIndex = 0,      // Which Chrome profile to use (0, 1, 2, 3)
      delay = 3000,          // Base delay between requests in ms
      retryCount = 2,        // Number of retry attempts
      retryDelay = 5000      // Delay between retries in ms
    } = body;

    // Define Chrome profiles configuration
    const chromeProfiles = [
      { port: 9222, label: 'default' },
      { port: 9223, label: 'profile2' },
      { port: 9224, label: 'profile3' },
      { port: 9225, label: 'profile4' }
    ];

    // Select profile
    const targetProfile = chromeProfiles[profileIndex % chromeProfiles.length];
    const cdpPort = targetProfile?.port || (port || 9222);

    // ============================================
    // 1. Connect to Chrome CDP
    // ============================================
    const WebSocket = require('ws');
    const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    if (!versionRes.ok) {
      return NextResponse.json({ 
        success: false, 
        error: `CDP not reachable on port ${cdpPort}. Make sure Chrome is open with --remote-debugging-port=${cdpPort}` 
      });
    }
    const targets = await versionRes.json();

    let fbTarget = targets.find((t: any) => t.url.includes('facebook.com') && t.type === 'page');
    
    // Auto-create Facebook tab if missing
    if (!fbTarget) {
      const newTabRes = await fetch(`http://127.0.0.1:${cdpPort}/json/new?https://www.facebook.com`);
      fbTarget = await newTabRes.json();
    }
    
    if (!fbTarget) return NextResponse.json({ success: false, error: 'Failed to access browser tab.' });

    const ws = new WebSocket(fbTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    // Wait for page to finish loading
    await sendCDP(ws, 'Network.enable');

    // ============================================
    // 3. Set cookies if provided
    // ============================================
    if (cookies && cookies.trim().length > 0) {
      const cookieParams = cookies.split(';').map((c: string) => c.trim()).filter((c: string) => c).map((c: string) => {
        const [name, ...rest] = c.split('=');
        return { name: name.trim(), value: rest.join('=').trim(), domain: '.facebook.com', path: '/' };
      });
      if (cookieParams.length > 0) {
        await sendCDP(ws, 'Network.setCookies', { cookies: cookieParams });
        await sendCDP(ws, 'Page.enable');
        await sendCDP(ws, 'Page.reload');
        // Wait for page to reload - use a simple wait
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // ============================================
    // 3. Auto-extract necessary tokens
    // ============================================
    const tokenExtractionScript = `
      (function() {
        let dtsg = ''; let lsdToken = ''; let c_user = '';
        try { const dtsgObj = require('DTSGInitialData'); if (dtsgObj && dtsgObj.token) dtsg = dtsgObj.token; } catch(e) {}
        if (!dtsg) { const match = document.body.innerHTML.match(/"DTSGInitialData",\\[\\],\\{"token":"([^"]+)"/); if (match) dtsg = match[1]; }
        try { const lsdObj = require('LSD'); if (lsdObj && lsdObj.token) lsdToken = lsdObj.token; } catch(e) {}
        if (!lsdToken) { const lsdMatch = document.body.innerHTML.match(/"LSD",\\[\\],\\{"token":"([^"]+)"/); if (lsdMatch) lsdToken = lsdMatch[1]; }
        const c_userMatch = document.cookie.match(/c_user=(\\d+)/);
        if (c_userMatch) c_user = c_userMatch[1];
        
        // Also extract BigPipe params needed for GraphQL
        var bigpipe = {};
        try {
          if (window.__d) {
            try { bigpipe.__dyn = window.__d.dyn || window.__d.__dyn; } catch(e) {}
            try { bigpipe.__hs = window.__d.hs || window.__d.__hs; } catch(e) {}
            try { bigpipe.__hsi = window.__d.hsi || window.__d.__hsi; } catch(e) {}
            try { bigpipe.__s = window.__d.s || window.__d.__s; } catch(e) {}
            try { bigpipe.__rev = window.__d.rev || window.__d.__rev; } catch(e) {}
            try { bigpipe.__spin_r = window.__d.spin_r || window.__d.__spin_r; } catch(e) {}
          }
        } catch(e) {}
        
        return JSON.stringify({ fb_dtsg: dtsg, lsd: lsdToken, c_user, bigpipe });
      })();
    `;
    const tokensResult: any = await sendCDP(ws, 'Runtime.evaluate', { expression: tokenExtractionScript, returnByValue: true });
    const parsed = JSON.parse(tokensResult?.value || "{}");
    const tokens = {
      fb_dtsg: parsed.fb_dtsg,
      lsd: parsed.lsd,
      c_user: parsed.c_user,
      bigpipe: parsed.bigpipe || {}
    };

    if (!tokens.fb_dtsg) {
       ws.close();
       return NextResponse.json({ success: false, error: 'Could not extract fb_dtsg. Make sure the account is logged in.' });
    }

    // ============================================
    // 4. Prepare GraphQL Payload (Wizard Bypass)
    // ============================================
    const doc_id = "24326992586955456";
    const finalVariables = {
      input: {
        actor_id: tokens.c_user || accountId,
        client_mutation_id: "1",
        context: [
          {context_key: "CHANNEL", context_value: "HELP_TRAY_SIMPLE_INTERFACE"},
          {context_key: "SI_PLAN_ID", context_value: "3728309477453541"},
          {context_key: "SI_ASSET_ID", context_value: accountId || ""},
          {context_key: "SI_SYMPTOM_ID", context_value: ""},
          {context_key: "SI_ASSET_TYPE", context_value: "AD_ACCOUNT"},
          {context_key: "SI_LBD_CALLER", context_value: "HELP_TRAY_BILLING_HUB"},
          {context_key: "SI_SUBMIT_BUTTON_STATUS", context_value: "Not Shown"},
          {context_key: "SI_ARTICLE_ID", context_value: ""},
          {context_key: "SI_TREATMENT_ID", context_value: "1260409297951604"},
          {context_key: "APPLICATION", context_value: "BUSINESS_SUITE_HOME"}
        ],
        page: { questions: ["1297850557763252"] },
        question_answers: [
          {
            answers: [{answer_string: message || "Support requested", answer_value: 0}],
            question_id: "1297850557763252"
          }
        ],
        response_id: "1546411663351533",
        survey_id: "1595655417954960"
      }
    };

    // ============================================
    // 5. Build GraphQL fetch script
    // ============================================
    const fetchScript = `
      new Promise(async (resolve) => {
        try {
          const payload = new URLSearchParams();
          ${tokens.fb_dtsg ? `payload.append('fb_dtsg', \`${tokens.fb_dtsg}\`);` : ''}
          ${tokens.lsd ? `payload.append('lsd', \`${tokens.lsd}\`);` : ''}
          payload.append('doc_id', \`${doc_id}\`);
          
          // Inject variables safely
          payload.append('variables', JSON.stringify(finalVariables));

          // Append BigPipe params if available
          ${tokens.bigpipe.__dyn ? `payload.append('__dyn', \`${tokens.bigpipe.__dyn}\`);` : ''}
          ${tokens.bigpipe.__hs ? `payload.append('__hs', \`${tokens.bigpipe.__hs}\`);` : ''}
          ${tokens.bigpipe.__hsi ? `payload.append('__hsi', \`${tokens.bigpipe.__hsi}\`);` : ''}
          ${tokens.bigpipe.__s ? `payload.append('__s', \`${tokens.bigpipe.__s}\`);` : ''}
          ${tokens.bigpipe.__rev ? `payload.append('__rev', \`${tokens.bigpipe.__rev}\`);` : ''}
          ${tokens.bigpipe.__spin_r ? `payload.append('__spin_r', \`${tokens.bigpipe.__spin_r}\`);` : ''}

          const res = await fetch("https://www.facebook.com/api/graphql/", {
            method: "POST",
            headers: { 
              "Content-Type": "application/x-www-form-urlencoded",
              "X-ASBD-ID": "129477",
              "X-FB-LSD": "${tokens.lsd || ''}",
              "X-FB-Friendly-Name": "HelpTraySubmitMutation",
              "Origin": "https://www.facebook.com",
              "Referer": "https://www.facebook.com/",
              "Sec-Fetch-Dest": "empty",
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
              "Accept": "*/*"
            },
            body: payload,
            credentials: "include"
          });
          const text = await res.text();
          resolve(JSON.stringify({ status: res.status, text: text }));
        } catch(e) {
          resolve(JSON.stringify({ error: e.message }));
        }
      })
    `;

    // ============================================
    // 6. Execute fetch via CDP
    // ============================================
    const result: any = await sendCDP(ws, 'Runtime.evaluate', { expression: fetchScript, awaitPromise: true, returnByValue: true });
    ws.close();
    
    const fetchRes = JSON.parse(result?.value || "{}");
    if (fetchRes.error) throw new Error(fetchRes.error);

    return NextResponse.json({
      success: fetchRes.status === 200 && !fetchRes.text.toLowerCase().includes('error'),
      status: fetchRes.status,
      response: fetchRes.text.length > 500 ? fetchRes.text.substring(0, 500) + '...' : fetchRes.text
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message, status: 500 });
  }
}