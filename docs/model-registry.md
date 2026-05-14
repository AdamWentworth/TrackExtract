# Model Registry

The generated bundled registry is `resources/models.json`. It is built from source fragments in `resources/models/`:

- `demucs.json`: installed Demucs provider presets.
- `uvr.json`: public UVR model pack entries that can be installed into app data.
- `manual.json`: hand-curated model references that do not belong to a larger imported catalog.
- `mvsep.json`: MVSEP source references.

Rebuild the combined registry after editing a source fragment:

```bash
npm run models:build
```

Check that the generated registry is fresh:

```bash
npm run models:check
```

Validate schema, required model coverage, install metadata, and local path references:

```bash
npm run test:models
```

Installed Demucs provider entries are included for real development renders:

- `demucs_htdemucs_vocals_instrumental` uses Demucs `htdemucs` with `--two-stems=vocals`.
- `demucs_htdemucs_ft_vocals_instrumental` uses fine-tuned `htdemucs_ft` for slower, higher-quality vocal splits.
- `demucs_htdemucs_6s_full_split` uses Demucs `htdemucs_6s` for vocals, drums, bass, guitar, piano, and other.
- `demucs_htdemucs_ft_4stem_best_split` uses fine-tuned `htdemucs_ft` for vocals, drums, bass, and other.
- `demucs_htdemucs_drums_only` and `demucs_htdemucs_bass_only` provide isolated source plus inverse stems.
- `demucs_htdemucs_6s_guitar_only` and `demucs_htdemucs_6s_piano_only` provide experimental isolated source plus inverse stems.

The bundled catalog includes the public UVR single-model release model files as managed downloads, excluding YAML/config sidecars that are not useful as standalone choices in the UI. It also includes MVSEP separation and restoration algorithms as source references so producers can discover RoFormer, SCNet, MDX, drum, guitar, piano, wind, string, percussion, dereverb, denoise, and restoration options without leaving the model manager.

Missing ONNX, RoFormer, MDX23C, and VR rows are real catalog candidates, not fake placeholders. Downloadable `.onnx`, `.pth`, and `.ckpt` entries run through the Python audio-separator provider after setup. Raw `.th` Demucs weights are still cataloged, but they need matching YAML model definitions before Track Extract can run them. MVSEP rows without direct model files remain source references until a local compatible model or service adapter exists.

Useful public model sources:

- Demucs: https://github.com/facebookresearch/demucs
- Public UVR single-model release: https://github.com/TRvlvr/model_repo/releases/tag/all_public_uvr_models
- MVSEP algorithm catalog: https://mvsep.com/en
- UVR ONNX models via sherpa-onnx: https://k2-fsa.github.io/sherpa/onnx/source-separation/models.html
- Hugging Face source-separation models: https://huggingface.co/models?other=source-separation
- RoFormer catalog source: https://huggingface.co/AEmotionStudio/roformer-models
