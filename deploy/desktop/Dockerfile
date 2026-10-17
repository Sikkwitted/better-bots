FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb fluxbox x11vnc xdotool scrot firefox-esr novnc websockify \
    ca-certificates fonts-dejavu-core tini procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 1000 --create-home agent
COPY start.sh /usr/local/bin/start-desktop
RUN chmod 755 /usr/local/bin/start-desktop
USER 1000:1000
ENV HOME=/home/agent DISPLAY=:10
EXPOSE 5900 6080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-desktop"]
