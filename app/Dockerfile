FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/scaletest .

# Alpine rather than scratch so there is a shell for debugging over Cycle's
# instance console.
FROM alpine:3.20
COPY --from=build /out/scaletest /usr/local/bin/scaletest
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/scaletest"]
