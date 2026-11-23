# Validation-only commits

A source integration can run CI without publishing the gate image or deploying
the console. Put `[no-deploy]` in every pushed commit and in the final merge
commit message. The console Ignored Build Step skips that commit, and the image
job skips push events with the same marker. The commit message is an explicit
per-commit choice; future ordinary commits retain existing automatic behavior.

Manual CI dispatches are validation-only by default. Set the `publish_image`
boolean only when publication is separately authorized. A skipped image or
console deployment is not a passed runtime or production acceptance check.
Database migration and corpus promotion workflows retain their own contracts.

Validated with a temporary Git repository: the configured ignored-build command
returns 0 for the marker (skip) and 1 for an ordinary subsequent commit (build).
This opt-out does not revoke deployed revisions or change production traffic.

These guards cover the GitHub image job and Vercel console only. Fastverk's
native RepoBuild publisher is independent and does not consume this marker.
Before a no-publication merge, verify that native path is disabled, test-only,
or explicitly release-gated for the push. Do not advance main based solely on
the marker or the successful source checks. Record the native policy and actual
publication/deployment observations in the merge receipt.
