FROM clamav/clamav:1.4

ENV DEBIAN_FRONTEND=noninteractive
USER root
RUN apk add --no-cache nodejs ca-certificates \
    && mkdir -p /app /run/clamav \
    && chown clamav:clamav /app /run/clamav

# Avoid holding two full signature engines in memory during daily database reloads.
RUN if grep -q '^ConcurrentDatabaseReload ' /etc/clamav/clamd.conf; then \
      sed -i 's/^ConcurrentDatabaseReload .*/ConcurrentDatabaseReload no/' /etc/clamav/clamd.conf; \
    else \
      printf '\nConcurrentDatabaseReload no\n' >> /etc/clamav/clamd.conf; \
    fi

WORKDIR /app
COPY --chown=clamav:clamav server.js ./server.js
COPY --chown=clamav:clamav entrypoint.sh ./entrypoint.sh
RUN chmod 0555 /app/entrypoint.sh
USER clamav
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
