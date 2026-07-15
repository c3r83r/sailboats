# Roadmapa rozwoju Sailboats

Cel: rozbudować projekt tak, aby jednocześnie lepiej wyglądał jako portfolio i miał mocniejszą pętlę gry.

## Faza 1: portfolio i szybki efekt

1. Publiczny licznik użytkowników.
   - liczba zarejestrowanych kont
   - liczba aktywnych użytkowników w oknie czasu
   - widoczny na stronie głównej lub w panelu statystyk

2. Strona „O mnie”.
   - krótki opis autora i celu projektu
   - użyty stack i najciekawsze elementy architektury
   - sekcja kontaktowa lub linki do profili

3. Szybka poprawa oprawy wizualnej.
   - lepszy HUD
   - bardziej czytelna typografia i kontrast
   - ulepszone fale, niebo, woda i elementy mapy

## Faza 2: ekonomia i progresja

4. Coiny zbierane podczas żeglugi.
   - zbieranie monet w świecie
   - nagrody za eksplorację i zadania
   - prosty licznik waluty po stronie gracza

5. Sklep i ulepszenia statku.
   - prędkość, zwrotność, wytrzymałość, odporność na sztorm
   - ulepszenia funkcjonalne i kosmetyczne
   - balans kosztów, żeby progres miał sens

6. Lekka pętla nagród.
   - proste cele dzienne / kontrakty
   - premie za dopłynięcie do portu
   - zachęta do dalszej eksploracji

## Faza 3: świat i systemy mapy

7. Zmienna pogoda.
   - wiatr, sztorm, mgła, spokojne dni
   - wpływ na sterowanie i widoczność
   - bezpieczne schronienia podczas trudnych warunków

8. Bogatsza mapa.
   - porty jako huby
   - szuwary, płycizny i miejsca do przetrwania sztormu
   - większe zróżnicowanie wysp pod względem rozmiaru i zawartości

9. Tawerny i sklepy w świecie.
   - handel
   - naprawy
   - plotki, zadania i wskazówki o świecie

## Faza 4: większy skok jakości wizualnej

10. Lepsza grafika.
    - styl 2.5D jako najbardziej opłacalny kierunek
    - ewentualnie pełniejsze 3D, jeśli chcesz większy refactor
    - spójniejsza prezentacja wysp, statków i wody

## Kolejność wdrożenia

1. Publiczny licznik użytkowników.
2. Strona „O mnie”.
3. Poprawa UI i wizualnego klimatu.
4. Coiny i sklep z ulepszeniami.
5. Pogoda.
6. Porty, tawerny i różne typy wysp.
7. Duży upgrade grafiki.

## Pierwszy krok techniczny

Najrozsądniej zacząć od dwóch rzeczy równolegle:

- dodać frontendową stronę „O mnie”
- wystawić backendowy endpoint ze statystyką użytkowników

To daje szybki efekt widoczny dla odwiedzających i przygotowuje grunt pod dalszą rozbudowę.