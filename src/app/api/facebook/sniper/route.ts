import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { port } = await request.json();
    const cdpPort = port || 9222;

    const WebSocket = require('ws');
    const versionRes = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await versionRes.json();
    
    const fbTarget = targets.find((t: any) => t.url.includes('facebook.com') && t.type === 'page') || targets.find((t: any) => t.type === 'page');
    
    if (!fbTarget) {
      return NextResponse.json({ success: false, error: 'No open tabs found in the browser.' });
    }

    const ws = new WebSocket(fbTarget.webSocketDebuggerUrl);
    
    // Wait for WebSocket to open
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

    // Enable Network domain
    ws.send(JSON.stringify({ id: 1, method: 'Network.enable' }));

    // Listen for the specific GraphQL request
    const sniperResult = await new Promise((resolve, reject) => {
      // Timeout after 60 seconds
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ success: false, error: 'Timeout: No GraphQL request captured after 60 seconds.' });
      }, 60000);

      ws.on('message', (msg: string) => {
        const parsed = JSON.parse(msg);
        if (parsed.method === 'Network.requestWillBeSent') {
          const req = parsed.params.request;
          if (req.url.includes('/api/graphql/') || req.url.includes('graphql')) {
            const postData = req.postData;
            if (postData && postData.includes('variables') && !postData.includes('crash_obid') && !postData.includes('triggerFlowId')) {
               clearTimeout(timeout);
               ws.close();
               
               try {
                 const decoded = decodeURIComponent(postData);
                 const params = new URLSearchParams(decoded);
                 
                 resolve({
                   success: true,
                   url: req.url,
                   doc_id: params.get('doc_id') || params.get('fb_api_req_friendly_name'),
                   variables: params.get('variables'),
                   raw: postData
                 });
               } catch (e: any) {
                 resolve({ success: false, error: 'Failed to decode payload: ' + e.message });
               }
            }
          }
        }
      });
    });

    return NextResponse.json(sniperResult);

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message, status: 500 });
  }
}
