# ModelPro

ModelPro is the standalone extraction of the **complete GPTWork model-verification chain**.

This repository was re-baselined from GPTWork `main` commit
`d491987b4832e2f3da614a94582b7b06fd811bb3`. The earlier partial extraction and
browser-console reimplementation were discarded because GPTWork already had working
model-picker discovery and an end-to-end verification flow.

## Canonical baseline

The files under `src/gptwork-chain/` are byte-for-byte source snapshots from the
working GPTWork baseline. They intentionally preserve both ChatGPT picker paths,
Chat/Work verification transitions, dynamic catalog rediscovery, per-model
verification transactions, request interception, requestId correlation, and
request/response model evidence.

The known unresolved problem is **response model evidence disagreeing with the
selected/request model**. ModelPro development should debug that evidence boundary
without replacing the already-working picker/discovery chain.

## Source map

- `background.js` — verification orchestration, transactions, catalog convergence,
  request/response verdicts and history.
- `content.js` — both picker implementations, model selection, Chat/Work transition,
  visible probe send and terminal-turn handling.
- `network-monitor.js` — CDP/Fetch/Network observation and requestId lifecycle.
- `network-evidence.js` — request rewrite/extraction and response evidence parsing.
- `page-model-evidence.js` + `astra-model-evidence.js` — page evidence adapters.
- `policy.js` — canonical model/reasoning normalization.
- `tab-feature-runtime.js` — verification Work-mode runtime transition.
- `model-catalog.js` — trusted model catalog persistence.

## Rule

Do not re-discover ChatGPT selectors from scratch in ModelPro. Changes must begin from
this extracted GPTWork baseline. Once the standalone chain is proven, consumers can
import the exact ModelPro revision.
