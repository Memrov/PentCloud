# PentCloud diagrams

The README and [architecture guide](../docs/architecture.md) use conceptual
figures, not product screenshots, measured benchmarks or assessment findings.
Editable D2 sources are in [diagrams](diagrams/). Each figure has matching light
and dark PNG/SVG exports; Markdown uses PNGs for broad GitHub/mobile support.

## Render

Install [D2 v0.9.0](https://github.com/d2lang/d2/releases/tag/v0.9.0), then run:

```sh
bash media/render.sh
# Optional binary location:
D2_BIN=/absolute/path/to/d2 bash media/render.sh
```

D2 is optional documentation tooling, not a runtime or application-build
dependency. The script uses ELK layout, themes 101/200 and 24px padding.
Shared styling is in [diagrams/_style.d2](diagrams/_style.d2).
Update editable sources and their exports together; check labels and clipping
at desktop and phone widths.

SVGs embed font subsets and have no external image/font requests or scripts.
Source Sans Pro is distributed under its accompanying
[OFL notice](fonts/SourceSansPro-OFL.txt).

The public [website](https://pentcloud.dev/) includes a
[Storylane tour](https://demo.storylane.com/share/y3kxnxrtlt7i) using Juice Shop,
a deliberately vulnerable demonstration target. Tour playback time is not an
assessment-duration benchmark. Separate conversations do not imply simultaneous
mutating attempts; the [architecture guide](../docs/architecture.md) explains
execution and data boundaries.
