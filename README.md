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
