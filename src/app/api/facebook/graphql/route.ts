import { NextResponse } from 'next/server';

// CDP Helper function
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

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { port, doc_id, variables, fbDtsg, lsd, accountId } = body;
    const cdpPort = port || 9222;

    const WebSocket = require('ws');
    const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await versionRes.json();
    let fbTarget = targets.find((t: any) => t.url.includes('facebook.com') && t.type === 'page');
    
    // If no Facebook tab exists, create one!
    if (!fbTarget) {
      console.log('No Facebook tab found. Creating one...');
      const newTabRes = await fetch(`http://127.0.0.1:${cdpPort}/json/new?https://www.facebook.com`);
      fbTarget = await newTabRes.json();
      
      // Wait a few seconds for the new tab to load cookies and session
      await new Promise(r => setTimeout(r, 3000));
    }
    
    if (!fbTarget) {
      return NextResponse.json({ success: false, error: 'Failed to create a Facebook tab in the CDP browser.' });
    }

    const ws = new WebSocket(fbTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    // Build GraphQL Payload
    const payload = new URLSearchParams();
    if (fbDtsg) payload.append('fb_dtsg', fbDtsg);
    payload.append('doc_id', doc_id);
    
    // Inject dynamic account ID if provided
    let finalVariables = variables;
    if (accountId) {
       // A simple regex to replace account IDs in the variables string if needed
       // finalVariables = finalVariables.replace(/"[0-9]{15,}"/g, `"${accountId}"`);
    }
    
    // Auto-extract fb_dtsg and lsd directly from the page!
    const tokenExtractionScript = `
      (function() {
        let dtsg = '';
        let lsdToken = '';
        
        // Try getting dtsg from require
        try {
          const dtsgObj = require('DTSGInitialData');
          if (dtsgObj && dtsgObj.token) dtsg = dtsgObj.token;
        } catch(e) {}
        
        if (!dtsg) {
          const match = document.body.innerHTML.match(/"DTSGInitialData",\\[\\],\\{"token":"([^"]+)"/);
          if (match) dtsg = match[1];
        }
        
        try {
          const lsdObj = require('LSD');
          if (lsdObj && lsdObj.token) lsdToken = lsdObj.token;
        } catch(e) {}
        
        if (!lsdToken) {
          const lsdMatch = document.body.innerHTML.match(/"LSD",\\[\\],\\{"token":"([^"]+)"/);
          if (lsdMatch) lsdToken = lsdMatch[1];
        }
        
        return JSON.stringify({ fb_dtsg: dtsg, lsd: lsdToken });
      })();
    `;
    const tokensResult: any = await sendCDP(ws, 'Runtime.evaluate', { expression: tokenExtractionScript, returnByValue: true });
    const tokens = JSON.parse(tokensResult?.value || "{}");
    
    const finalDtsg = fbDtsg || tokens.fb_dtsg || '';
    const finalLsd = lsd || tokens.lsd || '';

    const fetchScript = `
      new Promise(async (resolve) => {
        try {
          const payload = new URLSearchParams();
          ${finalDtsg ? `payload.append('fb_dtsg', \`${finalDtsg}\`);` : ''}
          ${finalLsd ? `payload.append('lsd', \`${finalLsd}\`);` : ''}
          payload.append('doc_id', \`${doc_id}\`);
          payload.append('variables', JSON.stringify(${finalVariables}));

          const res = await fetch("https://www.facebook.com/api/graphql/", {
            method: "POST",
            headers: { 
              "Content-Type": "application/x-www-form-urlencoded",
              "X-ASBD-ID": "129477",
              "X-FB-LSD": "${finalLsd || ''}",
              "Origin": "https://www.facebook.com",
              "Referer": "https://www.facebook.com/"
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

    const result: any = await sendCDP(ws, 'Runtime.evaluate', { expression: fetchScript, awaitPromise: true, returnByValue: true });
    ws.close();
    
    const fetchRes = JSON.parse(result?.value || "{}");
    if (fetchRes.error) throw new Error(fetchRes.error);

    return NextResponse.json({
      success: fetchRes.status === 200 && !fetchRes.text.toLowerCase().includes('error'),
      status: fetchRes.status,
      response: fetchRes.text.length > 1000 ? fetchRes.text.substring(0, 1000) : fetchRes.text
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message, status: 500 });
  }
}
