import http.client
import json

original = http.client.parse_headers

def log_headers(*args, **kwargs):
    parsed = original(*args, **kwargs)
    headers = {k: v for k, v in parsed.items()
               if k.lower().startswith('tailscale-user-') or k.lower() in ('host', 'x-forwarded-for', 'x-forwarded-proto')}
    print('GUEST_REQUEST_HEADERS=' + json.dumps(headers), flush=True)
    return parsed

http.client.parse_headers = log_headers
