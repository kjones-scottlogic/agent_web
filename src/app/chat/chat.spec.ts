import { TestBed } from '@angular/core/testing';
import { Chat } from './chat';
import { ChatService } from './chat.service';

describe('Chat', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Chat],
      providers: [{ provide: ChatService, useValue: { reply: async (m: string) => `echo ${m}` } }],
    }).compileComponents();
  });

  it('shows the user message and the response with the right alignment classes', async () => {
    const fixture = TestBed.createComponent(Chat);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector('input')!;
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    const messages = el.querySelectorAll('.message');
    expect(messages.length).toBe(2);
    expect(messages[0].classList).toContain('user');
    expect(messages[0].textContent).toBe('hello');
    expect(messages[1].classList).toContain('assistant');
    expect(messages[1].textContent).toBe('echo hello');
    expect(input.value).toBe('');
  });

  it('shows an error message when the reply fails', async () => {
    TestBed.overrideProvider(ChatService, {
      useValue: { reply: async () => Promise.reject(new Error('offline')) },
    });
    const fixture = TestBed.createComponent(Chat);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const input = el.querySelector('input')!;
    input.value = 'hello';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();

    const messages = el.querySelectorAll('.message');
    expect(messages.length).toBe(2);
    expect(messages[1].classList).toContain('error');
  });
});
