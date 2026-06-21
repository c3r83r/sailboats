-- Extra databases created on a fresh Postgres data directory.
-- POSTGRES_DB (sailboats_fleet) is created automatically by the image;
-- the simulation-service keeps its lake/room registry in its own database.
SELECT 'CREATE DATABASE sailboats_simulation'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'sailboats_simulation')\gexec
