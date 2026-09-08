# Authority boundaries

USL resource locators identify possible reads. They do not authorize those
reads. `ObserveOptions.allowedLocators` is caller-controlled and limits only
the observation request; resolver and platform policy may still refuse it.

An observation digest detects accidental change within its format. It is not a
signature, ownership proof, semantic truth proof, or admission record.

HSWM receives the exact `adapt_usl` input prepared by
`prepareHswmAdapterArguments`: plan, v2 report, caller policy, caller
`allowed_reads`, `now`, and revision. The caller owns HSWM policy, pins, and
authorization. The adapter neither performs resolver I/O nor produces owner,
Permit, admission, credit, execution, or learning state.

GEIP handoff preserves GraphSpec provenance and remains a local draft profile.
It does not establish runtime suitability or HSWM admission.
