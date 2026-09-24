# ModelPro

ModelPro is the canonical, consumer-independent model-verification module used by GPTWork and other projects.

## Contract

ModelPro owns the deterministic verification probe, catalog convergence/ordering, verification outcome summarization, and portable verification-history record shape. Consumer projects provide adapters for browser UI selection, request interception, response evidence, logging, persistence, and product-specific mode transitions.

The verification authority is deliberately evidence-based: a consumer should mark a model verified only when the intended forwarded request model and the terminal backend-served response model are both confirmed for the same turn.

## Consumer workflow

1. Fix and test model-verification behavior in this repository first.
2. Publish/merge the ModelPro change.
3. Import the exact ModelPro source into each consumer (for GPTWork: `extension/vendor/modelpro/model-verification.js`).
4. Keep `MODELPRO_SOURCE.json` beside the vendored file so the source repository/ref is explicit.
5. Consumer-specific adapters stay in the consumer; reusable verification policy stays here.

## API

`src/model-verification.js` exports:

- `buildVerificationProbe(marker, ordinal, total)`
- `catalogIdentity(item)`
- `verificationChronology(item, normalizeModel)`
- `createVerificationCatalog(...)`
- `summarizeVerificationOutcome(progress)`
- `createModelVerificationHistoryRecord(...)`

ModelPro has no Chrome-extension or GPTWork runtime dependency.
