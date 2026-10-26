#!/bin/sh
# loop.sh <runs> <test file> [name pattern]: runs one test file that many times from the current directory and counts the results.
pass=0; fail=0; log=$(mktemp)
for i in $(seq "$1"); do
  if node --test ${3:+--test-name-pattern="$3"} "$2" >"$log" 2>&1; then pass=$((pass+1)); else fail=$((fail+1)); grep -m3 -E "^\s+(expected|actual):|AssertionError|Error:" "$log" | tr -s ' ' | tr '\n' ' '; echo; fi
done
rm -f "$log"
echo "pass=$pass fail=$fail"
