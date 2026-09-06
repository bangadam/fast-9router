#!/usr/bin/env python3
import json, time, sys, os, urllib.request, urllib.error

FAST = "http://127.0.0.1:20131"
NINE = "http://127.0.0.1:20128"
KEY9 = os.environ["ROUTER9_API_KEY"]
def parse_body(raw):
    """9router appends 'data: [DONE]' to non-stream JSON on one line. Handle both."""
    raw = raw.strip()
    for chunk in raw.split("data:"):
        chunk = chunk.strip()
        if chunk and chunk != "[DONE]":
            try: return json.loads(chunk)
            except Exception: continue
    return json.loads(raw)

def req(url, body, headers, timeout=120):
    t0 = time.time()
    r = urllib.request.Request(url, json.dumps(body).encode(), headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return time.time()-t0, resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return time.time()-t0, e.code, e.read().decode()[:300], {}
    except Exception as e:
        return time.time()-t0, None, str(e)[:200], {}

def bench_nonstream(label, url, model, key, n=3):
    lat, status, usage_ok, model_seen, content_ok = [], [], 0, None, 0
    for _ in range(n):
        dt, st, raw, _h = req(url + "/v1/chat/completions", {
            "model": model, "messages": [{"role":"user","content":"Reply with exactly one word: OK"}],
            "max_tokens": 10,
        }, {"Content-Type":"application/json","Authorization":"Bearer "+key})
        status.append(st)
        if st != 200:
            print(f"{label} nonstream: status={st} {raw[:100]}", flush=True); continue
        lat.append(dt*1000)
        try:
            d = parse_body(raw)
            u = d.get("usage") or {}
            ct = u.get("completion_tokens", u.get("output_tokens"))
            if ct is not None: usage_ok += 1
            model_seen = d.get("model")
            c = (d.get("choices") or [{}])[0].get("message",{}).get("content")
            if c and "OK" in c: content_ok += 1
        except Exception as e: print(f"{label} parse: {e}", flush=True)
    if not lat: return {"label":label, "error":"all failed", "statuses":status}
    lat.sort()
    return {"label":label,"statuses":status,"median_ms":round(lat[len(lat)//2]),
            "min_ms":round(lat[0]),"max_ms":round(lat[-1]),
            "usage_field":f"{usage_ok}/{len(lat)}","content_ok":f"{content_ok}/{len(lat)}",
            "saw_model":model_seen}

def bench_stream(label, url, model, key, n=2):
    out = []
    for i in range(n):
        t0 = time.time(); ttft = None; nc = 0; done = False
        r = urllib.request.Request(url + "/v1/chat/completions", json.dumps({
            "model": model, "stream": True,
            "messages": [{"role":"user","content":"Count from 1 to 5, digits separated by spaces."}],
            "max_tokens": 30,
        }).encode(), {"Content-Type":"application/json","Authorization":"Bearer "+key})
        try:
            with urllib.request.urlopen(r, timeout=120) as resp:
                for line_b in resp:
                    line = line_b.decode("utf-8","replace").strip()
                    if line.startswith("data:"):
                        nc += 1
                        if ttft is None: ttft = (time.time()-t0)*1000
                        if "[DONE]" in line: done = True
                e2e = (time.time()-t0)*1000
                out.append({"ttft_ms":round(ttft) if ttft else None,"e2e_ms":round(e2e),
                            "sse_events":nc,"done_sentinel":done})
        except Exception as e:
            out.append({"error":str(e)[:100]})
    return {"label":label+"_stream","runs":out}

def bench_tool(label, url, model, key):
    body = {
        "model": model, "max_tokens": 300,
        "messages": [{"role":"user","content":"What is the weather in Jakarta? Use the tool."}],
        "tools": [{"type":"function","function":{"name":"get_weather",
            "description":"Get current weather for a city",
            "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],
    }
    dt, st, raw, _ = req(url + "/v1/chat/completions", body,
                         {"Content-Type":"application/json","Authorization":"Bearer "+key})
    if st != 200: return {"label":label+"_tool","status":st,"result":"FAIL","raw":raw[:150]}
    try:
        d = parse_body(raw)
        msg = (d.get("choices") or [{}])[0].get("message",{})
        tc = msg.get("tool_calls") or []
        fn = tc[0].get("function") if tc else None
        args_ok = None
        if fn:
            try: args_ok = "akarta" in json.dumps(json.loads(fn["arguments"]))
            except Exception: args_ok = False
        return {"label":label+"_tool","status":st,"latency_ms":round(dt*1000),
                "tool_call":fn["name"] if fn else None,"args_valid":args_ok,
                "content_instead":(msg.get("content") or "")[:60] if not tc else None}
    except Exception as e:
        return {"label":label+"_tool","status":st,"parse_error":str(e)[:80],"raw":raw[:200]}

what = sys.argv[1] if len(sys.argv) > 1 else "all"
rows = []
if what in ("all","nonstream"):
    rows.append(bench_nonstream("fast-9router", FAST, "surplus/glm-5.3", "x", 3))
    rows.append(bench_nonstream("9router",     NINE, "dewa-glm",      KEY9, 3))
if what in ("all","stream"):
    rows.append(bench_stream("fast-9router", FAST, "surplus/glm-5.3", "x", 2))
    rows.append(bench_stream("9router",     NINE, "dewa-glm",      KEY9, 2))
if what in ("all","tool"):
    rows.append(bench_tool("fast-9router", FAST, "surplus/glm-5.3", "x"))
    rows.append(bench_tool("9router",     NINE, "dewa-glm",      KEY9))
print("RESULT_JSON")
print(json.dumps([r for r in rows if r], indent=1))
