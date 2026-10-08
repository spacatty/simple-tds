# Panel UI
FROM node:22-alpine AS ui
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Server
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=ui /src/internal/web/ui/dist ./internal/web/ui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tds ./cmd/tds

FROM alpine:3.22
RUN apk add --no-cache ca-certificates \
 && adduser -D -u 10001 tds \
 && mkdir -p /data/whitepages \
 && chown -R tds:tds /data
COPY --from=build /out/tds /usr/local/bin/tds
USER tds
EXPOSE 80 443 8080
ENTRYPOINT ["tds"]
