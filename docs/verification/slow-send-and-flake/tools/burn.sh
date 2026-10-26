#!/bin/sh
# burn.sh <loops> <seconds>: that many busy shell loops, each ending after that many seconds.
for i in $(seq "$1"); do timeout "$2" sh -c 'while :; do :; done' & done
wait
