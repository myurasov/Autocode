# The web UI: installs the Angular app's packages, runs its unit tests (Vitest
# in Node with jsdom, no browser) and builds the static files into
# /web/dist/web/browser, which the Autocode build puts into the binary.
FROM node:24.22.1-slim

ENV CI=1 NO_COLOR=1 NG_CLI_ANALYTICS=false NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx ng test --watch=false \
  && npx ng build \
  && test -f dist/web/browser/index.html
