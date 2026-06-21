# Multi-stage build for any backend service in the Maven reactor.
# Pick the service with: --build-arg SERVICE=simulation-service|fleet-service|telemetry-service

# ---- Stage 1: build all modules once (layer-cached across services) ----
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace

# Resolve dependencies first so they are cached unless a pom.xml changes.
COPY pom.xml .
COPY common-lib/pom.xml common-lib/
COPY simulation-service/pom.xml simulation-service/
COPY fleet-service/pom.xml fleet-service/
COPY telemetry-service/pom.xml telemetry-service/
RUN mvn -B -q -DskipTests dependency:go-offline

# Build the reactor (each service repackages into an executable jar).
COPY common-lib/src common-lib/src
COPY simulation-service/src simulation-service/src
COPY fleet-service/src fleet-service/src
COPY telemetry-service/src telemetry-service/src
RUN mvn -B -q -DskipTests clean package

# ---- Stage 2: slim runtime image with only the selected service jar ----
FROM eclipse-temurin:21-jre AS runtime
ARG SERVICE
WORKDIR /app

# Run as a non-root user (least privilege).
RUN groupadd --system app && useradd --system --gid app app
COPY --from=build /workspace/${SERVICE}/target/${SERVICE}-*.jar app.jar
RUN chown -R app:app /app
USER app

ENV JAVA_OPTS="-XX:MaxRAMPercentage=75.0"
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar /app/app.jar"]
