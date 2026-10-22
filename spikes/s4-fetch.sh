#!/usr/bin/env bash
# Run on the Mac, not the testbench.
set -euo pipefail
curl --socks5-hostname localhost:1055 --connect-timeout 15 --max-time 30 -sS -D- \
  -w '\nHTTP_STATUS=%{http_code} TOTAL_SECONDS=%{time_total}\n' \
  https://infra-testbench.example.ts.net:8443/
