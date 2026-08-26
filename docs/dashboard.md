# Trends dashboard

`flaught dashboard` turns findings artifacts from multiple review runs into a
self-contained HTML report. The report makes changes in finding volume and
severity visible without sending artifact data to another service.

## Command

```bash
flaught dashboard --input <dir> [--output <path>]
```

| Option | Required | Description |
|---|---:|---|
| `--input <dir>` | Yes | Directory to search recursively for JSON files. |
| `--output <path>` | No | HTML file to write. Defaults to `flaught-dashboard.html`. |

Relative input and output paths are resolved from the current working
directory. The output is a static HTML file with inline styles and SVG, so it
can be opened directly in a browser without a server or build step.

For example:

```bash
flaught dashboard --input ./ci-artifacts --output ./dashboard.html
```

Open `dashboard.html` in a browser after the command completes.

## Gather artifacts from GitHub Actions

The standard Flaught workflow uploads each review's `findings.json` in an
artifact named `flaught-findings`. List recent workflow runs to get their run
IDs:

```bash
gh run list \
  --workflow adversarial-review.yml \
  --limit 20 \
  --json databaseId,displayTitle,conclusion
```

Download each run into its own directory. Keeping the run ID in the path avoids
one download overwriting another:

```bash
mkdir -p ./ci-artifacts/32728079202
gh run download 32728079202 \
  -n flaught-findings \
  -D ./ci-artifacts/32728079202
```

Repeat the download for the runs to compare, then render the parent directory:

```text
ci-artifacts/
├── 32726648775/
│   └── findings.json
└── 32728079202/
    └── findings.json
```

```bash
flaught dashboard --input ./ci-artifacts
```

Run the `gh` commands from the repository whose review artifacts you want. From
somewhere else, pass `--repo OWNER/REPO` to both `gh run list` and
`gh run download`.

The input loader visits subdirectories recursively. It skips unreadable files,
invalid JSON, and JSON that does not have the minimum findings-artifact shape,
so the input tree may contain other files.

## What the report contains

The report orders recognized artifacts by their `generated_at` timestamp and
shows:

- summary cards for the number of runs, latest finding count, average findings
  per run, and number of runs with an LLM failure;
- a findings-over-time chart with total, critical, high, medium, low, and info
  series; and
- a newest-first table with the date, repository, pull request, total and
  per-severity counts, LLM/deterministic split, skeptic
  confirmed/refuted/uncertain counts, dismissals, and LLM failure status.

Chart points are evenly spaced by run rather than by elapsed time. This keeps
the trend legible when workflow runs have irregular gaps.

An LLM failure does not make an artifact unusable: the table flags the run, and
any deterministic findings recorded in the artifact remain available for the
trend.

## Empty or invalid input

If the input tree contains no recognized findings artifacts, the command exits
with code `2`. It prints the resolved input directory and a suggested
`gh run download` command. It does not create a new output file or overwrite an
existing one.

A valid review artifact with zero findings is different from missing input. It
is included as a zero-finding run in the report.

For the complete artifact fields, see the [findings schema](findings-schema.md).
