import { TestBed } from '@angular/core/testing';
import { ChatHistory } from './chat-history';

describe('ChatHistory', () => {
  it('shows a placeholder when there are no messages', async () => {
    const fixture = TestBed.createComponent(ChatHistory);
    fixture.componentRef.setInput('messages', []);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.empty')).toBeTruthy();
    expect(el.querySelectorAll('.message').length).toBe(0);
  });

  it('renders user and assistant messages with their alignment classes', async () => {
    const fixture = TestBed.createComponent(ChatHistory);
    fixture.componentRef.setInput('messages', [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
    await fixture.whenStable();
    const messages = (fixture.nativeElement as HTMLElement).querySelectorAll('.message');

    expect(messages.length).toBe(2);
    expect(messages[0].classList).toContain('user');
    expect(messages[0].textContent).toBe('hi');
    expect(messages[1].classList).toContain('assistant');
    expect(messages[1].textContent).toBe('hello');
  });
});
