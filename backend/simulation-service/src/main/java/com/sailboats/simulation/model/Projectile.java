package com.sailboats.simulation.model;

/**
 * A cannonball in flight. Mutated only on the simulation tick thread once it has
 * been drained from the incoming queue, so plain mutable fields are fine here.
 */
public class Projectile {
    public String id;
    public String ownerId;
    public double x;
    public double y;
    public double vx;
    public double vy;
    public double ttl;

    public Projectile(String id, String ownerId, double x, double y, double vx, double vy, double ttl) {
        this.id = id;
        this.ownerId = ownerId;
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.ttl = ttl;
    }
}
