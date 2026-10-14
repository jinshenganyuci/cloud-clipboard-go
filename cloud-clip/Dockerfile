# syntax=docker/dockerfile:1

# Build both parts from this checkout, including the fork's frontend fixes.
FROM --platform=$BUILDPLATFORM node:24-alpine3.23 AS frontend
WORKDIR /src/web-vue3
COPY web-vue3/package.json web-vue3/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web-vue3/ ./
COPY shortcuts/ /src/shortcuts/
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.23 AS backend
WORKDIR /src/cloud-clip
COPY cloud-clip/go.mod cloud-clip/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cloud-clip/ ./
COPY --from=frontend /src/web-vue3/dist/ ./lib/static/
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
ARG VERSION=dev
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -tags=embed \
    -ldflags="-s -w -X github.com/jonnyan404/cloud-clipboard-go/cloud-clip/lib.server_version=${VERSION}" \
    -o /out/cloud-clipboard-go .

# Keep optional local TLS support without mixing Alpine stable and edge packages.
FROM --platform=$BUILDPLATFORM golang:1.26-alpine3.23 AS certificates
WORKDIR /src/mkcert
RUN go mod init image/mkcert && go get filippo.io/mkcert@v1.4.4
ARG TARGETOS
ARG TARGETARCH
ARG TARGETVARIANT
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH GOARM=${TARGETVARIANT#v} \
    go build -trimpath -ldflags="-s -w" -o /out/mkcert filippo.io/mkcert

FROM alpine:3.23
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Cloud Clipboard Go" \
      org.opencontainers.image.source="https://github.com/jinshenganyuci/cloud-clipboard-go" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$REVISION
RUN apk add --no-cache ca-certificates netcat-openbsd git tzdata
WORKDIR /app/server-node
COPY --from=backend /out/cloud-clipboard-go ./cloud-clipboard-go
COPY --from=certificates /out/mkcert /usr/local/bin/mkcert
COPY --chmod=755 cloud-clip/entrypoint.sh /app/entrypoint.sh
RUN mkdir -p /app/server-node/data

EXPOSE 9501
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
    CMD nc -z 127.0.0.1 "${LISTEN_PORT:-9501}" || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
