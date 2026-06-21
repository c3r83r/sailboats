# ---- Stage 1: build the Angular production bundle ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Stage 2: Caddy edge (static files + reverse proxy + automatic HTTPS) ----
FROM caddy:2-alpine AS runtime
COPY --from=build /app/dist/sailboats-ui/browser /srv
COPY Caddyfile /etc/caddy/Caddyfile
