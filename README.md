# OnDemand Auditor

An AI-powered tool that cross-references Java automation code against Zephyr Scale test cases and answers one question: does the automation actually cover what the test case says it should?

Built for QE teams who run automation through an OnDemand portal and need to understand, at scale, whether test failures represent real gaps in coverage or infrastructure noise.

---
## Why this exists

QE teams often run hundreds of automated tests per day, and every failure triggers the same manual loop: open the report, identify the failing step, compare it against the Zephyr test case, inspect the Java automation, and then decide whether the issue represents a real coverage gap or just infrastructure noise. At scale, this becomes hours of repetitive triage work and slows down both development and release cycles.
This tool automates that entire workflow. It ingests automation run reports, detects recurring patterns across failures, validates the Java implementation against the expected Zephyr steps, and produces a probabilistic root‑cause analysis by comparing failing runs to known‑good passing cases. The result is faster triage, clearer coverage insights, and significantly less time spent digging through raw logs and reports.

---

## What it does

### Mode 1 — Automated vs OD

Browse a GitHub repository of Java test files. Select a file. The tool:

1. Fetches the Java source from GitHub
2. Extracts every `REPORT("...")` call — the automation's self-described checkpoints
3. Fetches the corresponding Zephyr Scale test case (linked via a comment like `// EX-T1001`)
4. Sends both to an LLM (gpt-4o) with a structured prompt asking it to map each checkpoint to a test step
5. Renders a side-by-side view: Java block → Zephyr step, with `matched / warning / unmatched` verdicts
6. Optionally runs a second LLM pass on warnings to distinguish false positives from real gaps

### Mode 3 — OD Run Results

Connect to an OnDemand test execution portal. Browse batch runs grouped by date. Drill into any failed run to see per-test failures ranked by coverage verdict. For each failure, the tool streams:

- The OD fail reason and failed step
- The Zephyr test case coverage score (0–100%)
- Which specific Zephyr steps are not covered by any automation
- A GitHub link directly to the Java class

### Folder Audit

Select any folder in the file tree. The tool queues every Java file in that folder and streams audit results one by one — useful for coverage reviews before a sprint or after a risky refactor.

---

## Quick start (demo mode)

```bash
git clone https://github.com/john-luehrs/ondemand-auditor-demo
cd ondemand-auditor-demo
npm install
node server.js
```

The server starts at `http://localhost:3737` with `MOCK_MODE=true` (the default). No credentials needed. Three pre-built scenarios demonstrate the tool's verdicts:

| Ticket | Scenario | Verdict |
|---|---|---|
| EX-T1001 | Arm Away Group 01 | **False positive** — 100% covered, OD failures were infra timeouts |
| EX-T1002 | Arm Stay Group 01 | **Coverage gap** — 4/6 steps matched; two scenarios never tested |
| EX-T1003 | Dismiss Alert Group 01 | **Inconclusive** — automation covers the path but misses timing SLA assertions |

---

## Running against live systems

```bash
cp .env.example .env
# Fill in your credentials
# Set MOCK_MODE=false
node server.js
```

Requires:
- GitHub token with `repo:read` access to your automation repository
- Zephyr Scale API key
- Azure OpenAI endpoint (gpt-4o)
- OnDemand portal credentials (for Mode 3)

---

## Engineering decisions

### 1. `REPORT()` as the semantic bridge

Java test frameworks log at the method level: a test passes or fails. They don't say *which* of the test case's six scenarios were exercised. By convention, the automation wraps meaningful checkpoints in `REPORT("description")` calls — these become the unit of LLM analysis.

The alternative (parsing assertions directly) produces too much noise and requires framework-specific parsing. `REPORT()` calls are authored by humans who already know what they're checking, making them a much better signal.

### 2. Two-pass LLM architecture

**Pass 1 (gpt-4o, JSON mode):** Given N Java blocks and M Zephyr steps, produce a structured match matrix with confidence scores. Optimized for precision — it only flags `warning` when it can articulate the concern.

**Pass 2 (lighter model, optional):** Given only the warning items, produce an analyst-grade verdict: `true_gap / false_positive / inconclusive`. This pass is skipped during folder audits (batched separately) to avoid sequential blocking.

The two-pass design keeps the expensive model focused on structured mapping and uses a cheaper model for freeform reasoning.

### 3. SSE streaming for long-running operations

Folder audits and OD run audits process files sequentially (each requires a GitHub fetch, a Zephyr fetch, and 1–2 LLM calls). Rather than block the request until everything finishes, the server sends Server-Sent Events as each file completes. The UI renders cards progressively — the user can start reading results while the rest of the queue processes.

### 4. Coverage score derivation

The tool does not trust the OD portal's own pass/fail percentage. That number reflects how many scenarios ran, not how many Zephyr steps are validated. Instead, coverage is computed from the LLM match matrix: `matched steps / total steps`. A run can score 100% in OD (all scenarios passed to a checkpoint) and 40% in this tool (only 2 of 5 Zephyr requirements verified).

### 5. Structured prompts with domain placeholders

The LLM prompt includes placeholder blocks like `[WEBAPI_METHOD_MAPPING]` and `[ENUM_VALUE_MAPPING]`. In production, these are replaced with project-specific domain knowledge that teaches the model which API calls correspond to which UI actions and which enum values map to which states. The placeholders make the prompt structure explicit and the substitution step auditable.

---

## Project structure

```
server.js          — Express-style HTTP server, all routes, LLM pipeline, OD/GitHub/Zephyr clients
auditor.html       — Single-page UI, no build step required
mock/              — Fixture data for demo mode (JSON responses for all three scenarios)
.env.example       — Credential template
```

---

## License

MIT
