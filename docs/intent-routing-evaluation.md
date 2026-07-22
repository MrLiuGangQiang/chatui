# Intent-routing evaluation

This benchmark measures the model's routing decision before ChatUI sends a chat, vision, generation, or image-edit request. It is intentionally separate from the normal test suite: unit tests make the scorer deterministic, while this command measures a real configured model.

The versioned starter corpus is [test/fixtures/intent-routing-eval.v1.json](../test/fixtures/intent-routing-eval.v1.json). It contains anonymized Chinese customer-request patterns for every supported operation, context boundaries, exact image/file binding, ambiguous references, and clarification.

## Run an evaluation

In PowerShell, set the route model explicitly and run the command:

```powershell
$env:CHATUI_EVAL_BASE_URL = 'https://your-api.example/v1'
$env:CHATUI_EVAL_API_KEY = 'your-api-key'
$env:CHATUI_EVAL_ROUTE_MODEL = 'your-route-model'
npm.cmd run eval:intent
```

The evaluator uses the same `task_contract.v3` route payload and strict parser as the browser. It writes a JSON report under `reports/intent-routing/`, which is ignored by Git and never includes the API key or raw model output.

Useful options:

```powershell
npm.cmd run eval:intent -- --limit 5 --no-write
npm.cmd run eval:intent -- --min-score 95 --min-valid-contract 100
npm.cmd run eval:intent -- --fixture .\test\fixtures\intent-routing-eval.v1.json --output .\temp\intent-eval.json
```

The command exits with a non-zero status when either quality gate is missed. Defaults are an average score of at least 90 and a valid-contract rate of 100. Use `--min-score 0 --min-valid-contract 0` only when collecting an initial baseline rather than enforcing a gate.

## Score dimensions

| Dimension | What must be correct |
| --- | --- |
| `valid_contract` | The response parses as a strict, executable `task_contract.v3` against the supplied candidates. |
| `operation` | The task type, such as `file_qa`, `edit_image`, or `clarify`. |
| `relation` | Whether the request is new, a follow-up, a correction, or a continuation. |
| `resources` | Required image/file type, source, role, typed candidate index (`media_index` for mixed attachments), and declared identity. |
| `clarification` | Whether clarification is required and the response contains a question. |
| `directive` | The required `standalone` or `patch` composition mode and, where specified, preservation policy. |

`operation` and `resources` have the highest weights because executing the wrong tool or the wrong customer asset is the most damaging routing failure.

## Maintain the corpus

Add one fixture per anonymized real-world failure or important success case. Keep the user input free of personal data, account identifiers, URLs with tokens, and file contents. Describe only the candidate metadata required to distinguish the resource.

Each case must provide:

- a stable kebab-case `id` and category;
- input, attachment metadata, and route context;
- expected operation, relation, clarification state, directive mode, and resource expectations.

Use `resources.mode: "media_exact"` for a case whose safety requirement is “do not select an image or file.” It ignores non-executing `text`/`message` annotations while still failing any unexpected media binding. Use `exact` when every contract resource itself is significant.

The unit suite validates that every non-missing expected resource resolves uniquely against the case candidates. This prevents a benchmark from silently testing an impossible resource selection.

When changing the route prompt or model, run the benchmark first with the current production model to establish a baseline, then compare the score dimensions and failing case IDs. Do not promote a model based only on average score: preserve a 100% valid-contract rate and inspect every resource-binding or clarification regression.
