# Page-detection models

`docs/docmodel.js` can run a neural network that finds the page's four corners
(DocAligner, DocsaidLab, Apache-2.0; see `LICENSE-DocAligner.txt`). It is **not
used by the app yet**: the pretrained weights didn't detect hand-held pages in
laptop-webcam frames (see the PR that added this folder). The plan is to
fine-tune them on webcam frames, then put the result here as
`docaligner-lcnet100.onnx`.

To try the pretrained model with the benchmark:

```bash
npm pack quadscan@1.0.0 && tar xzf quadscan-1.0.0.tgz && cp package/models/lcnet100_h_e_bifpn_256_fp32.onnx docs/models/docaligner-lcnet100.onnx
```

```bash
npm pack onnxruntime-web@1.20.1 && mkdir ort && tar xzf onnxruntime-web-1.20.1.tgz -C ort
```

```bash
node dev/eval/run.js dev/eval/private --model ort/package --raw
```

The model takes a 256×256 BGR image scaled to 0–1 (channels first) and returns
four 128×128 corner heatmaps.
