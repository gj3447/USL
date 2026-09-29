# Contributing to USL

Start with [README.md](README.md) and [the architecture](docs/ARCHITECTURE.md).
Keep changes focused, preserve existing resource identities and authority
boundaries, and distinguish tests, formal models and external observations.

## Contributor agreement

USL is dual-licensed under AGPL-3.0-or-later and a separate commercial license.
Read [CLA.md](CLA.md) before submitting a contribution. Include this line in
your pull request description or a commit in that pull request:

```text
I have read and agree to the Contributor License Agreement (CLA.md).
```

Maintainers require this acknowledgement before merging contributions and must
preserve applicable third-party notices. See [LICENSING.md](LICENSING.md).

## Validation

Run checks relevant to your change, including the applicable CI gates:

```sh
npm ci
npm run typecheck
npm test
npm run build
python3 scripts/check-docs.py
```

Lean changes also require `npm run test:lean`. When source pins change, update
the relevant generated graph with `npm run engineering:build` and, if needed,
`npm run binding-progress:build`, then run their `:check` commands. See
[the verification workflow](.github/workflows/verify.yml) for RDF/SHACL checks
and Python dependencies. Preserve dated evidence as historical records.

Licensing questions: Ra Gyeongjun (라경준) — <gj3447@gmail.com>.
