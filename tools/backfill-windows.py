#!/usr/bin/env python3
"""Rebuild windows.json from Prometheus history of claude_usage_percent / resets_at (session).
Usage: backfill-windows.py <prometheus-url> [days] > windows.json"""
import json, sys, time, urllib.request, urllib.parse
P=sys.argv[1].rstrip("/"); days=float(sys.argv[2]) if len(sys.argv)>2 else 30
WINDOW=5*3600*1000; end=time.time(); start=end-days*86400; step=60
def qr(q):
    u=P+"/api/v1/query_range?"+urllib.parse.urlencode({"query":q,"start":start,"end":end,"step":step})
    r=json.load(urllib.request.urlopen(u,timeout=120))["data"]["result"]; return {int(t):float(v) for s in r for t,v in s["values"]}
pct=qr('max(claude_usage_percent{limit="session"})'); rst=qr('max(claude_usage_resets_at_seconds{limit="session"})')
windows={}
for t in sorted(pct):
    r=rst.get(t)
    if r is None: continue
    reset_ms=round(r*1000/60000)*60000; s=reset_ms-WINDOW
    windows[s]={"peak":max(windows.get(s,{"peak":0})["peak"],pct[t])}
# synthetic zeros for completed idle 5h stretches between windows
keys=sorted(windows)
for a,b in zip(keys,keys[1:]):
    t=a+WINDOW
    while t+WINDOW<=b: windows.setdefault(t,{"peak":0,"synthetic":True}); t+=WINDOW
print(json.dumps({str(k):v for k,v in sorted(windows.items())}))
