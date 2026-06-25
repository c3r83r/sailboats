package com.sailboats.simulation.domain;

/**
 * The three akwen sizes. World size is the side length of the square lake in
 * simulation units; capacity scales with the side length (linear), and the
 * island count scales with area so the land coverage percentage stays constant.
 */
public enum LakeSize {
    SMALL(28.0, 5),
    MEDIUM(84.0, 15),
    LARGE(280.0, 30);

    // Lakes are 16:9 rectangles so they fill the play window without margins.
    private static final double ASPECT = 9.0 / 16.0;

    private final double worldWidth;
    private final int capacity;

    LakeSize(double worldWidth, int capacity) {
        this.worldWidth = worldWidth;
        this.capacity = capacity;
    }

    public double getWorldWidth() {
        return worldWidth;
    }

    public double getWorldHeight() {
        return worldWidth * ASPECT;
    }

    public int getCapacity() {
        return capacity;
    }

    public static LakeSize fromString(String raw, LakeSize fallback) {
        if (raw == null) {
            return fallback;
        }
        try {
            return LakeSize.valueOf(raw.trim().toUpperCase());
        } catch (IllegalArgumentException ex) {
            return fallback;
        }
    }
}
