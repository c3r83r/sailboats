package com.sailboats.simulation.service;

import com.sailboats.common.dto.BoatStateDto;
import com.sailboats.common.dto.ProjectileDto;
import com.sailboats.common.dto.SimulationSnapshotDto;
import com.sailboats.simulation.model.BoatState;
import com.sailboats.simulation.model.ControlInput;
import com.sailboats.simulation.model.Projectile;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Queue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;
import org.springframework.stereotype.Service;

@Service
public class SimulationEngine {

    private static final double WORLD_SIZE = 20.0;
    private static final double DELTA_SECONDS = 0.05;
    private static final double COLLISION_DISTANCE = 1.2;
    private static final double BASE_DRIFT = 0.05;
    // Safety ceiling only; the apparent-wind polar governs real top speed.
    private static final double MAX_SPEED = 2.4;

    // Wind speed and boat speed share one world-unit scale; the UI multiplies
    // both by the same factor to show knots, so "downwind < wind" reads honestly.
    private static final double KNOTS_PER_UNIT = 4.0;
    // How quickly the hull eases toward its terminal (polar) speed each tick.
    private static final double SPEED_RESPONSE = 0.05;

    // Rudder model: most effective near 45deg, beyond that it brakes more than it turns,
    // and it only works when water is flowing past it (the boat has speed).
    private static final double MAX_RUDDER_DEG = 60.0;
    private static final double TURN_GAIN = 70.0;
    private static final double TURN_SPEED_REF = 0.8;
    private static final double RUDDER_DRAG = 0.018;

    // When the sails are luffing and the boat is nearly stopped, the wind blows
    // the bow off to leeward (the boat "falls off") until the sails fill again.
    private static final double FALL_OFF_TORQUE = 55.0;
    private static final double FALL_OFF_DRIVE_REF = 0.12;
    private static final double FALL_OFF_SPEED_REF = 0.45;

    // When anchored the boat is held by the rode and only weather-vanes on it.
    private static final double ANCHOR_TURN_RATE = 60.0;

    // Combat: hull integrity, collision damage and gunnery.
    private static final double BOAT_HIT_RADIUS = 0.7;
    private static final double COLLISION_DAMAGE_SCALE = 22.0;
    private static final double COLLISION_CLOSING_THRESHOLD = 0.25;
    private static final long FIRE_COOLDOWN_MS = 2000;
    private static final double PROJECTILE_SPEED = 9.0;
    private static final double PROJECTILE_TTL = 1.1;
    private static final double PROJECTILE_DAMAGE = 16.0;
    private static final long RESPAWN_MS = 5000;

    private final Map<String, BoatState> boats = new ConcurrentHashMap<>();
    private final Collection<Consumer<SimulationSnapshotDto>> listeners = new ArrayList<>();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    // Projectiles live only on the tick thread; fire() hands new ones over via a queue.
    private final List<Projectile> projectiles = new ArrayList<>();
    private final Queue<Projectile> incoming = new ConcurrentLinkedQueue<>();
    private final AtomicLong projectileSeq = new AtomicLong();

    // 90deg means wind vector points from top to bottom in screen coordinates.
    private volatile double windDirection = 90.0;
    private volatile double windStrength = 5.0;

    @PostConstruct
    void start() {
        scheduler.scheduleAtFixedRate(this::tick, 0, 50, TimeUnit.MILLISECONDS);
    }

    @PreDestroy
    void stop() {
        scheduler.shutdownNow();
    }

    public void upsertBoat(String boatId) {
        boats.computeIfAbsent(boatId, id -> {
            BoatState boat = new BoatState();
            boat.setBoatId(id);
            // Random spawn point inside the lake margins; backend lake is WORLD_SIZE x WORLD_SIZE.
            boat.setX(2 + Math.random() * (WORLD_SIZE - 4));
            boat.setY(2 + Math.random() * (WORLD_SIZE - 4));
            // Random initial heading so the lake doesn't look like a parade.
            boat.setHeading(Math.random() * 360.0);
            boat.setSpeed(0);
            boat.setRudder(0);
            boat.setSailTrim(0);
            // Every new boat arrives at anchor; player drops it with K.
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

    /**
     * Fire a salvo. side: "bow" / "stern" / "port" / "starboard". The longer the
     * gun was charged (power 0..1) the faster and farther the shot travels. A
     * fixed cooldown applies after every salvo.
     */
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
        // Starboard (right of the bow) in screen space where +y points down.
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

    public void addSnapshotListener(Consumer<SimulationSnapshotDto> listener) {
        listeners.add(listener);
    }

    private void tick() {
        try {
            doTick();
        } catch (Throwable ex) {
            // Guard against silent ScheduledExecutorService task death: a single
            // uncaught Throwable (including Error, e.g. a stale-jar NoSuchMethodError)
            // permanently cancels all future executions of scheduleAtFixedRate.
            System.err.println("[SimulationEngine] tick() threw unexpectedly: " + ex);
            ex.printStackTrace();
        }
    }

    private void doTick() {
        long now = System.currentTimeMillis();
        for (BoatState boat : boats.values()) {
            // A sunk hull drifts to a stop and respawns fresh after a short delay.
            if (boat.isSunk()) {
                boat.setSpeed(0);
                if (now - boat.getSunkAt() >= RESPAWN_MS) {
                    respawn(boat);
                }
                continue;
            }

            // Wind is constant and blows straight down the screen (windDirection = 90).
            double windRad = Math.toRadians(windDirection);

            if (boat.isAnchored()) {
                // Held by the rode: don't translate, just weather-vane the bow into
                // the wind. Wind comes FROM (windDirection + 180).
                double windFrom = windDirection + 180.0;
                double delta = signedDelta(windFrom, boat.getHeading());
                double turnRate = ANCHOR_TURN_RATE * Math.signum(delta) * Math.min(1.0, Math.abs(delta) / 30.0);
                boat.setHeading(normalizeHeading(boat.getHeading() + turnRate * DELTA_SECONDS));
                boat.setSpeed(0);
                continue;
            }

            // sailTrim (0..1) is how much sail area is actually drawing for the
            // current trim/reef; the point-of-sail speed curve lives here so a
            // dead run can never outrun the true wind, while a reach/beat can.
            double windUnits = windStrength / KNOTS_PER_UNIT;
            double windFrom = windDirection + 180.0;
            double beta = Math.abs(signedDelta(windFrom, boat.getHeading())); // 0 = head to wind, 180 = run

            // Terminal speed for this course and sail setting (apparent-wind polar).
            double targetSpeed = windUnits * speedPolar(beta) * boat.getSailTrim();

            // Ease the hull toward its terminal speed (first-order, always stable).
            double nextSpeed = boat.getSpeed() + (targetSpeed - boat.getSpeed()) * SPEED_RESPONSE;
            nextSpeed = Math.max(0, Math.min(MAX_SPEED, nextSpeed));

            // Rudder steering: torque peaks at ~45deg and needs water flow (speed) to bite.
            double rudderRad = Math.toRadians(boat.getRudder() * MAX_RUDDER_DEG);
            double flow = Math.min(1.0, nextSpeed / TURN_SPEED_REF);
            double turn = TURN_GAIN * Math.sin(2 * rudderRad) * flow;
            double nextHeading = normalizeHeading(boat.getHeading() + turn * DELTA_SECONDS);

            // A deflected rudder also brakes; the deeper the angle, the more drag.
            double rudderBrake = 1.0 - RUDDER_DRAG * Math.abs(Math.sin(rudderRad)) * flow;
            nextSpeed *= Math.max(0.5, rudderBrake);

            // Fall off: with no drive from the sails and almost no way on, the
            // wind pushes the bow toward the leeward side until the sails fill.
            double idle = 1.0 - Math.min(1.0, boat.getSailTrim() / FALL_OFF_DRIVE_REF);
            double slow = 1.0 - Math.min(1.0, nextSpeed / FALL_OFF_SPEED_REF);
            double blow = idle * slow;
            if (blow > 0.001) {
                double offIrons = signedDelta(nextHeading, windFrom); // 0 = bow dead into wind
                double side;
                if (Math.abs(boat.getRudder()) > 0.05) {
                    side = Math.signum(boat.getRudder());
                } else if (Math.abs(offIrons) > 0.5) {
                    side = Math.signum(offIrons);
                } else {
                    side = 1.0; // dead in irons with no helm: pick a consistent tack
                }
                // Push is strongest dead into the wind and fades as the boat bears away.
                double closeness = Math.max(0.0, Math.cos(Math.toRadians(offIrons)));
                double push = FALL_OFF_TORQUE * blow * closeness;
                nextHeading = normalizeHeading(nextHeading + side * push * DELTA_SECONDS);
            }

            double headingRad = Math.toRadians(nextHeading);
            double nextX = boat.getX() + Math.cos(headingRad) * nextSpeed * DELTA_SECONDS;
            double nextY = boat.getY() + Math.sin(headingRad) * nextSpeed * DELTA_SECONDS;

            // Small constant drift with the wind so furled sails still move slightly.
            // When the sails are luffing (blow high) the stalled hull slides
            // noticeably more to leeward (downwind).
            double driftFactor = BASE_DRIFT * (1.0 + 2.5 * blow);
            nextX += Math.cos(windRad) * driftFactor * DELTA_SECONDS;
            nextY += Math.sin(windRad) * driftFactor * DELTA_SECONDS;

            // Keep the boat inside the closed lake and bleed off speed at the shore.
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
        updateProjectiles(now);
        broadcastSnapshot();
    }

    private void respawn(BoatState boat) {
        boat.setX(2 + Math.random() * (WORLD_SIZE - 4));
        boat.setY(2 + Math.random() * (WORLD_SIZE - 4));
        boat.setHeading(Math.random() * 360.0);
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

                // Contact normal from a to b (fall back to a fixed axis if concentric).
                double nx;
                double ny;
                if (distance < 1e-4) {
                    nx = 1;
                    ny = 0;
                } else {
                    nx = dx / distance;
                    ny = dy / distance;
                }

                // Push the hulls apart so they can never overlap or pass through.
                double overlap = (COLLISION_DISTANCE - distance) / 2.0;
                a.setX(a.getX() - nx * overlap);
                a.setY(a.getY() - ny * overlap);
                b.setX(b.getX() + nx * overlap);
                b.setY(b.getY() + ny * overlap);

                // Closing speed along the contact normal (how hard they meet).
                double avx = Math.cos(Math.toRadians(a.getHeading())) * a.getSpeed();
                double avy = Math.sin(Math.toRadians(a.getHeading())) * a.getSpeed();
                double bvx = Math.cos(Math.toRadians(b.getHeading())) * b.getSpeed();
                double bvy = Math.sin(Math.toRadians(b.getHeading())) * b.getSpeed();
                double closing = (avx - bvx) * nx + (avy - bvy) * ny;

                a.setSpeed(a.getSpeed() * 0.5);
                b.setSpeed(b.getSpeed() * 0.5);

                if (closing <= COLLISION_CLOSING_THRESHOLD) {
                    // Resting or separating contact: separate but don't grind damage.
                    continue;
                }

                // Each boat's damage depends on WHERE its own hull was struck:
                // bow = light, beam & stern = heavy. Contact comes from +normal for
                // a (toward b) and -normal for b (toward a).
                double aFactor = hitFactor(a.getHeading(), nx, ny);
                double bFactor = hitFactor(b.getHeading(), -nx, -ny);
                applyDamage(a, COLLISION_DAMAGE_SCALE * closing * aFactor, now);
                applyDamage(b, COLLISION_DAMAGE_SCALE * closing * bFactor, now);
            }
        }
    }

    // Damage multiplier by where the hull is struck, relative to its heading:
    // bow (front) ~0.4, beam & stern ~1.0.
    private double hitFactor(double heading, double nx, double ny) {
        double fx = Math.cos(Math.toRadians(heading));
        double fy = Math.sin(Math.toRadians(heading));
        double forward = nx * fx + ny * fy; // 1 = bow, -1 = stern, 0 = beam
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

    private void broadcastSnapshot() {
        SimulationSnapshotDto snapshot = SimulationSnapshotDto.builder()
            .serverTime(System.currentTimeMillis())
            .windDirection(windDirection)
            .windStrength(windStrength)
            .boats(boats.values().stream().map(boat -> BoatStateDto.builder()
                .boatId(boat.getBoatId())
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
            .build();

        for (Consumer<SimulationSnapshotDto> listener : listeners) {
            listener.accept(snapshot);
        }
    }

    private double normalizeHeading(double heading) {
        double normalized = heading % 360;
        return normalized < 0 ? normalized + 360 : normalized;
    }

    // Speed polar: terminal boat speed as a fraction of the true wind speed for a
    // given angle off the wind. beta is 0 at head-to-wind and 180 dead downwind.
    // Close-hauled and reaching values exceed 1.0 because the boat builds its own
    // apparent wind and can outrun the true wind; dead downwind stays below 1.0
    // since you can never sail faster than the wind that is pushing you.
    private static final double[] POLAR_BETA = { 0, 28, 35, 45, 60, 90, 120, 150, 170, 180 };
    private static final double[] POLAR_VALUE = { 0, 0, 0.55, 0.85, 1.05, 1.18, 1.12, 0.92, 0.80, 0.78 };

    private double speedPolar(double beta) {
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

    // Shortest signed difference (from - to) normalised to [-180, 180].
    private double signedDelta(double from, double to) {
        double d = (from - to) % 360.0;
        if (d < -180.0) {
            d += 360.0;
        } else if (d > 180.0) {
            d -= 360.0;
        }
        return d;
    }
}
