import { effect, inject } from '@angular/core';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  Tooltip,
} from 'chart.js';
import { provideCharts } from 'ng2-charts';
import { chartDefaultColors, ThemeService } from '@web-shared';

/**
 * Регистрация Chart.js — ровно тем, что приложение рисует, и НЕ в app.config.ts.
 *
 * Было `provideCharts(withDefaultRegisterables())` в корневой конфигурации, и это
 * стоило дорого дважды: `withDefaultRegisterables()` тянет ВСЕ контроллеры
 * (radar, polarArea, bubble, scatter — ни один не используется), а корневая
 * конфигурация входит в initial-бандл, хотя графики живут только на двух ленивых
 * страницах. В собранном main-чанке лежал весь Chart.js целиком.
 *
 * Теперь провайдер подключается в `providers` самих компонентов дашборда и
 * портфеля: `provideCharts()` возвращает обычный provider (не EnvironmentProviders),
 * а `BaseChartDirective` читает конфигурацию через element-инжектор — значит
 * видит providers компонента, в шаблоне которого стоит. Chart.js попадает в
 * общий ленивый чанк этих двух страниц и не грузится, пока туда не зайдут.
 *
 * Правило при добавлении графика нового типа: дописать сюда его контроллер и
 * элемент, иначе Chart.js бросит «"…" is not a registered controller» в рантайме.
 * Список намеренно явный — это и есть плата за размер бандла.
 */
export const provideAppCharts = () =>
  provideCharts({
    registerables: [
      // Типы графиков: линия (динамика, бенчмарк), столбцы (P&L, потоки),
      // бублик (распределение по типам инструментов)
      LineController,
      LineElement,
      PointElement,
      BarController,
      BarElement,
      DoughnutController,
      ArcElement,
      // Оси: категориальная (даты/тикеры) и числовая (рубли/проценты)
      CategoryScale,
      LinearScale,
      // Плагины: подсказка при наведении и легенда
      Tooltip,
      Legend,
    ],
  });

/**
 * Держит глобальные дефолты Chart.js (цвет подписей, сетки, шрифт) в согласии с
 * темой. Эти значения живут в JS и на CSS-токены не реагируют — без них в тёмной
 * теме оси, легенда и сетка почти невидимы.
 *
 * Раньше этот effect стоял в `ThemeService`, то есть в корневом сервисе, который
 * поднимается вместе с оболочкой приложения. Один `import { Chart }` ради записи
 * `Chart.defaults` затаскивал весь Chart.js в initial-бандл — ровно то, ради чего
 * затевался `provideAppCharts()`. Теперь синхронизация вызывается страницами с
 * графиками, в их ленивом чанке.
 *
 * Вызывать в контексте инъекции (инициализатор поля компонента), как `mediaQuery()`.
 */
export function syncChartDefaultsWithTheme(): void {
  const theme = inject(ThemeService);
  effect(() => {
    const { color, borderColor } = chartDefaultColors(theme.isDark());
    Chart.defaults.color = color;
    Chart.defaults.borderColor = borderColor;
    Chart.defaults.font.family = "Roboto, 'Helvetica Neue', sans-serif";
  });
}
