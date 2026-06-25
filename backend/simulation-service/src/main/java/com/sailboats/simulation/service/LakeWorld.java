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

    private final double worldWidth;
    private final double worldHeight;
    private final boolean botsEnabled;
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

    // Dynamic wind: a global gust factor that breathes over time with occasional
    // squalls, and a venturi ("nozzle") boost where the wind funnels through the
    // gap between two nearby islands.
    private static final double GUST_MIN = 0.65;
    private static final double GUST_MAX = 1.7;
    // Venturi (nozzle): boost between two close islands whose connecting line is
    // within 45 deg of perpendicular to the wind.
    private static final double VENTURI_RANGE = 6.0;
    private static final double VENTURI_MAX = 0.6;
    private static final double PERP_COS_45 = 0.70710678;
    // Lee shadow: wind slows downwind of an island; wind is blocked over islands.
    private static final double SHADOW_LENGTH = 9.0;
    private static final double SHADOW_STRENGTH = 0.6;
    private static final double WIND_BLOCK_FACTOR = 0.12;

    private static final double BOAT_HIT_RADIUS = 0.7;
    private static final double COLLISION_DAMAGE_SCALE = 22.0;
    private static final double COLLISION_CLOSING_THRESHOLD = 0.25;
    private static final long FIRE_COOLDOWN_MS = 2000;
    private static final double PROJECTILE_SPEED = 9.0;
    private static final double PROJECTILE_TTL = 1.1;
    private static final double PROJECTILE_DAMAGE = 16.0;
    private static final long RESPAWN_MS = 5000;

    // AI bots: each lake is topped up so that roughly half the boats are bots
    // ("50% graczy stanowia boty"). They wander the lake and hunt human players.
    private static final int BOT_MAX = 5;
    private static final double BOT_ENGAGE_RANGE = 7.0;
    private static final double BOT_FIRE_RANGE = 5.0;
    private static final double BOT_NOGO_DEG = 42.0;
    // How far ahead a bot looks for hazards, how close it keeps to landmasses and
    // how wide a buffer it leaves around the lake edge before bearing away.
    private static final double BOT_AVOID_LOOKAHEAD = 3.5;
    private static final double BOT_ISLAND_CLEARANCE = 0.9;
    private static final double BOT_EDGE_MARGIN = 2.5;
    // Below this speed while pointing into the wind a bot is "in irons" and must
    // luff its sheets to let the bow blow off the wind before it can sail again.
    private static final double BOT_IRONS_SPEED = 0.3;
    // While recovering, bear away to roughly this many degrees off the wind (a
    // broad reach) to rebuild speed, luffing until the bow is this far off the
    // wind, and stay in recovery until properly powered up past this speed.
    private static final double BOT_RECOVER_REACH_DEG = 100.0;
    private static final double BOT_RECOVER_DRIVE_DEG = 50.0;
    private static final double BOT_RECOVER_EXIT_SPEED = 0.8;
    // When beating, commit to a tack and only switch once the desired heading is
    // well onto the other side of the wind, so bots stop flip-flopping head-up.
    private static final double BOT_TACK_HYSTERESIS_DEG = 25.0;
    private static final String[] BOT_NAMES = {
        "Korsarz", "Pirat Rudy", "Czarny Jack", "Kapitan Hak", "Morski Wilk",
        "Rekin", "Sztorm", "Kraken", "Barakuda", "Mewa"
    };

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

    // Per-bot AI memory (waypoints / repath timers), keyed by bot boat id.
    private final Map<String, BotBrain> botBrains = new ConcurrentHashMap<>();
    private final AtomicLong botSeq = new AtomicLong();

    private final List<Projectile> projectiles = new ArrayList<>();
    private final Queue<Projectile> incoming = new ConcurrentLinkedQueue<>();
    private final AtomicLong projectileSeq = new AtomicLong();

    private final List<Island> islands;
    private final List<IslandDto> islandDtos;
    private List<BuoyDto> buoys = new ArrayList<>();
    private final AtomicLong buoySeq = new AtomicLong();
    private long lastBuoySpawnAt;

    private final double windDirection;
    private final double windStrength = 5.0;
    // Current global gust multiplier, refreshed once per tick.
    private double currentGust = 1.0;

    public LakeWorld(String lakeId, String lakeName, int capacity, long seed,
                     double worldWidth, double worldHeight, double windDirection, boolean botsEnabled) {
        this.lakeId = lakeId;
        this.lakeName = lakeName;
        this.capacity = capacity;
        this.worldWidth = worldWidth;
        this.worldHeight = worldHeight;
        this.windDirection = windDirection;
        this.botsEnabled = botsEnabled;
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

    public double getWorldWidth() {
        return worldWidth;
    }

    public double getWorldHeight() {
        return worldHeight;
    }

    public int boatCount() {
        return boats.size();
    }

    public boolean isEmpty() {
        return boats.isEmpty();
    }

    /** Number of human (non-bot) boats currently on this lake. */
    public int humanCount() {
        int n = 0;
        for (BoatState boat : boats.values()) {
            if (!boat.isBot()) {
                n++;
            }
        }
        return n;
    }

    /** True while at least one human is still on the lake (bots don't keep it alive). */
    public boolean hasHumans() {
        return humanCount() > 0;
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
        // A human opening fire becomes a valid target: bots leave players alone
        // until they start shooting ("dopoki gracz nie zacznie").
        if (!boat.isBot()) {
            boat.setHasFired(true);
        }

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
        maintainBots(now);
        currentGust = gustFactor(now);
        for (BoatState boat : boats.values()) {
            if (boat.isSunk()) {
                boat.setSpeed(0);
                if (now - boat.getSunkAt() >= RESPAWN_MS) {
                    respawn(boat);
                }
                continue;
            }

            double windRad = Math.toRadians(windDirection);

            if (boat.isBot()) {
                // AI helm: steer, trim and fire before the shared physics runs.
                botThink(boat, now);
            }

            if (boat.isAnchored()) {
                double windFrom = windDirection + 180.0;
                double delta = signedDelta(windFrom, boat.getHeading());
                double turnRate = ANCHOR_TURN_RATE * Math.signum(delta) * Math.min(1.0, Math.abs(delta) / 30.0);
                boat.setHeading(normalizeHeading(boat.getHeading() + turnRate * DELTA_SECONDS));
                boat.setSpeed(0);
                continue;
            }

            double windUnits = windStrength * currentGust
                * windFieldFactor(boat.getX(), boat.getY()) / KNOTS_PER_UNIT;
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
            } else if (nextX > worldWidth) {
                nextX = worldWidth;
                nextSpeed *= 0.4;
            }
            if (nextY < 0) {
                nextY = 0;
                nextSpeed *= 0.4;
            } else if (nextY > worldHeight) {
                nextY = worldHeight;
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
        // Fresh life starts peaceful: bots ignore the player again until they fire.
        boat.setHasFired(false);
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
                applyDamage(a, COLLISION_DAMAGE_SCALE * closing * aFactor, now, b.getBoatId());
                applyDamage(b, COLLISION_DAMAGE_SCALE * closing * bFactor, now, a.getBoatId());
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
            if (p.ttl <= 0 || p.x < 0 || p.x > worldWidth || p.y < 0 || p.y > worldHeight) {
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
                    applyDamage(boat, PROJECTILE_DAMAGE, now, p.ownerId);
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

    private void applyDamage(BoatState boat, double amount, long now, String attackerId) {
        if (boat.isSunk() || amount <= 0) {
            return;
        }
        double next = boat.getHealth() - amount;
        if (next <= 0) {
            boat.setHealth(0);
            boat.setSunk(true);
            boat.setSunkAt(now);
            boat.setSpeed(0);
            boat.setDeaths(boat.getDeaths() + 1);
            // Credit the sink to the attacker (cannon fire or ramming).
            if (attackerId != null && !attackerId.equals(boat.getBoatId())) {
                BoatState killer = boats.get(attackerId);
                if (killer != null) {
                    killer.setKills(killer.getKills() + 1);
                }
            }
        } else {
            boat.setHealth(next);
        }
    }

    private SimulationSnapshotDto buildSnapshot(long now) {
        return SimulationSnapshotDto.builder()
            .serverTime(now)
            .windDirection(windDirection)
            .windStrength(windStrength * currentGust)
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
                .kills(boat.getKills())
                .deaths(boat.getDeaths())
                .bot(boat.isBot())
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
            .worldWidth(worldWidth)
            .worldHeight(worldHeight)
            .lakeBoats(humanCount())
            .lakeCapacity(capacity)
            .build();
    }

    private double normalizeHeading(double heading) {
        double normalized = heading % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }

    // ---- AI bots ----------------------------------------------------------

    // Keep bot numbers at ~50% of the lake population: one bot per human, capped.
    private void maintainBots(long now) {
        int humans = humanCount();
        int bots = boats.size() - humans;
        if (!botsEnabled || humans == 0) {
            if (bots > 0) {
                removeAllBots();
            }
            return;
        }
        int desired = Math.min(BOT_MAX, humans);
        while (bots < desired) {
            spawnBot();
            bots++;
        }
        while (bots > desired) {
            despawnOneBot();
            bots--;
        }
    }

    private void spawnBot() {
        long seq = botSeq.incrementAndGet();
        String id = "bot-" + lakeId + "-" + seq;
        BoatState boat = new BoatState();
        boat.setBoatId(id);
        boat.setName(BOT_NAMES[(int) (seq % BOT_NAMES.length)]);
        boat.setBot(true);
        double[] spot = randomFreePosition();
        boat.setX(spot[0]);
        boat.setY(spot[1]);
        boat.setHeading(ThreadLocalRandom.current().nextDouble() * 360.0);
        boat.setSpeed(0);
        boat.setRudder(0);
        boat.setSailTrim(0.8);
        boat.setAnchored(false);
        boat.setHealth(100);
        boat.setSunk(false);
        boats.put(id, boat);
        botBrains.put(id, new BotBrain());
    }

    private void despawnOneBot() {
        for (BoatState boat : boats.values()) {
            if (boat.isBot()) {
                boats.remove(boat.getBoatId());
                botBrains.remove(boat.getBoatId());
                return;
            }
        }
    }

    private void removeAllBots() {
        boats.values().removeIf(BoatState::isBot);
        botBrains.clear();
    }

    // One AI step: pick a heading (hunt the nearest human or wander), steer the
    // rudder toward it, keep the sails drawing and loose a broadside when in range.
    private void botThink(BoatState bot, long now) {
        bot.setAnchored(false);
        double windFrom = windDirection + 180.0;
        BotBrain brain = botBrains.computeIfAbsent(bot.getBoatId(), id -> new BotBrain());

        double signedOff = signedDelta(bot.getHeading(), windFrom);
        double offWind = Math.abs(signedOff);

        // In-irons recovery: when a bot loses way pointing into the wind it can no
        // longer steer, so - exactly like a helmsman - we let the wind blow the bow
        // off and rebuild speed on a reach BEFORE sailing normally again. The state
        // is sticky (commit to one side, power up past BOT_RECOVER_EXIT_SPEED) so
        // the bot does not claw straight back up and stall over and over.
        if (!brain.recovering && bot.getSpeed() < BOT_IRONS_SPEED && offWind < BOT_NOGO_DEG) {
            brain.recovering = true;
            brain.recoverSide = signedOff >= 0 ? 1.0 : -1.0;
        }
        if (brain.recovering) {
            double reach = normalizeHeading(windFrom + brain.recoverSide * BOT_RECOVER_REACH_DEG);
            // Luff while pinned head-to-wind so the fall-off torque turns the bow,
            // then sheet in once it has fallen off far enough to drive.
            bot.setSailTrim(offWind < BOT_RECOVER_DRIVE_DEG ? 0.0 : 0.9);
            double err = signedDelta(reach, bot.getHeading());
            bot.setRudder(Math.max(-1.0, Math.min(1.0, err / 45.0)));
            if (bot.getSpeed() >= BOT_RECOVER_EXIT_SPEED && offWind >= BOT_NOGO_DEG) {
                brain.recovering = false;
            }
            return;
        }

        BoatState target = nearestEnemy(bot);
        double targetHeading;
        if (target != null) {
            double dx = target.getX() - bot.getX();
            double dy = target.getY() - bot.getY();
            double d = Math.hypot(dx, dy);
            double bearing = Math.toDegrees(Math.atan2(dy, dx));
            if (d <= BOT_FIRE_RANGE) {
                // Close: hold the target on the beam to bring a broadside to bear.
                targetHeading = bearing - 90.0;
                botMaybeFire(bot, target, d, now);
            } else {
                // Chase the player down.
                targetHeading = bearing;
            }
        } else {
            targetHeading = botWanderHeading(bot, now);
        }

        // Try to steer clear of islands ahead and keep off the lake edge; if the
        // path is open this leaves the chosen heading untouched (hold course).
        targetHeading = steerClear(bot, targetHeading);

        // Never steer straight into the no-go zone; bear off to close-hauled.
        targetHeading = avoidIrons(targetHeading, windFrom, brain);

        double err = signedDelta(targetHeading, bot.getHeading());
        bot.setRudder(Math.max(-1.0, Math.min(1.0, err / 45.0)));
        // Autotrim: keep the sheets perfectly set so the bot always sails the full
        // speed polar for its point of sail (the polar already shapes drive by
        // angle, so optimal trim is full draught).
        bot.setSailTrim(1.0);
    }

    private BoatState nearestEnemy(BoatState bot) {
        BoatState best = null;
        double bestD = Double.MAX_VALUE;
        for (BoatState other : boats.values()) {
            if (other == bot || other.isSunk() || other.isBot()) {
                continue; // bots hunt humans, not each other
            }
            double dx = other.getX() - bot.getX();
            double dy = other.getY() - bot.getY();
            double d = dx * dx + dy * dy;
            if (d < bestD) {
                bestD = d;
                best = other;
            }
        }
        return best;
    }

    private double botWanderHeading(BoatState bot, long now) {
        BotBrain brain = botBrains.computeIfAbsent(bot.getBoatId(), id -> new BotBrain());
        double dx = brain.wpX - bot.getX();
        double dy = brain.wpY - bot.getY();
        if (now >= brain.repathAt || dx * dx + dy * dy < 2.0) {
            double[] spot = randomFreePosition();
            brain.wpX = spot[0];
            brain.wpY = spot[1];
            brain.repathAt = now + 6000 + (long) (ThreadLocalRandom.current().nextDouble() * 6000);
            dx = brain.wpX - bot.getX();
            dy = brain.wpY - bot.getY();
        }
        return Math.toDegrees(Math.atan2(dy, dx));
    }

    private double avoidIrons(double heading, double windFrom, BotBrain brain) {
        double diff = signedDelta(heading, windFrom);
        if (Math.abs(diff) < BOT_NOGO_DEG) {
            // Pick a tack, but commit to it: only switch sides once the desired
            // heading is well onto the other tack, so the bot stops flip-flopping
            // around dead-upwind (which read as a string of failed tacks).
            double side;
            if (brain.tackSide == 0) {
                side = diff >= 0 ? 1.0 : -1.0;
            } else if (diff > BOT_TACK_HYSTERESIS_DEG) {
                side = 1.0;
            } else if (diff < -BOT_TACK_HYSTERESIS_DEG) {
                side = -1.0;
            } else {
                side = brain.tackSide; // hold the current tack
            }
            brain.tackSide = side;
            return normalizeHeading(windFrom + side * BOT_NOGO_DEG);
        }
        return normalizeHeading(heading);
    }

    // Nudge the desired heading away from islands lying ahead and from the lake
    // edge, using a simple repulsion field. When nothing is in the way the result
    // equals the requested heading, so bots otherwise just hold their course.
    private double steerClear(BoatState bot, double desired) {
        double x = bot.getX();
        double y = bot.getY();
        double rad = Math.toRadians(desired);
        double dirX = Math.cos(rad);
        double dirY = Math.sin(rad);
        double vx = dirX;
        double vy = dirY;

        // Edge repulsion: bear back inside before reaching the boundary.
        if (x < BOT_EDGE_MARGIN) {
            vx += (BOT_EDGE_MARGIN - x) / BOT_EDGE_MARGIN;
        } else if (x > worldWidth - BOT_EDGE_MARGIN) {
            vx -= (x - (worldWidth - BOT_EDGE_MARGIN)) / BOT_EDGE_MARGIN;
        }
        if (y < BOT_EDGE_MARGIN) {
            vy += (BOT_EDGE_MARGIN - y) / BOT_EDGE_MARGIN;
        } else if (y > worldHeight - BOT_EDGE_MARGIN) {
            vy -= (y - (worldHeight - BOT_EDGE_MARGIN)) / BOT_EDGE_MARGIN;
        }

        // Island repulsion: bear away from landmasses that lie ahead within reach.
        for (Island island : islands) {
            double ox = x - island.cx;
            double oy = y - island.cy;
            double d = Math.hypot(ox, oy);
            double influence = island.maxRadius + BOT_ISLAND_CLEARANCE + BOT_AVOID_LOOKAHEAD;
            if (d >= influence || d < 1e-6) {
                continue;
            }
            boolean ahead = (island.cx - x) * dirX + (island.cy - y) * dirY > 0;
            boolean imminent = d < island.maxRadius + BOT_ISLAND_CLEARANCE;
            if (!ahead && !imminent) {
                continue; // island is behind us and not an immediate hazard
            }
            double strength = (influence - d) / influence;
            vx += (ox / d) * strength * 1.8;
            vy += (oy / d) * strength * 1.8;
        }

        if (vx == 0 && vy == 0) {
            return desired;
        }
        return normalizeHeading(Math.toDegrees(Math.atan2(vy, vx)));
    }

    private void botMaybeFire(BoatState bot, BoatState target, double d, long now) {
        if (d > BOT_FIRE_RANGE || now - bot.getLastFireAt() < FIRE_COOLDOWN_MS) {
            return;
        }
        // Hold fire until the player opens up - bots only retaliate, never start it.
        if (!target.isHasFired()) {
            return;
        }
        double bearing = Math.toDegrees(Math.atan2(target.getY() - bot.getY(), target.getX() - bot.getX()));
        double rel = signedDelta(bearing, bot.getHeading());
        double a = Math.abs(rel);
        String side;
        if (a < 30.0) {
            side = "bow";
        } else if (a > 150.0) {
            side = "stern";
        } else {
            side = rel > 0 ? "starboard" : "port";
        }
        fire(bot.getBoatId(), side, 0.6 + ThreadLocalRandom.current().nextDouble() * 0.4);
    }

    // Per-bot navigation memory.
    private static final class BotBrain {
        double wpX;
        double wpY;
        long repathAt;
        boolean recovering;
        double recoverSide;
        double tackSide;
    }

    // ---- Dynamic wind ------------------------------------------------------

    // A global gust factor that breathes over time, with occasional squalls.
    private double gustFactor(long now) {
        double t = now / 1000.0;
        double base = 1.0
            + 0.16 * Math.sin(t * 0.37)
            + 0.11 * Math.sin(t * 0.83 + 1.7)
            + 0.07 * Math.sin(t * 1.9 + 0.5);
        // Squall: a slow wave that, near its peak, adds a sharp stronger gust.
        double squall = Math.sin(t * 0.11 + 2.0);
        if (squall > 0.72) {
            base += (squall - 0.72) / 0.28 * 0.5;
        }
        return Math.max(GUST_MIN, Math.min(GUST_MAX, base));
    }

    // Local wind multiplier: blocked over islands, slowed in their lee shadow,
    // and funnelled (venturi) through a gap between two close islands whose
    // connecting line is within 45 deg of perpendicular to the wind.
    private double windFieldFactor(double x, double y) {
        double windRad = Math.toRadians(windDirection);
        double wx = Math.cos(windRad);
        double wy = Math.sin(windRad);
        double factor = 1.0;

        Island nearA = null;
        Island nearB = null;
        double bestE = Double.MAX_VALUE;
        double secondE = Double.MAX_VALUE;
        double toAx = 0;
        double toAy = 0;
        double toBx = 0;
        double toBy = 0;

        for (Island island : islands) {
            double dx = x - island.cx;
            double dy = y - island.cy;
            double centre = Math.hypot(dx, dy);
            double edge = centre - island.maxRadius;

            // Over the island silhouette (not the circumscribing circle): wind blocked.
            if (edge < 0 && island.contains(x, y)) {
                factor = Math.min(factor, WIND_BLOCK_FACTOR);
            }

            // Lee shadow: downwind of the island, within its cross-wind width.
            if (edge >= 0 && edge < SHADOW_LENGTH) {
                double along = dx * wx + dy * wy; // >0 = downwind of the centre
                double across = Math.abs(-dx * wy + dy * wx);
                double halfWidth = island.maxRadius * 1.1;
                if (along > 0 && across < halfWidth) {
                    double a = 1.0 - Math.min(1.0, along / (SHADOW_LENGTH + island.maxRadius));
                    double c = 1.0 - Math.min(1.0, across / halfWidth);
                    factor *= 1.0 - SHADOW_STRENGTH * a * c;
                }
            }

            // Track the two nearest islands for the venturi test.
            if (edge < VENTURI_RANGE) {
                double ux = centre > 1e-6 ? dx / centre : 0;
                double uy = centre > 1e-6 ? dy / centre : 0;
                if (edge < bestE) {
                    secondE = bestE;
                    nearB = nearA;
                    toBx = toAx;
                    toBy = toAy;
                    bestE = edge;
                    nearA = island;
                    toAx = ux;
                    toAy = uy;
                } else if (edge < secondE) {
                    secondE = edge;
                    nearB = island;
                    toBx = ux;
                    toBy = uy;
                }
            }
        }

        if (nearA != null && nearB != null && secondE < VENTURI_RANGE) {
            double between = -(toAx * toBx + toAy * toBy); // 1 => boat between them
            if (between > 0) {
                double lx = nearB.cx - nearA.cx;
                double ly = nearB.cy - nearA.cy;
                double ll = Math.hypot(lx, ly);
                if (ll > 1e-6) {
                    double align = Math.abs((lx / ll) * wx + (ly / ll) * wy); // 0=perp, 1=parallel
                    if (align <= PERP_COS_45) {
                        double perp = 1.0 - align / PERP_COS_45; // 1 at perfect perpendicular
                        double closeness = Math.max(0, Math.min(1, 1.0 - (bestE + secondE) / (2 * VENTURI_RANGE)));
                        factor *= 1.0 + VENTURI_MAX * perp * closeness * between;
                    }
                }
            }
        }

        return Math.max(0.05, Math.min(1.7, factor));
    }

    // ---- Islands ----------------------------------------------------------

    private List<Island> generateIslands(Random rng) {
        // Fewer, sparser islands on bigger lakes: the count grows with the linear
        // size (not the area), so a huge lake is open water dotted with islands.
        double linearRatio = worldWidth / 28.0;
        int maxCount = Math.max(1, (int) Math.round(ISLAND_MAX_COUNT * linearRatio));
        int maxAttempts = Math.max(4000, maxCount * 300);
        double target = ISLAND_AREA_FRACTION * worldWidth * worldHeight;
        List<Island> result = new ArrayList<>();
        double accumulated = 0;
        int attempts = 0;
        int seq = 0;
        while (accumulated < target && result.size() < maxCount && attempts < maxAttempts) {
            attempts++;
            double baseR = 1.3 + rng.nextDouble() * 1.8;
            double margin = baseR * 1.1 + 0.7;
            double cx = margin + rng.nextDouble() * (worldWidth - 2 * margin);
            double cy = margin + rng.nextDouble() * (worldHeight - 2 * margin);
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
            double x = 2 + r.nextDouble() * (worldWidth - 4);
            double y = 2 + r.nextDouble() * (worldHeight - 4);
            if (!blockedForSpawn(x, y, 1.0)) {
                return new double[] {x, y};
            }
        }
        return new double[] {worldWidth / 2, worldHeight / 2};
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
                    applyDamage(boat, ISLAND_GROUND_DAMAGE, now, null);
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
