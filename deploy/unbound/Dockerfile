# Recursive DNS resolver for the DNS blocklists (Spamhaus, SURBL, URIBL). They
# refuse queries relayed by public resolvers, so tds asks through this one,
# which talks to their name servers from this server's own address.
FROM alpine:3.22
RUN apk add --no-cache unbound
COPY unbound.conf /etc/unbound/unbound.conf
USER unbound
ENTRYPOINT ["unbound", "-d", "-c", "/etc/unbound/unbound.conf"]
