# LocalPilot

A desktop chat and coding agent for local models on macOS (Apple Silicon). It talks to
[LM Studio](https://lmstudio.ai) and to its own patched build of [llama.cpp](https://github.com/ggml-org/llama.cpp),
and can create and edit files, run commands (with your approval), search the web, read images, and ask you
clarifying questions.

## Features

- **Modes:** Chat (no tools), Manual (approve every change), Auto (file changes automatic, commands need approval)
- **Effort:** Low (no thinking), Medium, High (more steps, verifies its work)
- **Tools:** list/search/read/write/edit files, run commands, open files, web search and page fetch, ask the user
- **Safety:** all file access is confined to the workspace folder; every agent run can be undone; web fetches of
  addresses that didn't come from a search or your message need approval; private-network addresses are blocked
- **Self-check:** syntax-checks Python/JS/shell/Ruby/JSON and loads HTML pages offline to catch JavaScript errors
- **Context:** live context meter, token counters (in / out / thinking / cached), auto-compact at 80%
- **Project memory:** each project can keep a `LOCALPILOT.md` that is loaded into the chat
- **Models:** load/unload/download, per-model engine choice, memory estimates, auto-pick a model per chat,
  side-by-side comparison
- **Saved prompts:** type `/` for built-ins (`/fix`, `/review`, `/security`, …) or add your own
- **Images:** attach, paste or drop images for vision models

## Requirements

- macOS on Apple Silicon, Node.js 18+
- LM Studio with its `lms` CLI (`~/.lmstudio/bin/lms`)
- Optional: a local llama.cpp build at `~/llama.cpp/build/bin/llama-server` (the "LocalPilot engine")

## Run and build

```bash
npm install
npm start                 # run in development
npm run package           # build dist/LocalPilot-darwin-arm64/LocalPilot.app
```

## The LocalPilot engine (llama.cpp)

Models whose architecture matches Qwen3.5/3.6 run on a local llama.cpp build by default; any model can be switched
in **Manage**. Two fixes are needed on macOS 13 (Ventura):

1. **`engine/ventura-metal-fix.patch`**: `newBufferWithBytesNoCopy` returns nil for non-page-aligned memory on older
   macOS, which made `ggml_metal_get_tensor_async` abort (`GGML_ASSERT(buf_dst)`) for hybrid models such as
   Qwen3.5. The patch falls back to a synchronous copy through a temporary buffer. Apply it to llama.cpp and build:

   ```bash
   git -C ~/llama.cpp apply ~/projects/localpilot/engine/ventura-metal-fix.patch
   cmake -S ~/llama.cpp -B ~/llama.cpp/build -DCMAKE_BUILD_TYPE=Release && cmake --build ~/llama.cpp/build -j --target llama-server
   ```

2. **`engine/bf16_to_f16.py`**: Ventura has no Metal bfloat kernels, so BF16 vision projectors (`mmproj-*-BF16.gguf`)
   crash on the GPU. Convert them to F16 (uses llama.cpp's `gguf-py`; needs numpy):

   ```bash
   python3 engine/bf16_to_f16.py mmproj-…-BF16.gguf mmproj-…-F16.gguf
   ```

On the LocalPilot engine, non-Qwen models use a q8 KV cache (about twice the context), Gemma 4 uses an MTP draft
model from `~/models/mtp-gemma-4-12B-it.gguf` when present (~30% faster here), and vision projectors next to the
model file are loaded automatically.
