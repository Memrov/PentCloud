# syntax=docker/dockerfile:1
ARG RUNTIME_IMAGE
FROM docker.io/library/golang:1.26.5-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS prepare
RUN apk add --no-cache python3 libarchive-tools ca-certificates && ln -s /usr/bin/bsdtar /usr/local/bin/tar
WORKDIR /src
COPY . .
ARG PACK
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/src/.cache/pack-downloads \
    --mount=type=cache,target=/src/.cache/downloads \
    if [ "$PACK" = recon ]; then python3 scripts/prepare-image.py && cp -a .cache/image-root /prepared; \
    else python3 scripts/prepare-pack.py "$PACK" && cp -a ".cache/packs/$PACK/root" /prepared; fi
FROM ${RUNTIME_IMAGE}
COPY --from=prepare /prepared/ /
ENTRYPOINT ["/bin/sleep", "2147483647"]
CMD []
