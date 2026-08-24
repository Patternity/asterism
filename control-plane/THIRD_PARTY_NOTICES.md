# Third-party notices — Asterism Control Plane

The Control Plane image bundles software developed by other people. Each
component keeps its own license; this file records the ones whose licenses ask
to be reproduced when the software is redistributed.

Asterism itself has no license selected. That says nothing about the components
below.

## sharp

* Project: sharp — high performance Node.js image processing
* Copyright: Copyright 2013 Lovell Fuller and others
* License: Apache License 2.0
* Full text: `node_modules/sharp/LICENSE` inside the image.

Used to decode uploaded chat images, verify that a file is the format it claims
to be, and re-encode it without EXIF, GPS coordinates, embedded thumbnails or
animation before it is stored.

## libvips

* Project: libvips — a demand-driven image processing library
* Copyright: Copyright (c) libvips contributors
* License: GNU Lesser General Public License v3.0 (LGPL-3.0)
* Source: https://github.com/libvips/libvips

sharp ships prebuilt libvips binaries and links against them dynamically. LGPL
v3 permits that for software under other licenses, on the condition that the
library's own license and source are available and that the library can be
replaced. It is not modified here, and the unmodified upstream source is
available at the URL above.

Its dependencies carried in those prebuilt binaries — among them libwebp (BSD),
libspng and zlib (permissive), and mozjpeg (IJG/BSD-style) — are redistributed
under their own licenses; see the sharp release notes for the exact set for a
given version.

## @fastify/multipart, @fastify/cookie, @fastify/static, @fastify/websocket, fastify

* License: MIT

## pg, zod, argon2

* License: MIT
