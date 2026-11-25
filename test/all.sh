#!/usr/bin/env bash
# Every test in docs/testing.md, each Worker stage on a fresh local Worker, with a one-line result per test.
# Usage: bash test/all.sh [name...]   (names as listed in the summary, e.g. main web chat-search; none runs all)
# Needs `npm ci` first. Ports 8787 and 9999 must be free. Not run: crash-1/crash-2 (watched by hand) and
# machine-e2e (it needs the desktop runner, see docs/testing.md).
cd "$(dirname "$0")/.."
DIR=$(mktemp -d "${TMPDIR:-/tmp}/resident-tests-XXXXXX")
export NO_PROXY=127.0.0.1,localhost WORKER_URL=http://127.0.0.1:8787 TEST_BASE_URL=http://127.0.0.1:8787
ONLY=" $* "
FAILED=()

want() { [ "$ONLY" = "  " ] || [[ "$ONLY" == *" $1 "* ]]; }
note() { if [ "$1" = 0 ]; then echo "ok    $2"; else echo "FAIL  $2  ($DIR/$2.log)"; FAILED+=("$2"); fi; }
check() { local name=$1; shift; timeout 900 "$@" > "$DIR/$name.log" 2>&1; note $? "$name"; }
# Started as jobs of their own (set -m), so stopping one stops what it started and nothing else on the machine.
MOCK= WRANGLER=
mock() { stop_mock; set -m; node test/mock-server.mjs > "$DIR/mock-$1.log" 2>&1 & MOCK=$!; set +m; sleep 1; }
stop_mock() { [ -n "$MOCK" ] && kill -- -"$MOCK" 2>/dev/null; MOCK=; sleep 0.3; }
up() {
  local name=$1 state=$2; shift 2
  set -m; npx wrangler dev --config wrangler.test.jsonc --port 8787 --persist-to "$state" "$@" > "$DIR/wrangler-$name.log" 2>&1 & WRANGLER=$!; set +m
  for _ in $(seq 1 150); do curl -s -o /dev/null -m 2 http://127.0.0.1:8787/ && return 0; sleep 1; done
  echo "the local Worker did not start: $DIR/wrangler-$name.log"
}
down() {
  [ -n "$WRANGLER" ] && kill -- -"$WRANGLER" 2>/dev/null; WRANGLER=
  for _ in $(seq 1 20); do curl -s -o /dev/null -m 1 http://127.0.0.1:8787/ || break; sleep 0.5; done
}
# One Worker stage: fresh state, the fake services, the Worker with its variables.
fresh() { local name=$1 cmd=$2; shift 2; want "$name" || return 0; mock "$name"; up "$name" "$DIR/state-$name" "$@"; check "$name" bash -c "$cmd"; down; }
# Two stages with the Worker restarted between them on the same state.
pair() {
  local name=$1 first=$2 second=$3; shift 3; want "$name" || return 0
  mock "$name"; up "$name" "$DIR/state-$name" "$@"; check "$name-1" bash -c "$first"; down
  up "$name-2" "$DIR/state-$name" "$@"; check "$name-2" bash -c "$second"; down
}
trap 'down; stop_mock' EXIT

want typecheck && check typecheck npm run -s typecheck
for file in test/*.mjs; do
  name=$(basename "$file" .mjs)
  case $name in run|mock-server|zip|machine-e2e|*-worker|letter-failures|native-tasks) continue ;; esac
  want "$name" && check "$name" node "$file"
done

for stage in main stickers voice voice-design tasks tasks-roles sites web residents group wecom; do fresh "$stage" "node test/run.mjs $stage"; done
fresh checkin "node test/run.mjs checkin" --var "CHECKIN_SCHEDULE:every 1 minute"
fresh idle "node test/run.mjs idle" --var LETTER_IDLE_MINUTES:0.05
fresh migrate "node test/run.mjs migrate" --var MODEL:fake
fresh no-model "node test/run.mjs no-model" --var AELIOS_URL:
fresh tasks-quiet "node test/run.mjs tasks-quiet" --var CLOUD_TASK_QUIET_MINUTES:0.05
fresh heartbeat "node test/run.mjs heartbeat" --var LETTER_IDLE_MINUTES:0.05 --var LETTER_TOKEN_THRESHOLD:100000 --var ALARM_MINUTE_SECONDS:0.05
fresh alarms "node test/run.mjs alarms" --var ALARM_MINUTE_SECONDS:0.05
fresh stall "node test/run.mjs stall" --var CHAT_STALL_SECONDS:2
fresh telegram "node test/run.mjs telegram" --var TG_BOT_TOKEN: --var TG_WEBHOOK_SECRET:
fresh menu "node test/run.mjs menu" --var TG_BOT_TOKEN: --var TG_WEBHOOK_SECRET: --local-upstream resident.test --upstream-protocol https
pair mcp "node test/run.mjs mcp" "node test/run.mjs mcp-2"
fresh mcp-cimd "node test/run.mjs mcp-cimd" --local-upstream resident.test --upstream-protocol https
pair voice-design-recovery "node test/run.mjs voice-design-recovery-1" "node test/run.mjs voice-design-recovery-2"
for test in history-worker box-worker chat-stop-worker chat-permissions-worker; do fresh "$test" "node test/$test.mjs"; done
fresh native-push-worker "node test/native-push-worker.mjs" --var FCM_SERVICE_ACCOUNT:not-json
fresh mini-app-worker "node test/mini-app.mjs worker"
fresh home-screen-worker "node test/home-screen.mjs worker"
fresh alarm-activity-worker "node test/alarm-activity-worker.mjs" --var ALARM_MINUTE_SECONDS:0.5
fresh proactive-call-worker "node test/proactive-call-worker.mjs" --var ALARM_MINUTE_SECONDS:0.5 --var PROACTIVE_CALL_RING_SECONDS:3 --var PROACTIVE_CALL_ONLINE_SECONDS:2
fresh letter-failures "node test/letter-failures.mjs"
pair letter-restart "node test/letter-failures.mjs restart-1" "node test/letter-failures.mjs restart-2"
pair native-tasks "node test/native-tasks.mjs first" "node test/native-tasks.mjs restart"
pair cache-history-worker "node test/cache-history-worker.mjs first" "node test/cache-history-worker.mjs restart"
pair gpt-session-worker "node test/gpt-session-worker.mjs first" "node test/gpt-session-worker.mjs restart"

echo
if [ ${#FAILED[@]} -eq 0 ]; then echo "all passed (logs in $DIR)"; else echo "${#FAILED[@]} failed: ${FAILED[*]}"; exit 1; fi
