package com.sailboats.fleet.web;

import com.sailboats.fleet.domain.BoatEntity;
import com.sailboats.fleet.repository.BoatRepository;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@Validated
@RestController
@RequiredArgsConstructor
@RequestMapping("/api/fleet/boats")
public class BoatController {

    private final BoatRepository boatRepository;

    @GetMapping
    public List<BoatEntity> all() {
        return boatRepository.findAll();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public BoatEntity create(@RequestBody @Valid CreateBoatRequest request) {
        BoatEntity entity = new BoatEntity();
        entity.setCode(request.code());
        entity.setSkipper(request.skipper());
        entity.setBoatClass(request.boatClass());
        return boatRepository.save(entity);
    }

    public record CreateBoatRequest(
        @NotBlank String code,
        @NotBlank String skipper,
        @NotBlank String boatClass
    ) {
    }
}
