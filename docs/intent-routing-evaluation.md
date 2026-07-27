# Intent-routing evaluation

This benchmark measures the model's routing decision before ChatUI sends a chat, vision, generation, or image-edit request. It is intentionally separate from the normal test suite: unit tests make the scorer deterministic, while this command measures a real configured model.

The versioned corpus is [test/fixtures/intent-routing-eval.v1.json](../test/fixtures/intent-routing-eval.v1.json). It contains anonymized Chinese customer-request patterns for every supported operation, context boundaries, exact image/file binding, attachment-only turns, unavailable files, fixed-mode conflicts, multi-task requests, relation semantics, and structured clarification.

## Run an evaluation

In PowerShell, set the route model explicitly and run the command:

```powershell
$env:CHATUI_EVAL_BASE_URL = 'https://your-api.example/v1'
$env:CHATUI_EVAL_API_KEY = 'your-api-key'
$env:CHATUI_EVAL_ROUTE_MODEL = 'your-route-model'
npm.cmd run eval:intent
```

The evaluator uses the same `route_decision.v1` model payload, deterministic v5 compiler, and strict execution-contract parser as the browser. It writes a JSON report under `reports/intent-routing/`, which is ignored by Git and never includes the API key or raw model output.

Useful options:

```powershell
npm.cmd run eval:intent -- --limit 5 --no-write
npm.cmd run eval:intent -- --min-score 95 --min-valid-contract 100
npm.cmd run eval:intent -- --fixture .\test\fixtures\intent-routing-eval.v1.json --output .\temp\intent-eval.json
```

The command exits with a non-zero status when any quality gate is missed. Defaults are an average score of at least 90 and a valid-contract rate of 100. In addition, safety-critical cases always require a 100% perfect-case rate; command-line thresholds cannot relax this gate. `--min-score 0 --min-valid-contract 0` therefore collects a permissive aggregate baseline but still exposes and fails dangerous routing regressions.

## Score dimensions

| Dimension | What must be correct |
| --- | --- |
| `valid_contract` | The semantic response compiles into a strict `task_contract.v5` against the supplied candidates. |
| `operation` | The real task type, such as `file_qa`, `image_reference_gen`, or `edit_image`. |
| `readiness` | Whether the task is ready to dispatch or must stop for structured clarification. This is scored independently from operation. |
| `relation` | Whether the request is new, a follow-up, a correction, or a continuation. |
| `resources` | Required image/file type, source, role, typed candidate index (`media_index` for mixed attachments), and declared identity. |
| `clarification` | Whether clarification is required and the exact unresolved type, role, reason, choice count, and configured candidate identities match. |
| `directive` | The required `standalone` or `patch` composition mode and, where specified, preservation policy. |

`operation` and `resources` have the highest weights because executing the wrong tool or the wrong customer asset is the most damaging routing failure. A weighted score is diagnostic only: a failed safety-critical case always fails the gate even when the average remains high.

## Maintain the corpus

Add one fixture per anonymized real-world failure or important success case. Keep the user input free of personal data, account identifiers, URLs with tokens, and file contents. Describe only the candidate metadata required to distinguish the resource.

Each case must provide:

- a stable kebab-case `id` and category;
- an explicit `safety_critical` boolean;
- input, attachment metadata, and route context;
- optional `current_mode`/`auto_mode` when testing manual routing;
- expected operation, relation, structured clarification state, directive mode, and resource expectations.

`expected.clarification` has one uniform shape: `required` plus an `unresolved` array. Each unresolved expectation declares `type`, `role`, `reason`, and `choice_count`; ambiguous cases may also list exact choice source/index/identity tuples. Ready cases use `{ "required": false, "unresolved": [] }`.

Use `resources.mode: "media_exact"` for a case whose safety requirement is “do not select an image or file.” It ignores non-executing `text`/`message` annotations while still failing any unexpected media binding. Use `exact` when every contract resource itself is significant.

The unit suite validates that every concrete resource and every structured clarification choice resolves uniquely against the case candidates. Empty input is accepted only for attachment-only cases. This prevents a benchmark from silently testing an impossible resource selection or a turn with no input at all.

When changing the route prompt or model, run the benchmark first with the current production model to establish a baseline, then compare the score dimensions and failing case IDs. Do not promote a model based only on average score: preserve a 100% valid-contract rate, a 100% safety-critical perfect-case rate, and inspect every resource-binding or clarification regression.
