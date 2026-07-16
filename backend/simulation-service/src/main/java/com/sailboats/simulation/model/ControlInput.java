package com.sailboats.simulation.model;

public record ControlInput(
    String boatId,
    double rudder,
    double sailTrim,
    double heelLoad,
    boolean anchored
) {
}
