#!/usr/bin/env bash
# Orchestrate one independent Grok headless session per source file.
# Default mode is review-only. Pass --fix to apply confirmed defects.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
STATE_DIR="$ROOT/.grok-reviews"
DEFAULT_FILES="$SCRIPT_DIR/FILES.txt"
DOMAIN_PROMPT="$SCRIPT_DIR/PROMPT.md"
SESSION_PROMPT="$SCRIPT_DIR/SESSION.md"
PARSE_RESULT="$SCRIPT_DIR/parse.result.ts"

DOMAIN_ORDER=(core math io astronomy imaging astrometry catalogs bindings devices adapters observation)

MODE=review
FORCE=0
DRY_RUN=0
SHOW_STATUS=0
REFRESH=0
MAX_TURNS=60
TIMEOUT_SEC=0
MODEL=""
EFFORT=high
ALLOW_SUBAGENTS=0
FILES_PATH=""
LIMIT=0
POSITIONAL=()

usage() {
	cat <<EOF
Usage: $(basename "$0") [options] [--] [file ...]

Run one fresh \`grok -p\` process per source file. Sessions are not resumed.

Options:
  --fix                 Apply confirmed HIGH/CRITICAL/real MEDIUM fixes
  --force               Re-run files already recorded as completed
  --dry-run             Print the planned files and exit
  --status              Show progress from $STATE_DIR
  --refresh-list        Regenerate $DEFAULT_FILES and exit
  --files PATH          File list (default: $DEFAULT_FILES)
  --limit N             Review at most N pending files
  --max-turns N         Grok turn fuse (default: 60)
  --timeout-sec N       Kill a session after N seconds (GNU timeout)
  --model ID            Grok model id
  --effort LEVEL        Reasoning effort (default: high)
  --allow-subagents     Allow Grok to spawn subagents
  -h, --help            Show this help

State is stored in $STATE_DIR (gitignored). Ctrl+C leaves the current
file uncompleted so the next run can retry it.
EOF
}

die() {
	echo "$1" >&2
	exit 1
}

require_file() {
	[[ -f "$1" ]] || die "File not found: $1"
}

is_comment_or_blank() {
	[[ "$1" =~ ^[[:space:]]*$ || "$1" =~ ^[[:space:]]*# ]]
}

safe_name() {
	printf '%s' "$1" | tr '/ ' '__'
}

append_unique() {
	local file="$1"
	local line="$2"
	mkdir -p "$(dirname "$file")"
	touch "$file"
	grep -Fxq "$line" "$file" 2>/dev/null && return
	printf '%s\n' "$line" >> "$file"
}

remove_line() {
	local file="$1"
	local line="$2"
	[[ -f "$file" ]] || return
	local tmp="$file.tmp.$$"
	grep -Fxv "$line" "$file" > "$tmp" || true
	mv "$tmp" "$file"
}

refresh_list() {
	local out="$1"
	local dir
	{
		echo "# Primary source files for per-file Grok review."
		echo "# Comment a line with # or delete it to skip. Blank lines are ignored."
		echo "# Regenerate with: ./scripts/review/review.sh --refresh-list"
		echo
		for dir in "${DOMAIN_ORDER[@]}"; do
			echo "# --- src/${dir} ---"
			find "$ROOT/src/$dir" -type f -name '*.ts' ! -name '*.data.ts' \
				| sed "s|^$ROOT/||" \
				| sort
			if [[ "$dir" != "${DOMAIN_ORDER[-1]}" ]]; then
				echo
			fi
		done
	} > "$out"
}

read_list() {
	local path="$1"
	local line
	while IFS= read -r line || [[ -n "$line" ]]; do
		line="${line%$'\r'}"
		is_comment_or_blank "$line" && continue
		printf '%s\n' "$line"
	done < "$path"
}

count_nonempty_lines() {
	local file="$1"
	[[ -f "$file" ]] || { echo 0; return; }
	grep -cve '^[[:space:]]*$' "$file" || true
}

show_status() {
	local completed failed skipped remaining=0
	completed="$(count_nonempty_lines "$STATE_DIR/COMPLETED.txt")"
	failed="$(count_nonempty_lines "$STATE_DIR/FAILED.txt")"
	skipped="$(count_nonempty_lines "$STATE_DIR/SKIPPED.txt")"
	if [[ -f "$DEFAULT_FILES" ]]; then
		local total pending
		total="$(read_list "$DEFAULT_FILES" | wc -l)"
		pending="$total"
		if [[ -f "$STATE_DIR/COMPLETED.txt" ]]; then
			pending="$(
				comm -23 \
					<(read_list "$DEFAULT_FILES" | sed 's|^|review |' | sort) \
					<(awk '{print $1 " " $2}' "$STATE_DIR/COMPLETED.txt" | sort) \
					| wc -l
			)"
		fi
		remaining="$pending"
		echo "list: $DEFAULT_FILES ($total files)"
	fi
	echo "state: $STATE_DIR"
	echo "completed: $completed"
	echo "failed: $failed"
	echo "skipped: $skipped"
	echo "remaining (review vs FILES.txt): $remaining"
	if [[ -f "$STATE_DIR/USAGE.tsv" ]]; then
		echo
		echo "recent usage:"
		tail -n 10 "$STATE_DIR/USAGE.tsv"
	fi
}

assemble_prompt() {
	local file="$1"
	local mode="$2"
	local out="$3"
	{
		cat "$SESSION_PROMPT"
		echo
		echo '---'
		echo
		cat "$DOMAIN_PROMPT"
		echo
		echo '---'
		echo
		echo '# CURRENT REVIEW'
		echo
		echo "MODE: $mode"
		echo "PRIMARY FILE: $file"
		echo
		echo 'This session is independent from every previous review.'
		echo 'Start with the primary file. Do not perform a general repository review.'
		echo 'Your final message is the report, including the REVIEW_TRAILER.'
	} > "$out"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--fix)
			MODE=fix
			shift
			;;
		--force)
			FORCE=1
			shift
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		--status)
			SHOW_STATUS=1
			shift
			;;
		--refresh-list)
			REFRESH=1
			shift
			;;
		--files)
			[[ $# -ge 2 ]] || die "--files requires a path"
			FILES_PATH="$2"
			shift 2
			;;
		--limit)
			[[ $# -ge 2 ]] || die "--limit requires a number"
			LIMIT="$2"
			shift 2
			;;
		--max-turns)
			[[ $# -ge 2 ]] || die "--max-turns requires a number"
			MAX_TURNS="$2"
			shift 2
			;;
		--timeout-sec)
			[[ $# -ge 2 ]] || die "--timeout-sec requires a number"
			TIMEOUT_SEC="$2"
			shift 2
			;;
		--model)
			[[ $# -ge 2 ]] || die "--model requires an id"
			MODEL="$2"
			shift 2
			;;
		--effort)
			[[ $# -ge 2 ]] || die "--effort requires a level"
			EFFORT="$2"
			shift 2
			;;
		--allow-subagents)
			ALLOW_SUBAGENTS=1
			shift
			;;
		--)
			shift
			POSITIONAL+=("$@")
			break
			;;
		-*)
			die "Unknown option: $1"
			;;
		*)
			POSITIONAL+=("$1")
			shift
			;;
	esac
done

if [[ "$REFRESH" -eq 1 ]]; then
	refresh_list "$DEFAULT_FILES"
	echo "Wrote $DEFAULT_FILES"
	exit 0
fi

if [[ "$SHOW_STATUS" -eq 1 ]]; then
	show_status
	exit 0
fi

if [[ ${#POSITIONAL[@]} -gt 0 ]]; then
	FILES=("${POSITIONAL[@]}")
else
	FILES_PATH="${FILES_PATH:-$DEFAULT_FILES}"
	require_file "$FILES_PATH"
	mapfile -t FILES < <(read_list "$FILES_PATH")
fi

[[ ${#FILES[@]} -gt 0 ]] || die "No files to review"

if [[ "$DRY_RUN" -eq 0 ]]; then
	require_file "$DOMAIN_PROMPT"
	require_file "$SESSION_PROMPT"
	require_file "$PARSE_RESULT"
	command -v grok >/dev/null || die "grok is not on PATH"
	command -v bun >/dev/null || die "bun is not on PATH"

	mkdir -p "$STATE_DIR/logs" "$STATE_DIR/reports" "$STATE_DIR/prompts" "$STATE_DIR/stderr"
	touch "$STATE_DIR/COMPLETED.txt" "$STATE_DIR/FAILED.txt" "$STATE_DIR/SKIPPED.txt"
	if [[ ! -f "$STATE_DIR/USAGE.tsv" ]]; then
		printf 'file\tmode\tstatus\tstopReason\tturns\tcost\tsessionId\n' > "$STATE_DIR/USAGE.tsv"
	fi

	exec 9>"$STATE_DIR/lock"
	if ! flock -n 9; then
		die "Another review.sh is already running ($STATE_DIR/lock)"
	fi
fi

CURRENT_FILE=""
on_stop() {
	echo
	echo "Interrupted during ${CURRENT_FILE:-startup}. Current file was not marked completed." >&2
	exit 130
}
trap on_stop INT TERM

TOTAL="${#FILES[@]}"
INDEX=0
RUN=0
OK=0
FAIL=0
SKIP=0

for FILE in "${FILES[@]}"; do
	INDEX=$((INDEX + 1))
	KEY="$MODE $FILE"
	ABS_FILE="$FILE"
	[[ "$ABS_FILE" == /* ]] || ABS_FILE="$ROOT/$FILE"
	REL_FILE="${ABS_FILE#"$ROOT/"}"

	if [[ "$FORCE" -eq 0 && -f "$STATE_DIR/COMPLETED.txt" ]] && grep -Fxq "$KEY" "$STATE_DIR/COMPLETED.txt"; then
		echo "[$INDEX/$TOTAL] SKIP completed: $REL_FILE"
		SKIP=$((SKIP + 1))
		continue
	fi

	if [[ ! -f "$ABS_FILE" ]]; then
		echo "[$INDEX/$TOTAL] SKIP missing: $REL_FILE"
		append_unique "$STATE_DIR/SKIPPED.txt" "$REL_FILE"
		SKIP=$((SKIP + 1))
		continue
	fi

	if [[ "$LIMIT" -gt 0 && "$RUN" -ge "$LIMIT" ]]; then
		echo "[$INDEX/$TOTAL] STOP at --limit $LIMIT"
		break
	fi

	if [[ "$DRY_RUN" -eq 1 ]]; then
		echo "[$INDEX/$TOTAL] $MODE $REL_FILE"
		RUN=$((RUN + 1))
		continue
	fi

	RUN=$((RUN + 1))
	CURRENT_FILE="$REL_FILE"
	SAFE="$(safe_name "$REL_FILE")"
	LOG="$STATE_DIR/logs/$SAFE.json"
	REPORT="$STATE_DIR/reports/$SAFE.md"
	ERR="$STATE_DIR/stderr/$SAFE.log"
	PROMPT_FILE="$STATE_DIR/prompts/$SAFE.md"
	BEFORE_DIFF="$STATE_DIR/logs/$SAFE.before.diffstat"
	AFTER_DIFF="$STATE_DIR/logs/$SAFE.after.diffstat"

	assemble_prompt "$REL_FILE" "$MODE" "$PROMPT_FILE"
	git -C "$ROOT" diff --stat > "$BEFORE_DIFF" || true

	echo
	echo "============================================================"
	echo "[$INDEX/$TOTAL] $MODE $REL_FILE"
	echo "============================================================"

	GROK_CMD=(
		grok
		--cwd "$ROOT"
		--no-auto-update
		--always-approve
		--sandbox workspace
		--max-turns "$MAX_TURNS"
		--reasoning-effort "$EFFORT"
		--output-format json
		--verbatim
		--prompt-file "$PROMPT_FILE"
		--deny 'Bash(git *)'
	)

	if [[ "$ALLOW_SUBAGENTS" -eq 0 ]]; then
		GROK_CMD+=(--no-subagents)
	fi
	if [[ -n "$MODEL" ]]; then
		GROK_CMD+=(--model "$MODEL")
	fi
	if [[ "$MODE" == review ]]; then
		GROK_CMD+=(--disallowed-tools 'search_replace,write')
	fi
	if [[ "$TIMEOUT_SEC" -gt 0 ]]; then
		command -v timeout >/dev/null || die "timeout is required for --timeout-sec"
		GROK_CMD=(timeout --signal=TERM --kill-after=15 "$TIMEOUT_SEC" "${GROK_CMD[@]}")
	fi

	GROK_MEMORY=0 GROK_SUBAGENTS=0 GROK_DISABLE_AUTOUPDATER=1 \
		"${GROK_CMD[@]}" > "$LOG" 2>"$ERR"
	STATUS=$?

	git -C "$ROOT" diff --stat > "$AFTER_DIFF" || true

	PARSE_STATUS=0
	PARSE_LINE=""
	if [[ -s "$LOG" ]]; then
		PARSE_LINE="$(bun "$PARSE_RESULT" "$LOG" "$REPORT")"
		PARSE_STATUS=$?
	else
		PARSE_LINE=$'error\tempty grok output\t\t\t'
		PARSE_STATUS=1
		printf 'Grok produced no stdout. stderr:\n%s\n' "$(cat "$ERR")" > "$REPORT"
	fi

	IFS=$'\t' read -r PARSE_KIND STOP_REASON TURNS COST SESSION_ID <<<"$PARSE_LINE"
	OUTCOME=fail

	if [[ "$STATUS" -eq 0 && "$PARSE_STATUS" -eq 0 ]]; then
		OUTCOME=ok
	elif [[ "$STATUS" -eq 130 || "$STATUS" -eq 143 ]]; then
		OUTCOME=interrupted
	elif [[ "$PARSE_STATUS" -eq 3 ]]; then
		OUTCOME=incomplete
	fi

	if [[ "$MODE" == review ]] && ! cmp -s "$BEFORE_DIFF" "$AFTER_DIFF"; then
		echo "WARNING: review mode changed the worktree for $REL_FILE" >&2
		git -C "$ROOT" diff --stat >&2 || true
		append_unique "$STATE_DIR/DIRTY.txt" "$REL_FILE"
	fi

	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
		"$REL_FILE" "$MODE" "$OUTCOME" "$STOP_REASON" "$TURNS" "$COST" "$SESSION_ID" \
		>> "$STATE_DIR/USAGE.tsv"

	if [[ "$OUTCOME" == ok ]]; then
		echo "[$INDEX/$TOTAL] OK: $REL_FILE (turns=${TURNS:-?} cost=${COST:-unknown})"
		append_unique "$STATE_DIR/COMPLETED.txt" "$KEY"
		remove_line "$STATE_DIR/FAILED.txt" "$KEY"
		OK=$((OK + 1))
	elif [[ "$OUTCOME" == interrupted ]]; then
		echo "[$INDEX/$TOTAL] INTERRUPTED: $REL_FILE" >&2
		exit "$STATUS"
	else
		echo "[$INDEX/$TOTAL] FAILED ($OUTCOME, grok=$STATUS, parse=$PARSE_STATUS): $REL_FILE" >&2
		append_unique "$STATE_DIR/FAILED.txt" "$KEY"
		FAIL=$((FAIL + 1))
	fi

	CURRENT_FILE=""
done

echo
echo "done. mode=$MODE ran=$RUN ok=$OK failed=$FAIL skipped=$SKIP"
if [[ "$DRY_RUN" -eq 1 ]]; then
	exit 0
fi
echo "reports: $STATE_DIR/reports"
echo "status:  $0 --status"
if [[ "$FAIL" -gt 0 ]]; then
	exit 1
fi
