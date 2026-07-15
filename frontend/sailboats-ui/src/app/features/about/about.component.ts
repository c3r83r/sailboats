import { NgFor } from '@angular/common';
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface StackGroup {
  title: string;
  items: string[];
}

@Component({
  selector: 'app-about',
  standalone: true,
  imports: [NgFor, RouterLink],
  template: `
    <main class="about">
      <a routerLink="/" class="back-link">&larr; Wróć do gry</a>

      <header class="about-head">
        <h1>O projekcie</h1>
        <p class="tagline">Sailboats &mdash; multiplayer symulator żeglarski w czasie rzeczywistym</p>
      </header>

      <section class="card">
        <h2>Autor</h2>
        <p><strong>Jakub Kmita</strong>&nbsp;<span class="nick">(c3r83r)</span></p>
        <p>
          Cześć! Sailboats to mój projekt portfolio &mdash; rozwijam go, żeby na żywym, działającym przykładzie
          poćwiczyć projektowanie systemu mikroserwisowego z komunikacją w czasie rzeczywistym, a nie tylko czytać
          o tym w teorii. Zależy mi na pokazaniu pełnego stacku: od bazy danych, przez WebSockety i logikę
          symulacji, po front w Angularze.
        </p>
      </section>

      <section class="card">
        <h2>Stack technologiczny</h2>
        <div class="stack-grid">
          <div class="stack-group" *ngFor="let group of stackGroups">
            <h3>{{ group.title }}</h3>
            <ul>
              <li *ngFor="let item of group.items">{{ item }}</li>
            </ul>
          </div>
        </div>
      </section>

      <section class="card">
        <h2>Ciekawe elementy architektury</h2>
        <ul class="highlights">
          <li>
            Backend podzielony na niezależne mikroserwisy (auth, fleet, simulation, telemetry) połączone
            wspólną biblioteką DTO (<code>common-lib</code>), każdy z własną bazą danych.
          </li>
          <li>
            Silnik symulacji działa w czasie rzeczywistym po surowym WebSocket (bez STOMP) &mdash; wiele
            niezależnych „akwenów” (lakes) tick'owanych równolegle, z botami, wiatrem i pociskami.
          </li>
          <li>
            Uwierzytelnianie WS przez token JWT przekazywany w handshake, z 45-sekundowym oknem na
            reconnect, żeby chwilowa utrata połączenia (np. zmiana karty) nie wyrzucała gracza z akwenu.
          </li>
          <li>
            Krótkotrwały access token + rotowany refresh token w ciasteczku HttpOnly, żeby sesja przeżyła
            odświeżenie strony bez trzymania długożyjącego tokenu po stronie klienta.
          </li>
        </ul>
      </section>

      <section class="card">
        <h2>Kontakt</h2>
        <div class="contact-links">
          <a href="https://github.com/c3r83r/sailboats" target="_blank" rel="noopener noreferrer" class="contact-link">
            GitHub &mdash; repozytorium projektu
          </a>
          <span class="contact-link muted">E-mail &mdash; wkrótce</span>
        </div>
      </section>
    </main>
  `,
  styles: [
    `
    :host {
      display: block;
      min-height: 100vh;
      background: radial-gradient(circle at 20% -10%, #123048, #050c16 60%);
      color: #eaf6ff;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }

    .about {
      max-width: 760px;
      margin: 0 auto;
      padding: 32px 20px 64px;
      display: grid;
      gap: 20px;
    }

    .back-link {
      color: rgba(143, 227, 255, 0.85);
      text-decoration: none;
      font-weight: 700;
      font-size: 0.9rem;
      justify-self: start;
    }

    .back-link:hover {
      color: #eaf6ff;
      text-decoration: underline;
    }

    .about-head {
      display: grid;
      gap: 6px;
      margin-bottom: 4px;
    }

    h1 {
      margin: 0;
      letter-spacing: 0.06em;
      font-weight: 800;
      font-size: clamp(1.8rem, 4vw, 2.4rem);
      background: linear-gradient(90deg, #8fe3ff, #ffd166);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
    }

    .tagline {
      margin: 0;
      opacity: 0.75;
    }

    .card {
      background: rgba(6, 24, 41, 0.68);
      border: 1px solid rgba(143, 227, 255, 0.14);
      border-radius: 16px;
      padding: 20px 22px;
      box-shadow: 0 12px 28px rgba(0, 0, 0, 0.18);
    }

    .card h2 {
      margin: 0 0 10px;
      font-size: 1.1rem;
      letter-spacing: 0.04em;
      color: #8fe3ff;
    }

    .card p {
      margin: 0 0 8px;
      line-height: 1.5;
      opacity: 0.9;
    }

    .card p:last-child {
      margin-bottom: 0;
    }

    .nick {
      opacity: 0.65;
      font-size: 0.9rem;
    }

    .stack-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
    }

    .stack-group h3 {
      margin: 0 0 6px;
      font-size: 0.85rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: rgba(216, 244, 255, 0.78);
    }

    .stack-group ul {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 4px;
      font-size: 0.9rem;
      opacity: 0.9;
    }

    .highlights {
      margin: 0;
      padding-left: 18px;
      display: grid;
      gap: 10px;
      line-height: 1.5;
      opacity: 0.9;
    }

    .highlights code {
      background: rgba(143, 227, 255, 0.12);
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 0.85em;
    }

    .contact-links {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }

    .contact-link {
      display: inline-block;
      padding: 9px 16px;
      border-radius: 999px;
      border: 1px solid rgba(143, 227, 255, 0.4);
      background: rgba(143, 227, 255, 0.12);
      color: #d8f4ff;
      font-weight: 700;
      font-size: 0.85rem;
      text-decoration: none;
      transition: background 0.15s ease;
    }

    .contact-link:hover {
      background: rgba(143, 227, 255, 0.24);
    }

    .contact-link.muted {
      opacity: 0.55;
      border-style: dashed;
      cursor: default;
    }
    `,
  ],
})
export class AboutComponent {
  readonly stackGroups: StackGroup[] = [
    {
      title: 'Backend',
      items: [
        'Java 21, Spring Boot 3.3',
        'Maven multi-moduł (4 mikroserwisy + common-lib)',
        'Spring Data JPA, Liquibase',
        'JWT (access + rotowany refresh token)',
        'Spring WebSocket (surowy protokół)',
      ],
    },
    {
      title: 'Bazy danych',
      items: ['PostgreSQL 16', 'MS SQL Server 2022 (telemetria)', 'Redis'],
    },
    {
      title: 'Frontend',
      items: ['Angular 17 (standalone)', 'NgRx (store + effects)', 'RxJS', 'TailwindCSS'],
    },
    {
      title: 'Infrastruktura',
      items: ['Docker Compose', 'Caddy jako edge proxy (produkcja)'],
    },
  ];
}
