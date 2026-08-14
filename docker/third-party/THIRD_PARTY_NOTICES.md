# Third-party notices — Asterism project runtime image

This image is assembled by Patternity from software developed by other people.
**Patternity did not develop Hermes or the Codex CLI**, and claims no authorship
of them. The image adds one layer: it installs the Codex CLI into a pinned
Hermes base image so that Hermes can drive it as a subprocess.

Asterism itself has no software license selected. That says nothing about the
components below, which keep their own licenses and are redistributed under
them.

## Hermes

* Project: Hermes agent runtime
* Copyright: Copyright (c) 2025 Nous Research
* License: MIT
* Full text: `/opt/hermes/LICENSE` inside this image, inherited unmodified from
  the base image.
* Base image: pinned by digest; see the `io.asterism.hermes-base` label on this
  image for the exact reference.

Hermes owns the agent loop, provider integration, tools, memory, approvals, and
execution behavior. Asterism does not modify or reimplement it.

## Codex CLI

* Project: `@openai/codex`
* License: Apache License 2.0
* Full text: `/opt/asterism/third-party/LICENSE.Apache-2.0.txt` inside this
  image.
* Version: see the `io.asterism.codex-version` label on this image.

The npm package does not ship a license file of its own, so the Apache-2.0 text
is included here to satisfy the license's requirement that recipients receive a
copy. No Codex source was modified.

Codex support in Asterism is **experimental and disabled by default**. The
supported runtime is the normal Hermes agent loop.

## Everything else

The base image carries additional operating-system and language packages under
their own licenses. Those are unmodified and their notices remain wherever the
base image placed them; this file does not restate them.
