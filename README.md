# Sailboats

Sailboats to aplikacja fullstack pokazująca symulację żeglugi wieloosobowej w czasie rzeczywistym.
Projekt jest przygotowany jako portfolio na rozmowę Fullstack Developer (Java + Angular).

## Stack

- Backend: Java 21, Spring Boot 3, Spring WebSocket, Spring Data JPA, Liquibase, Lombok, MapStruct
- Frontend: Angular 17, NgRx, RxJS, TailwindCSS
- Databases: PostgreSQL (fleet-service), MS SQL Server (telemetry-service)
- Architecture: Microservices + event-driven communication (REST + WebSocket)

## Struktura

- `backend/common-lib` - współdzielone DTO
- `backend/simulation-service` - logika symulacji i WebSocket
- `backend/fleet-service` - zarządzanie jednostkami (PostgreSQL)
- `backend/telemetry-service` - zapis telemetrii i zdarzeń (MS SQL)
- `frontend/sailboats-ui` - klient Angular + NgRx

## Uruchomienie środowiska

1. Uruchom bazy i redis:
   - `docker compose up -d`
2. Uruchom backend:
   - `cd backend`
   - `mvn clean install`
   - uruchom serwisy (`simulation-service`, `fleet-service`, `telemetry-service`)
3. Uruchom frontend:
   - `cd frontend/sailboats-ui`
   - `npm install`
   - `npm run start`

## Punkty API i WebSocket

- Fleet API: `http://localhost:8081/api/fleet/boats`
- Telemetry API: `http://localhost:8082/api/telemetry/events`
- Simulation WS: `ws://localhost:8083/ws/simulation`

## Co demonstruje projekt

- Architektura mikroserwisowa i separacja odpowiedzialności
- Programowanie czasu rzeczywistego z WebSocket i RxJS
- Zarządzanie stanem klienta przez NgRx
- Trwałość danych z JPA i Liquibase na dwóch silnikach SQL
- Podstawy fizyki ruchu jednostek (wiatr, ster, żagle, kolizje)

## Roadmapa

Aktualny plan rozwoju znajduje się w [ROADMAP.md](ROADMAP.md).

## Wdrożenie produkcyjne (VPS + Docker Compose)

Cały stack uruchamia się jedną komendą przez `docker-compose.prod.yml`. Edge
oparty na Caddy serwuje frontend, proxuje API/WebSocket do serwisów backendu
i **automatycznie pobiera oraz odnawia certyfikat TLS (HTTPS) z Let's Encrypt**.

### Architektura wdrożenia

```
Internet ──443/80──> caddy (edge: SPA + reverse proxy + TLS)
                       ├── /ws/*            -> simulation-service:8083 (WebSocket)
                       ├── /api/fleet/*     -> fleet-service:8081
                       ├── /api/telemetry/* -> telemetry-service:8082 (profil: telemetry)
                       └── /*               -> statyczny Angular (SPA)
                     postgres:5432 (fleet + simulation)   [tylko sieć wewnętrzna]
                     mssql:1433 (telemetry)               [tylko sieć wewnętrzna, profil telemetry]
```

### Wymagania na VPS

- Linux (Ubuntu 22.04/24.04 LTS), pełny root (KVM)
- Docker Engine + plugin Compose: `apt install docker.io docker-compose-plugin`
- Otwarte porty 80 i 443
- Rekord DNS `A` (oraz opcjonalnie `www`) wskazujący na IP VPS

### Konfiguracja

1. Skopiuj i uzupełnij sekrety oraz domenę:
   - `cp .env.example .env`
   - Ustaw `SITE_ADDRESS=sailboats.com.pl`, `ACME_EMAIL`, `APP_CORS_ALLOWED_ORIGINS=https://sailboats.com.pl`
   - Ustaw silne `POSTGRES_PASSWORD` (np. `openssl rand -base64 24`)
   - Plik `.env` **nie trafia do gita** (jest w `.gitignore`).

2. Start rdzenia (symulacja + fleet + Postgres + edge):
   - `docker compose -f docker-compose.prod.yml up -d --build`

3. (Opcjonalnie) wraz z telemetry + MS SQL (wymaga ~2 GB RAM więcej):
   - `docker compose -f docker-compose.prod.yml --profile telemetry up -d --build`

Po starcie aplikacja jest dostępna pod `https://sailboats.com.pl` (Caddy sam
wystawi certyfikat przy pierwszym żądaniu). Frontend wykrywa adres WebSocket
z origin (`wss://<domena>/ws/simulation`), więc nie trzeba przebudowywać bundla
przy zmianie domeny.

> Konfiguracja jest w pełni przez zmienne środowiskowe — brak zahardkodowanych
> haseł w kodzie. Logi serwisów idą na stdout (zgodnie z 12-factor), więc zbiera
> je `docker compose logs -f`.

