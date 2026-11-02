# The browser for the web UI's smoke test: the Playwright image that matches
# tests/web's @playwright/test, with that project installed. It runs against
# BASE_URL with ADMIN_TOKEN and CONSUMER_TOKEN (see ci/compose/web.yml).
FROM mcr.microsoft.com/playwright:v1.64.1-noble

ENV CI=1 NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /tests/web
COPY tests/web/package.json tests/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tests/web/ ./
CMD ["npx", "playwright", "test"]
