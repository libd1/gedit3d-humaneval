# Alchemy3D Human Evaluation

Blind preference study UI for [Edit3DHumanEval](https://www.modelscope.cn/models/libd55/Edit3DHumanEval).

## Run locally

```powershell
cd human-eval
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

Open http://127.0.0.1:8765/index.html

## Flow

1. Each visitor draws **50 stratified** samples: 30 add/remove/replace, 10 animation, 10 local/global appearance.
2. For every sample the page shows target_image, instruction, source.glb, then shuffled anonymous outputs (A/B/C/...).
3. The participant picks one winner; answers are stored in localStorage and can be downloaded as JSON.

## Assets

GLBs / images are fetched directly from ModelScope (CORS: *). Source and Alchemy3D meshes are large (~50MB+); loading can take a while on slow networks.

Rebuild the sample index after the hub repo changes:

```powershell
powershell -ExecutionPolicy Bypass -File .\build-manifest.ps1
```