# Third-party notices

PentCloud builds on [PentAGI](https://github.com/vxcontrol/pentagi). The root
[MIT license](../LICENSE), upstream prompt manifest and original prompt/schema
notices retain its attribution. Cloudflare Agents Starter presentation patterns
are attributed below.

The [preserved PentAGI reference](../upstream/pentagi/README.md) includes the original
template hashes and the frozen paragraph-level adaptation record. Current native
Markdown defaults are maintained directly; retiring the generator and duplicate
prompt directory does not remove that source or attribution.

The Go runtime license accompanies its source assets under
`apps/control-plane/src/native/assets`. Diagrams include Source Sans Pro;
its [OFL notice](../media/fonts/SourceSansPro-OFL.txt) accompanies the exports.
OpenCode schema fixtures retain their [source and MIT notice](../apps/control-plane/test/fixtures/opencode/README.md).
Dependency versions are recorded in [package-lock.json](../package-lock.json);
those dependencies retain their own licenses.

This repository distributes source and documentation, not node_modules,
Container layers or scanner binaries. Tool-package images and the Kali image
used by existing legacy installations have their own licenses. When redistributing compiled
bundles, images or dependencies, preserve the applicable notices and review
any source-distribution requirements. The root license does not replace them.

The following supplemental license texts accompany the relevant packages and
adapted source.

## khroma 2.1.0

```text
The MIT License (MIT)

Copyright (c) 2019-present Fabio Spampinato, Andrew Maney

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## xmlhttprequest-ssl 2.1.2

```text
Copyright (c) 2010 passive.ly LLC

 Permission is hereby granted, free of charge, to any person
 obtaining a copy of this software and associated documentation
 files (the "Software"), to deal in the Software without
 restriction, including without limitation the rights to use,
 copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following
 conditions:

 The above copyright notice and this permission notice shall be
 included in all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
 OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
 WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
 OTHER DEALINGS IN THE SOFTWARE.
```

## Cloudflare Agents Starter chat UI

The chat presentation adapts the Kumo/Streamdown layout and tool-state patterns
from [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter/tree/4ea6a72cbabe2b62a66294214361ac106b4a247e),
commit `4ea6a72cbabe2b62a66294214361ac106b4a247e`. PentCloud connects those
patterns to its existing native OpenCode session projection.

```text
MIT License Copyright (c) 2025 Cloudflare Inc.

Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice
(including the next paragraph) shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
