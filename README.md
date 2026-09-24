# ModelPro

Standalone Chrome extension extracted from the complete GPTWork model-verification chain at GPTWork commit `d491987b4832e2f3da614a94582b7b06fd811bb3`.

## Windows 10 local test

```bat
git clone git@github.com:b8vipvip/ModelPro.git
cd ModelPro
```

Open `chrome://extensions/`, enable Developer mode, choose **Load unpacked**, and select the ModelPro repository folder. Open ChatGPT, click the ModelPro toolbar icon, then click **开始完整模型验证**. After later pulls, use **Reload** on the ModelPro extension card.

Export **诊断 LOG** after a run. The diagnostic target is the known response-model evidence mismatch; the GPTWork picker/discovery chain is intentionally preserved rather than rediscovered.
