FROM golang:1.24-alpine AS build
WORKDIR /src
COPY checker/ checker/
COPY server/ server/
COPY go.work go.work
RUN cd server && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ledgerd ./cmd/ledgerd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ledgerd /ledgerd
EXPOSE 8080
ENTRYPOINT ["/ledgerd"]
