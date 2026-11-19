#!/usr/bin/env bash
# The framework holds mechanisms only: anything that changes with the business (roles, tier
# meanings, thresholds, tax rules, currencies, number formats, participant kinds, templates,
# product words) is declared by the application or stored per tenant. This check fails when
# product vocabulary appears anywhere in framework/ (code, strings, phrases, scripted-model
# scripts, tests). It checks the working tree of the repository it is run in, untracked
# files included.
#
#   scripts/check-boundary.sh            from the repository (or a worktree) root
#
# Known, older wording that predates the rule is listed in scripts/boundary-allow.txt as
# `<path>:<text on the line>`; add to it only with a reason.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
top="$(git rev-parse --show-toplevel)"
allow="$here/boundary-allow.txt"
cd "$top"

# Case-insensitive product words.
words='homeowners?|designers?|supervisors?|procurement|quotes?|quotations?|vendors?|contractors?|gstin|gst|hsn|sac code|cgst|sgst|igst|cutlists?|snags?|site visits?|interiors?|interioring|rupees?|paise|lakhs?|crores?'
# Case-sensitive ones: "studio" as the product's word for a business ("per studio",
# "studios"), not Mastra Studio (the studio command, .studio/, studioUrl). DPR in capitals only (dpr can be
# device pixel ratio). Rs followed by an amount.
sensitive='\bstudios\b|\b(per|each|every|a|the|your|their|this|that|one) studio\b|\bstudio\x27s\b|\bDPR\b|₹|\bRs\.? ?[0-9]'

hits="$(
  {
    git grep -nIiP --untracked "\\b($words)\\b" -- framework \
      ':!framework/*/dist/**' ':!framework/create-basecamp/template/**' || true
    git grep -nIP --untracked "$sensitive" -- framework \
      ':!framework/*/dist/**' ':!framework/create-basecamp/template/**' || true
  } | { grep -viE 'basecamp studio|mastra' || true; } | sort -u
)"

if [ -n "$hits" ] && [ -f "$allow" ]; then
  while IFS= read -r entry; do
    case "$entry" in '' | \#*) continue ;; esac
    path="${entry%%:*}"; text="${entry#*:}"
    hits="$(printf '%s\n' "$hits" | awk -v p="$path:" -v t="$text" 'index($0, p) != 1 || index($0, t) == 0')"
  done <"$allow"
fi
hits="$(printf '%s\n' "$hits" | sed '/^$/d')"

if [ -n "$hits" ]; then
  echo "Product vocabulary in framework/ (framework code holds mechanisms only; declare these in the application or tenant settings):" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "ok: framework/ holds no product vocabulary"
