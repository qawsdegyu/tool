import sys
import json
import urllib.request
import urllib.parse
import re
import argparse

def get_chrome_cookies(port=9222):
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/json")
        with urllib.request.urlopen(req) as response:
            targets = json.loads(response.read().decode())
            
        tab = next((t for t in targets if t.get('type') == 'page'), None)
        
        if not tab or 'webSocketDebuggerUrl' not in tab:
            return ""

        import websocket # Requires pip install websocket-client
        ws = websocket.create_connection(tab['webSocketDebuggerUrl'])
        ws.send(json.dumps({
            "id": 1,
            "method": "Network.getCookies",
            "params": {"urls": ["https://www.facebook.com"]}
        }))
        
        result = json.loads(ws.recv())
        ws.close()
        
        cookies = result.get('result', {}).get('cookies', [])
        return "; ".join([f"{c['name']}={c['value']}" for c in cookies])
    except Exception as e:
        return ""

def scrape_tokens(cookies, user_agent):
    headers = {
        'Cookie': cookies,
        'User-Agent': user_agent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none'
    }
    try:
        req = urllib.request.Request("https://mbasic.facebook.com/", headers=headers)
        with urllib.request.urlopen(req) as response:
            html = response.read().decode()
        
        fb_dtsg = ""
        jazoest = ""
        
        dtsg_match = re.search(r'name="fb_dtsg"\s*value="([^"]+)"', html, re.IGNORECASE) or \
                     re.search(r'"DTSGInitialData"[^}]*"token"\s*:\s*"([^"]+)"', html)
        if dtsg_match:
            fb_dtsg = dtsg_match.group(1)
            
        jazoest_match = re.search(r'name="jazoest"\s*value="([^"]+)"', html, re.IGNORECASE) or \
                        re.search(r'jazoest=(\d+)', html)
        if jazoest_match:
            jazoest = jazoest_match.group(1)
            
        return fb_dtsg, jazoest
    except Exception as e:
        return "", ""

def submit_form(account_id, country, message, manual_cookies=None, fb_dtsg_manual=None, jazoest_manual=None):
    user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    cookies = manual_cookies if manual_cookies else get_chrome_cookies(9222)
    
    if not cookies:
        return {"success": False, "error": "No cookies found."}
        
    fb_dtsg = fb_dtsg_manual
    jazoest = jazoest_manual
    
    if not fb_dtsg or not jazoest:
        scraped_fb_dtsg, scraped_jazoest = scrape_tokens(cookies, user_agent)
        if not fb_dtsg: fb_dtsg = scraped_fb_dtsg
        if not jazoest: jazoest = scraped_jazoest

    if not fb_dtsg:
        return {"success": False, "error": "Could not extract fb_dtsg security token."}
        
    form_url = "https://www.facebook.com/help/contact/649167531904667"
    
    payload = {
        "jazoest": jazoest,
        "fb_dtsg": fb_dtsg,
        "__req": "1",
        "__a": "1",
        "account_id": account_id,
        "country": country,
        "message": message
    }
    
    data = urllib.parse.urlencode(payload).encode('utf-8')
    
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookies,
        'User-Agent': user_agent,
        'Origin': 'https://www.facebook.com',
        'Referer': form_url,
    }
    
    try:
        req = urllib.request.Request(form_url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req) as response:
            res_text = response.read().decode()
            status_code = response.getcode()
        
        ticket_id = None
        ticket_match = re.search(r'(?:ticket_id|support_case_id|id)=([0-9]+)', res_text.replace('\\', ''))
        if ticket_match:
            ticket_id = ticket_match.group(1)
            
        success = status_code == 200 and "error" not in res_text.lower()
        
        return {
            "success": success,
            "status": status_code,
            "ticketId": ticket_id,
            "response": res_text[:500]
        }
    except Exception as e:
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--account_id", required=True)
    parser.add_argument("--country", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--cookies", default="")
    parser.add_argument("--fb_dtsg", default="")
    parser.add_argument("--jazoest", default="")
    args = parser.parse_args()
    
    result = submit_form(args.account_id, args.country, args.message, args.cookies, args.fb_dtsg, args.jazoest)
    print(json.dumps(result))
