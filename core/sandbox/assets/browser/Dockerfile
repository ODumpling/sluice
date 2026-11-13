# Sluice sandbox browser: Playwright's Chromium (from the official image)
# served by server.mjs. Runs on the sandbox's internal network only; Sluice
# drives it from the host through the gateway, and the browser reaches the app
# by service name. Built (and cached) by @sluice-dev/sandbox; the version must
# match the playwright-core client in @sluice-dev/evidence.
ARG PLAYWRIGHT_VERSION
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ARG PLAYWRIGHT_VERSION
WORKDIR /opt/sluice-browser
RUN echo '{"type":"module","private":true}' > package.json \
  && npm install --no-audit --no-fund --omit=dev playwright-core@${PLAYWRIGHT_VERSION} \
  && npm cache clean --force
COPY server.mjs ./
USER pwuser
EXPOSE 3000
CMD ["node", "/opt/sluice-browser/server.mjs"]
