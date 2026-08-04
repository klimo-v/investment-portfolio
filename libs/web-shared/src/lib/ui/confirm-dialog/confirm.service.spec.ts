import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmService } from './confirm.service';

describe('ConfirmService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideNoopAnimations()] });
  });

  afterEach(() => {
    TestBed.inject(MatDialog).closeAll();
    TestBed.resetTestingModule();
  });

  it('показывает заголовок и текст, «Подтвердить» резолвит true', async () => {
    const service = TestBed.inject(ConfirmService);
    const answer = service.ask({ title: 'Удалить операции?', message: 'Действие необратимо.' });
    TestBed.tick();

    expect(document.body.textContent).toContain('Удалить операции?');
    expect(document.body.textContent).toContain('Действие необратимо.');

    clickButton('Подтвердить');
    expect(await answer).toBe(true);
  });

  it('«Отмена» резолвит false — по умолчанию действие НЕ выполняется', async () => {
    const service = TestBed.inject(ConfirmService);
    const answer = service.ask({ title: 'Удалить?', message: 'Точно?' });
    TestBed.tick();

    clickButton('Отмена');
    expect(await answer).toBe(false);
  });

  it('закрытие мимо кнопок (Esc, клик вне окна) трактуется как отказ, а не как согласие', async () => {
    const service = TestBed.inject(ConfirmService);
    const answer = service.ask({ title: 'Удалить?', message: 'Точно?' });
    TestBed.tick();

    // afterClosed() без результата отдаёт undefined — сервис обязан свести это к false
    TestBed.inject(MatDialog).closeAll();
    TestBed.tick();

    expect(await answer).toBe(false);
  });

  it('подписи кнопок настраиваются', async () => {
    const service = TestBed.inject(ConfirmService);
    const answer = service.ask({
      title: 'Откатить импорт?',
      message: 'Операции батча будут удалены.',
      confirmLabel: 'Откатить',
      cancelLabel: 'Оставить',
    });
    TestBed.tick();

    expect(document.body.textContent).toContain('Откатить');
    expect(document.body.textContent).toContain('Оставить');

    clickButton('Оставить');
    expect(await answer).toBe(false);
  });
});

/** Ищет кнопку в оверлее по видимому тексту — так же, как её нашёл бы пользователь */
function clickButton(text: string): void {
  const button = [...document.body.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith(text),
  );
  if (!button) throw new Error(`Кнопка «${text}» не найдена в диалоге`);
  button.click();
  TestBed.tick();
}
