# Asterism Phase G Second Project

A second minimal workspace whose only job is to prove **multi-project
operation**: one Node supervising two projects, each in its own container, on its
own host port, reaching its own workspace.

Its content is deliberately distinguishable from `../test-project`. A run in this
project must return this file's heading and never Phase A's — that difference is
the evidence that per-project endpoint resolution routes work to the right
container.

See `PROOF_TASK.md`.
