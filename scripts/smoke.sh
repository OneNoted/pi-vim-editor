#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

AGENT_DIR="${PI_CODING_AGENT_DIR:-$TMP_DIR/agent}"
mkdir -p "$AGENT_DIR"

if [[ -n "${PI_BIN:-}" ]]; then
  PI_BIN="$PI_BIN"
elif [[ -x "$EXT_DIR/node_modules/.bin/pi" ]]; then
  PI_BIN="$EXT_DIR/node_modules/.bin/pi"
else
  PI_BIN="pi"
fi

failures=0

run_case() {
  local name="$1"
  local input="$2"
  local log="$TMP_DIR/${name}.log"

  printf '%b' "$input" | timeout 10 script -qfec \
    "PI_CODING_AGENT_DIR='$AGENT_DIR' '$PI_BIN' --extension '$EXT_DIR/index.ts'" \
    "$log" >/dev/null 2>&1 || true

  if rg -n "TypeError|ReferenceError|RangeError|SyntaxError|Maximum call stack|error:" "$log" >/dev/null 2>&1; then
    echo "FAIL $name"
    sed -e 's/\x1b\[[0-9;?]*[A-Za-z]//g' \
        -e 's/\x1b\]8;;[^\a]*\a//g' \
        -e 's/\x1b\]0;[^\a]*\a//g' "$log" | tail -n 80
    failures=$((failures + 1))
  else
    echo "PASS $name"
  fi
}

# ctrl+c twice exits pi after clearing any editor contents.
EXIT_KEYS=$'\x03\x03'

run_case startup "$EXIT_KEYS"
run_case escape $'\x1b\x03\x03'
run_case insert_escape $'hello world\x1b\x03\x03'
run_case motions $'hello world\x1b0wbge;,\x03\x03'
run_case delete_word $'hello world\x1b0wdiw\x03\x03'
run_case change_word $'hello world\x1b0wciwtest\x1b\x03\x03'
run_case delete_line $'hello world\x1bdd\x03\x03'
run_case yank_paste $'hello world\x1b0yyPp\x03\x03'
run_case visual_delete $'hello world\x1b0veex\x03\x03'
run_case line_end_delete $'hello world\x1b0Dw\x03\x03'
run_case line_end_change $'hello world\x1b0Ctest\x1b\x03\x03'
run_case counted_text_object $'one two three\x1b02diw\x03\x03'
run_case undo $'hello world\x1b0xuu\x03\x03'

if [[ "$failures" -ne 0 ]]; then
  echo
  echo "$failures smoke test(s) failed."
  exit 1
fi

echo
echo "All smoke tests passed."
