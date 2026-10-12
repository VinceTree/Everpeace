# Benchmark evidence

Success / planned: 0 / 120. Evidence: insufficient.

Failed 28; timed out 0; error 1; cancelled 0; skipped 91.

Unknown Usage: 28 recorded runs. Real model runs: 25.

| Task | Run | Outcome | Usage | Model |
| --- | --- | --- | --- | --- |
| text-codecs | optimization-team-v2-20261012:candidate:text-codecs:1 | failed | unknown | deepseek-flash |
| text-codecs | optimization-team-v2-20261012:baseline:text-codecs:1 | failed | unknown | deepseek-flash |
| configuration-values | optimization-team-v2-20261012:candidate:configuration-values:5 | failed | unknown | deepseek-flash |
| configuration-values | optimization-team-v2-20261012:baseline:configuration-values:5 | failed | unknown | deepseek-flash |
| text-codecs | optimization-team-v2-20261012:baseline:text-codecs:4 | failed | unknown | deepseek-flash |
| text-codecs | optimization-team-v2-20261012:candidate:text-codecs:4 | failed | unknown | deepseek-flash |
| text-codecs | optimization-team-v2-20261012:baseline:text-codecs:3 | failed | unknown | deepseek-flash |
| text-codecs | optimization-team-v2-20261012:candidate:text-codecs:3 | failed | unknown | deepseek-flash |
| boolean-and-slug | optimization-team-v2-20261012:baseline:boolean-and-slug:4 | failed | unknown | deepseek-flash |
| boolean-and-slug | optimization-team-v2-20261012:candidate:boolean-and-slug:4 | failed | unknown | deepseek-flash |
| wire-contract | optimization-team-v2-20261012:candidate:wire-contract:1 | failed | unknown | deepseek-flash |
| numeric-boundaries | optimization-team-v2-20261012:candidate:numeric-boundaries:5 | failed | unknown | deepseek-flash |
| wire-contract | optimization-team-v2-20261012:baseline:wire-contract:1 | failed | unknown | deepseek-flash |
| numeric-boundaries | optimization-team-v2-20261012:baseline:numeric-boundaries:5 | failed | unknown | deepseek-flash |
| configuration-values | optimization-team-v2-20261012:baseline:configuration-values:1 | failed | unknown | deepseek-flash |
| configuration-values | optimization-team-v2-20261012:candidate:configuration-values:1 | failed | unknown | deepseek-flash |
| html-escaping | optimization-team-v2-20261012:baseline:html-escaping:5 | failed | unknown | deepseek-flash |
| html-escaping | optimization-team-v2-20261012:candidate:html-escaping:5 | failed | unknown | deepseek-flash |
| case-contract | optimization-team-v2-20261012:candidate:case-contract:2 | failed | unknown | deepseek-flash |
| case-contract | optimization-team-v2-20261012:baseline:case-contract:2 | failed | unknown | deepseek-flash |
| case-contract | optimization-team-v2-20261012:candidate:case-contract:3 | failed | unknown | deepseek-flash |
| case-contract | optimization-team-v2-20261012:baseline:case-contract:3 | failed | unknown | deepseek-flash |
| path-portability | optimization-team-v2-20261012:baseline:path-portability:5 | failed | unknown | deepseek-flash |
| path-portability | optimization-team-v2-20261012:candidate:path-portability:5 | failed | unknown | deepseek-flash |
| syntax-strings | optimization-team-v2-20261012:candidate:syntax-strings:2 | failed | unknown | unavailable |
| collections | optimization-team-v2-20261012:baseline:collections:5 | failed | unknown | unavailable |
| configuration-values | optimization-team-v2-20261012:candidate:configuration-values:2 | failed | unknown | unavailable |
| boolean-and-slug | optimization-team-v2-20261012:baseline:boolean-and-slug:2 | failed | unknown | deepseek-flash |
| boolean-and-slug | optimization-team-v2-20261012:candidate:boolean-and-slug:2 | error | not_requested | unavailable |

- Unknown Usage is a metering dimension, not a task outcome.
- Real model runs count recorded request attempts, including failed requests; no-request preparations are excluded.
- Synthetic fixtures are not evidence of real-world repository performance.
