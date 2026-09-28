# ModelPro

Standalone Chrome extension extracted from the complete GPTWork model-verification chain at GPTWork commit `d491987b4832e2f3da614a94582b7b06fd811bb3`, then evolved independently to track current ChatGPT UI and network behavior.

## Reusable verification policy

`extension/model-verification.js` is the product-neutral migration boundary for consumers such as GPTWork. It owns deterministic catalog identity/order/merge semantics, terminal verification outcome classification, and verification-history serialization. Browser/CDP wiring, Chat/Work activation, request interception, response evidence collection, UI, account state, and update/release behavior remain consumer adapters.

A consumer migration should vendor an exact, tested ModelPro revision and record its source commit rather than copying verification policy ad hoc. ModelPro remains the place where ChatGPT compatibility changes are proved first.

## Windows 10 local test

```bat
git clone git@github.com:b8vipvip/ModelPro.git
cd ModelPro
```

Open `chrome://extensions/`, enable Developer mode, choose **Load unpacked**, and select the ModelPro repository folder. Open ChatGPT, click the ModelPro toolbar icon, then click **开始完整模型验证**. After later pulls, use **Reload** on the ModelPro extension card.

Export **诊断 LOG** after a run. A successful compatibility proof requires the real verification chain to complete against ChatGPT request/response evidence; unit tests alone are not a substitute for the live run.
