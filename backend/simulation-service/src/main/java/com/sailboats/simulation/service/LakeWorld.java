package com.sailboats.simulation.service;

import com.sailboats.common.dto.BoatStateDto;
import com.sailboats.common.dto.BuoyDto;
import com.sailboats.common.dto.IslandDto;
import com.sailboats.common.dto.PointDto;
import com.sailboats.common.dto.ProjectileDto;
import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.model.BoatState;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.model.Projectile;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.Random;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * One isolated simulation world: a single lake (akwen) with its own boats,
 * islands, health buoys and projectiles. The physics here used to live in
 * {@code SimulationEngine}; that class is now a manager that owns many of these
 * worlds and ticks them all.
 *
 * <p>The island layout is generated deterministically from the lake's seed, so
 * the same lake row always rebuilds to the same geography.
 */
public class LakeWorld {

    private static final double WORLD_SIZE = 20.0;
    private static final double DELTA_SECONDS = 0.05;
    private static final double COLLISION_DISTANCE = 1.2;
    private static final double BASE_DRIFT = 0.05;
    private static final double MAX_SPEED = 2.4;

    private static final double KNOTS_PER_UNIT = 4.0;
    private static final double SPEED_RESPONSE = 0.05;

    private static final double MAX_RUDDER_DEG = 60.0;
    private static final double TURN_GAIN = 70.0;
    private static final double TURN_SPEED_REF = 0.8;
    private static final double RUDDER_DRAG = 0.018;

    private static final double FALL_OFF_TORQUE = 55.0;
    private static final double FALL_OFF_DRIVE_REF = 0.12;
    private static final double FALL_OFF_SPEED_REF = 0.45;

    private static final double ANCHOR_TURN_RATE = 60.0;

    private static final double BOAT_HIT_RADIUS = 0.7;
    private static final double COLLISION_DAMAGE_SCALE = 22.0;
    private static final double COLLISION_CLOSING_THRESHOLD = 0.25;
    private static final long FIRE_COOLDOWN_MS = 2000;
    private static final double PROJECTILE_SPEED = 9.0;
    private static final double PROJECTILE_TTL = 1.1;
    private static final double PROJECTILE_DAMAGE = 16.0;
    private static final long RESPAWN_MS = 5000;

    private static final double TWO_PI = Math.PI * 2;

    // Health pickups: green buoys that patch part of the hull when reached.
    private static final int BUOY_MAX = 3;
    private static final long BUOY_SPAWN_MS = 15000;
    private static final double BUOY_PICKUP_RADIUS = 0.75;
    private static final double BUOY_HEAL = 30.0;

    // Islands: irregular no-go landmasses covering ~11% of the lake, max 4 of them.
    private static final double ISLAND_AREA_FRACTION = 0.11;
    private static final int ISLAND_MAX_COUNT = 4;
    private static final double ISLAND_SHORE_MARGIN = 0.35;
    private static final double ISLAND_GROUND_DAMAGE = 6.0;
    private static final long ISLAND_GROUND_INTERVAL_MS = 900;

    private final String lakeId;
    private final String lakeName;
    private final int capacity;

    private final Map<String, BoatState> boats = new ConcurrentHashMap<>();

    private final List<Projectile> projectiles = new ArrayList<>();
    private final Queue<Projectile> incoming = new ConcurrentLinkedQueue<>();
    private final AtomicLong projectileSeq = new AtomicLong();

    private final List<Island> islands;
    private final List<IslandDto> islandDtos;
    private List<BuoyDto> buoys = new ArrayList<>();
    private final AtomicLong buoySeq = new AtomicLong();
    private long lastBuoySpawnAt;

    private final double windDirection = 90.0;
    private final double windStrength = 5.0;

    public LakeWorld(String lakeId, String lakeName, int capacity, long seed) {
        this.lakeId = lakeId;
        this.lakeName = lakeName;
        this.capacity = capacity;
        this.islands = generateIslands(new Random(seed));
        this.islandDtos = this.islands.stream().map(i -> i.dto).toList();
        // Spawn the first buoy on the first tick, then one every BUOY_SPAWN_MS.
        this.lastBuoySpawnAt = System.currentTimeMillis() - BUOY_SPAWN_MS;
    }

    public String getLakeId() {
        return lakeId;
    }

    public int getCapacity() {
        return capacity;
    }

    public int boatCount() {
        return boats.size();
    }

    public boolean isEmpty() {
        return boats.isEmpty();
    }

    public void addBoat(String boatId, String name) {
        boats.computeIfAbsent(boatId, id -> {
            BoatState boat = new BoatState();
            boat.setBoatId(id);
            boat.setName(name);
            double[] spot = randomFreePosition();
            boat.setX(spot[0]);
            boat.setY(spot[1]);
            boat.setHeading(ThreadLocalRandom.current().nextDouble() * 360.0);
            boat.setSpeed(0);
            boat.setRudder(0);
            boat.setSailTrim(0);
            boat.setAnchored(true);
            boat.setHealth(100);
            boat.setSunk(false);
            return boat;
        });
    }

    public void removeBoat(String boatId) {
        boats.remove(boatId);
    }

    public void updateControls(ControlInput input) {
        BoatState boat = boats.get(input.boatId());
        if (boat == null || boat.isSunk()) {
            return;
        }
        boat.setRudder(Math.max(-1, Math.min(1, input.rudder())));
        boat.setSailTrim(Math.max(0, Math.min(1, input.sailTrim())));
        boat.setAnchored(input.anchored());
    }

    public void fire(String boatId, String side, double power) {
        BoatState boat = boats.get(boatId);
        if (boat == null || boat.isSunk() || side == null) {
            return;
        }
        long now = System.currentTimeMillis();
        if (now - boat.getLastFireAt() < FIRE_COOLDOWN_MS) {
            return;
        }
        boat.setLastFireAt(now);

        double p = Math.max(0, Math.min(1, power));
        double speed = PROJECTILE_SPEED * (0.45 + 0.55 * p);
        double ttl = PROJECTILE_TTL * (0.5 + 0.5 * p);

        double headingRad = Math.toRadians(boat.getHeading());
        double fx = Math.cos(headingRad);
        double fy = Math.sin(headingRad);
        double sx = -fy;
        double sy = fx;
        double bx = boat.getX();
        double by = boat.getY();

        switch (side) {
            case "bow" -> spawn(boat, bx + fx * 0.7, by + fy * 0.7, fx, fy, speed, ttl);
            case "stern" -> spawn(boat, bx - fx * 0.7, by - fy * 0.7, -fx, -fy, speed, ttl);
            case "starboard" -> {
                spawn(boat, bx + fx * 0.3 + sx * 0.5, by + fy * 0.3 + sy * 0.5, sx, sy, speed, ttl);
                spawn(boat, bx - fx * 0.3 + sx * 0.5, by - fy * 0.3 + sy * 0.5, sx, sy, speed, ttl);
            }
            case "port" -> {
                spawn(boat, bx + fx * 0.3 - sx * 0.5, by + fy * 0.3 - sy * 0.5, -sx, -sy, speed, ttl);
                spawn(boat, bx - fx * 0.3 - sx * 0.5, by - fy * 0.3 - sy * 0.5, -sx, -sy, speed, ttl);
            }
            default -> {
            }
        }
    }

    private void spawn(BoatState owner, double x, double y, double dirX, double dirY, double speed, double ttl) {
        String id = owner.getBoatId() + "-" + projectileSeq.incrementAndGet();
        incoming.add(new Projectile(id, owner.getBoatId(), x, y, dirX * speed, dirY * speed, ttl));
    }

    /** Advance the world one tick and return a snapshot (without lakeTotal, set by the manager). */
    public SimulationSnapshotDto tick(long now) {
        for (BoatState boat : boats.values()) {
            if (boat.isSunk()) {
                boat.setSpeed(0);
                if (now - boat.getSunkAt() >= RESPAWN_MS) {
                    respawn(boat);
                }
                continue;
            }

            double windRad = Math.toRadians(windDirection);

            if (boat.isAnchored()) {
                double windFrom = windDirection + 180.0;
                double delta = signedDelta(windFrom, boat.getHeading());
                double turnRate = ANCHOR_TURN_RATE * Math.signum(delta) * Math.min(1.0, Math.abs(delta) / 30.0);
                boat.setHeading(normalizeHeading(boat.getHeading() + turnRate * DELTA_SECONDS));
                boat.setSpeed(0);
                continue;
            }

            double windUnits = windStrength / KNOTS_PER_UNIT;
            double windFrom = windDirection + 180.0;
            double beta = Math.abs(signedDelta(windFrom, boat.getHeading()));

            double targetSpeed = windUnits * speedPolar(beta) * boat.getSailTrim();

            double nextSpeed = boat.getSpeed() + (targetSpeed - boat.getSpeed()) * SPEED_RESPONSE;
            nextSpeed = Math.max(0, Math.min(MAX_SPEED, nextSpeed));

            double rudderRad = Math.toRadians(boat.getRudder() * MAX_RUDDER_DEG);
            double flow = Math.min(1.0, nextSpeed / TURN_SPEED_REF);
            double turn = TURN_GAIN * Math.sin(2 * rudderRad) * flow;
            double nextHeading = normalizeHeading(boat.getHeading() + turn * DELTA_SECONDS);

            double rudderBrake = 1.0 - RUDDER_DRAG * Math.abs(Math.sin(rudderRad)) * flow;
            nextSpeed *= Math.max(0.5, rudderBrake);

            double idle = 1.0 - Math.min(1.0, boat.getSailTrim() / FALL_OFF_DRIVE_REF);
            double slow = 1.0 - Math.min(1.0, nextSpeed / FALL_OFF_SPEED_REF);
            double blow = idle * slow;
            if (blow > 0.001) {
                double offIrons = signedDelta(nextHeading, windFrom);
                double sideSign;
                if (Math.abs(boat.getRudder()) > 0.05) {
                    sideSign = Math.signum(boat.getRudder());
                } else if (Math.abs(offIrons) > 0.5) {
                    sideSign = Math.signum(offIrons);
                } else {
                    sideSign = 1.0;
                }
                double closeness = Math.max(0.0, Math.cos(Math.toRadians(offIrons)));
                double push = FALL_OFF_TORQUE * blow * closeness;
                nextHeading = normalizeHeading(nextHeading + sideSign * push * DELTA_SECONDS);
            }

            double headingRad = Math.toRadians(nextHeading);
            double nextX = boat.getX() + Math.cos(headingRad) * nextSpeed * DELTA_SECONDS;
            double nextY = boat.getY() + Math.sin(headingRad) * nextSpeed * DELTA_SECONDS;

            double driftFactor = BASE_DRIFT * (1.0 + 2.5 * blow);
            nextX += Math.cos(windRad) * driftFactor * DELTA_SECONDS;
            nextY += Math.sin(windRad) * driftFactor * DELTA_SECONDS;

            if (nextX < 0) {
                nextX = 0;
                nextSpeed *= 0.4;
            } else if (nextX > WORLD_SIZE) {
                nextX = WORLD_SIZE;
                nextSpeed *= 0.4;
            }
            if (nextY < 0) {
                nextY = 0;
                nextSpeed *= 0.4;
            } else if (nextY > WORLD_SIZE) {
                nextY = WORLD_SIZE;
                nextSpeed *= 0.4;
            }

            boat.setHeading(nextHeading);
            boat.setSpeed(nextSpeed);
            boat.setX(nextX);
            boat.setY(nextY);
        }

        detectCollisions(now);
        resolveIslandCollisions(now);
        handleBuoys(now);
        updateProjectiles(now);
        return buildSnapshot(now);
    }

    private void respawn(BoatState boat) {
        double[] spot = randomFreePosition();
        boat.setX(spot[0]);
        boat.setY(spot[1]);
        boat.setHeading(ThreadLocalRandom.current().nextDouble() * 360.0);
        boat.setSpeed(0);
        boat.setRudder(0);
        boat.setSailTrim(0);
        boat.setAnchored(true);
        boat.setHealth(100);
        boat.setSunk(false);
    }

    private void detectCollisions(long now) {
        var entries = new ArrayList<>(boats.values());
        for (int i = 0; i < entries.size(); i++) {
            for (int j = i + 1; j < entries.size(); j++) {
                BoatState a = entries.get(i);
                BoatState b = entries.get(j);
                if (a.isSunk() || b.isSunk()) {
                    continue;
                }
                double dx = b.getX() - a.getX();
                double dy = b.getY() - a.getY();
                double distance = Math.sqrt(dx * dx + dy * dy);
                if (distance >= COLLISION_DISTANCE) {
                    continue;
                }

                double nx;
                double ny;
                if (distance < 1e-4) {
                    nx = 1;
                    ny = 0;
                } else {
                    nx = dx / distance;
                    ny = dy / distance;
                }

                double overlap = (COLLISION_DISTANCE - distance) / 2.0;
                a.setX(a.getX() - nx * overlap);
                a.setY(a.getY() - ny * overlap);
                b.setX(b.getX() + nx * overlap);
                b.setY(b.getY() + ny * overlap);

                double avx = Math.cos(Math.toRadians(a.getHeading())) * a.getSpeed();
                double avy = Math.sin(Math.toRadians(a.getHeading())) * a.getSpeed();
                double bvx = Math.cos(Math.toRadians(b.getHeading())) * b.getSpeed();
                double bvy = Math.sin(Math.toRadians(b.getHeading())) * b.getSpeed();
                double closing = (avx - bvx) * nx + (avy - bvy) * ny;

                a.setSpeed(a.getSpeed() * 0.5);
                b.setSpeed(b.getSpeed() * 0.5);

                if (closing <= COLLISION_CLOSING_THRESHOLD) {
                    continue;
                }

                double aFactor = hitFactor(a.getHeading(), nx, ny);
                double bFactor = hitFactor(b.getHeading(), -nx, -ny);
                applyDamage(a, COLLISION_DAMAGE_SCALE * closing * aFactor, now);
                applyDamage(b, COLLISION_DAMAGE_SCALE * closing * bFactor, now);
            }
        }
    }

    private double hitFactor(double heading, double nx, double ny) {
        double fx = Math.cos(Math.toRadians(heading));
        double fy = Math.sin(Math.toRadians(heading));
        double forward = nx * fx + ny * fy;
        return 1.0 - 0.6 * Math.max(0.0, forward);
    }

    private void updateProjectiles(long now) {
        Projectile drained;
        while ((drained = incoming.poll()) != null) {
            projectiles.add(drained);
        }

        var survivors = new ArrayList<Projectile>();
        for (Projectile p : projectiles) {
            p.x += p.vx * DELTA_SECONDS;
            p.y += p.vy * DELTA_SECONDS;
            p.ttl -= DELTA_SECONDS;
            if (p.ttl <= 0 || p.x < 0 || p.x > WORLD_SIZE || p.y < 0 || p.y > WORLD_SIZE) {
                continue;
            }
            if (isInIsland(p.x, p.y)) {
                continue;
            }
            boolean hit = false;
            for (BoatState boat : boats.values()) {
                if (boat.isSunk() || boat.getBoatId().equals(p.ownerId)) {
                    continue;
                }
                double dx = boat.getX() - p.x;
                double dy = boat.getY() - p.y;
                if (dx * dx + dy * dy < BOAT_HIT_RADIUS * BOAT_HIT_RADIUS) {
                    applyDamage(boat, PROJECTILE_DAMAGE, now);
                    hit = true;
                    break;
                }
            }
            if (!hit) {
                survivors.add(p);
            }
        }
        projectiles.clear();
        projectiles.addAll(survivors);
    }

    private void applyDamage(BoatState boat, double amount, long now) {
        if (boat.isSunk() || amount <= 0) {
            return;
        }
        double next = boat.getHealth() - amount;
        if (next <= 0) {
            boat.setHealth(0);
            boat.setSunk(true);
            boat.setSunkAt(now);
            boat.setSpeed(0);
        } else {
            boat.setHealth(next);
        }
    }

    private SimulationSnapshotDto buildSnapshot(long now) {
        return SimulationSnapshotDto.builder()
            .serverTime(now)
            .windDirection(windDirection)
            .windStrength(windStrength)
            .boats(boats.values().stream().map(boat -> BoatStateDto.builder()
                .boatId(boat.getBoatId())
                .name(boat.getName())
                .x(boat.getX())
                .y(boat.getY())
                .heading(boat.getHeading())
                .speed(boat.getSpeed())
                .rudder(boat.getRudder())
                .sailTrim(boat.getSailTrim())
                .anchored(boat.isAnchored())
                .health(boat.getHealth())
                .sunk(boat.isSunk())
                .build()).toList())
            .projectiles(projectiles.stream().map(p -> ProjectileDto.builder()
                .id(p.id)
                .ownerId(p.ownerId)
                .x(p.x)
                .y(p.y)
                .build()).toList())
            .buoys(List.copyOf(buoys))
            .islands(islandDtos)
            .lakeId(lakeId)
            .lakeName(lakeName)
            .lakeBoats(boats.size())
            .lakeCapacity(capacity)
            .build();
    }

    private double normalizeHeading(double heading) {
        double normalized = heading % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }

    // ---- Islands ----------------------------------------------------------

    private List<Island> generateIslands(Random rng) {
        double target = ISLAND_AREA_FRACTION * WORLD_SIZE * WORLD_SIZE;
        List<Island> result = new ArrayList<>();
        double accumulated = 0;
        int attempts = 0;
        int seq = 0;
        while (accumulated < target && result.size() < ISLAND_MAX_COUNT && attempts < 4000) {
            attempts++;
            double baseR = 1.3 + rng.nextDouble() * 1.8;
            double margin = baseR * 1.1 + 0.7;
            double cx = margin + rng.nextDouble() * (WORLD_SIZE - 2 * margin);
            double cy = margin + rng.nextDouble() * (WORLD_SIZE - 2 * margin);
            Island island = buildIsland("island-" + (++seq), cx, cy, baseR, rng);

            boolean overlaps = false;
            for (Island other : result) {
                double d = Math.hypot(cx - other.cx, cy - other.cy);
                if (d < island.maxRadius + other.maxRadius + 0.6) {
                    overlaps = true;
                    break;
                }
            }
            if (overlaps) {
                continue;
            }
            result.add(island);
            accumulated += island.area;
        }
        return result;
    }

    private Island buildIsland(String id, double cx, double cy, double baseR, Random rng) {
        int n = 8 + rng.nextInt(4);
        double[] angles = new double[n];
        double[] radii = new double[n];
        double step = TWO_PI / n;
        for (int i = 0; i < n; i++) {
            angles[i] = i * step + rng.nextDouble() * step * 0.5;
            radii[i] = baseR * (0.62 + rng.nextDouble() * 0.7);
        }
        return new Island(id, cx, cy, angles, radii);
    }

    private boolean isInIsland(double x, double y) {
        for (Island island : islands) {
            if (island.contains(x, y)) {
                return true;
            }
        }
        return false;
    }

    private boolean blockedForSpawn(double x, double y, double pad) {
        for (Island island : islands) {
            double dx = x - island.cx;
            double dy = y - island.cy;
            double d = Math.hypot(dx, dy);
            if (d > island.maxRadius + pad) {
                continue;
            }
            if (d < island.radiusAt(Math.atan2(dy, dx)) + pad) {
                return true;
            }
        }
        return false;
    }

    private double[] randomFreePosition() {
        ThreadLocalRandom r = ThreadLocalRandom.current();
        for (int i = 0; i < 200; i++) {
            double x = 2 + r.nextDouble() * (WORLD_SIZE - 4);
            double y = 2 + r.nextDouble() * (WORLD_SIZE - 4);
            if (!blockedForSpawn(x, y, 1.0)) {
                return new double[] {x, y};
            }
        }
        return new double[] {WORLD_SIZE / 2, WORLD_SIZE / 2};
    }

    private void resolveIslandCollisions(long now) {
        for (BoatState boat : boats.values()) {
            if (boat.isSunk()) {
                continue;
            }
            for (Island island : islands) {
                double dx = boat.getX() - island.cx;
                double dy = boat.getY() - island.cy;
                double d = Math.hypot(dx, dy);
                if (d > island.maxRadius) {
                    continue;
                }
                double theta = d < 1e-6 ? Math.toRadians(boat.getHeading()) : Math.atan2(dy, dx);
                double boundary = island.radiusAt(theta);
                if (d >= boundary) {
                    continue;
                }
                double push = boundary + ISLAND_SHORE_MARGIN;
                boat.setX(island.cx + Math.cos(theta) * push);
                boat.setY(island.cy + Math.sin(theta) * push);

                double impact = boat.getSpeed();
                boat.setSpeed(impact * 0.25);
                if (impact > 0.15 && now - boat.getLastGroundAt() >= ISLAND_GROUND_INTERVAL_MS) {
                    boat.setLastGroundAt(now);
                    applyDamage(boat, ISLAND_GROUND_DAMAGE, now);
                }
            }
        }
    }

    // ---- Health buoys -----------------------------------------------------

    private void handleBuoys(long now) {
        if (!buoys.isEmpty()) {
            List<BuoyDto> remaining = new ArrayList<>(buoys.size());
            for (BuoyDto buoy : buoys) {
                BoatState collector = null;
                for (BoatState boat : boats.values()) {
                    if (boat.isSunk() || boat.getHealth() >= 100) {
                        continue;
                    }
                    double dx = boat.getX() - buoy.x();
                    double dy = boat.getY() - buoy.y();
                    if (dx * dx + dy * dy <= BUOY_PICKUP_RADIUS * BUOY_PICKUP_RADIUS) {
                        collector = boat;
                        break;
                    }
                }
                if (collector != null) {
                    collector.setHealth(Math.min(100, collector.getHealth() + BUOY_HEAL));
                } else {
                    remaining.add(buoy);
                }
            }
            buoys = remaining;
        }

        if (buoys.size() < BUOY_MAX && now - lastBuoySpawnAt >= BUOY_SPAWN_MS) {
            lastBuoySpawnAt = now;
            double[] spot = randomFreePosition();
            buoys.add(BuoyDto.builder()
                .id("buoy-" + buoySeq.incrementAndGet())
                .x(spot[0])
                .y(spot[1])
                .build());
        }
    }

    private static double signedDelta(double from, double to) {
        double d = (from - to) % 360.0;
        if (d < -180.0) {
            d += 360.0;
        } else if (d > 180.0) {
            d -= 360.0;
        }
        return d;
    }

    // Speed polar: terminal boat speed as a fraction of the true wind speed for a
    // given angle off the wind. beta is 0 at head-to-wind and 180 dead downwind.
    // Close-hauled and reaching values exceed 1.0 because the boat builds its own
    // apparent wind and can outrun the true wind; dead downwind stays below 1.0
    // since you can never sail faster than the wind that is pushing you.
    private static final double[] POLAR_BETA = { 0, 28, 35, 45, 60, 90, 120, 150, 170, 180 };
    private static final double[] POLAR_VALUE = { 0, 0, 0.55, 0.85, 1.05, 1.18, 1.12, 0.92, 0.80, 0.78 };

    private static double speedPolar(double beta) {
        double b = Math.abs(beta);
        if (b <= POLAR_BETA[0]) {
            return POLAR_VALUE[0];
        }
        for (int i = 1; i < POLAR_BETA.length; i++) {
            if (b <= POLAR_BETA[i]) {
                double t = (b - POLAR_BETA[i - 1]) / (POLAR_BETA[i] - POLAR_BETA[i - 1]);
                return POLAR_VALUE[i - 1] + t * (POLAR_VALUE[i] - POLAR_VALUE[i - 1]);
            }
        }
        return POLAR_VALUE[POLAR_VALUE.length - 1];
    }

    // Irregular star-shaped landmass.
    private static final class Island {
        final double cx;
        final double cy;
        final double[] angles;
        final double[] radii;
        final double maxRadius;
        final double area;
        final IslandDto dto;

        Island(String id, double cx, double cy, double[] angles, double[] radii) {
            this.cx = cx;
            this.cy = cy;
            this.angles = angles;
            this.radii = radii;

            int n = angles.length;
            double[] xs = new double[n];
            double[] ys = new double[n];
            double maxR = 0;
            List<PointDto> points = new ArrayList<>(n);
            for (int i = 0; i < n; i++) {
                double px = cx + Math.cos(angles[i]) * radii[i];
                double py = cy + Math.sin(angles[i]) * radii[i];
                xs[i] = px;
                ys[i] = py;
                points.add(PointDto.builder().x(px).y(py).build());
                maxR = Math.max(maxR, radii[i]);
            }
            double shoelace = 0;
            for (int i = 0; i < n; i++) {
                int j = (i + 1) % n;
                shoelace += xs[i] * ys[j] - xs[j] * ys[i];
            }
            this.area = Math.abs(shoelace) / 2.0;
            this.maxRadius = maxR;
            this.dto = IslandDto.builder().id(id).points(points).build();
        }

        double radiusAt(double theta) {
            double t = ((theta % TWO_PI) + TWO_PI) % TWO_PI;
            int n = angles.length;
            for (int i = 0; i < n; i++) {
                double a0 = angles[i];
                double a1 = (i + 1 < n) ? angles[i + 1] : angles[0] + TWO_PI;
                double q = (i == n - 1 && t < angles[0]) ? t + TWO_PI : t;
                if (q >= a0 && q <= a1) {
                    double span = a1 - a0;
                    double f = span < 1e-9 ? 0 : (q - a0) / span;
                    double r0 = radii[i];
                    double r1 = (i + 1 < n) ? radii[i + 1] : radii[0];
                    return r0 + (r1 - r0) * f;
                }
            }
            return maxRadius;
        }

        boolean contains(double x, double y) {
            double dx = x - cx;
            double dy = y - cy;
            double d = Math.hypot(dx, dy);
            if (d > maxRadius) {
                return false;
            }
            return d < radiusAt(Math.atan2(dy, dx));
        }
    }
}
