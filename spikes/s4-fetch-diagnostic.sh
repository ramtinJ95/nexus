#!/usr/bin/env bash
# Run on the Mac. One bounded diagnostic retry after the first TLS timeout.
set -euo pipefail
curl --socks5-hostname localhost:1055 --connect-timeout 30 --max-time 45 -v -D- \
  -w '\nHTTP_STATUS=%{http_code} TOTAL_SECONDS=%{time_total}\n' \
  https://infra-testbench.example.ts.net:8443/
