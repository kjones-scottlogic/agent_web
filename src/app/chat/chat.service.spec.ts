import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ChatService } from './chat.service';

describe('ChatService', () => {
  let service: ChatService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(ChatService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('sends the topic and returns the reply text', async () => {
    const reply = service.reply('Solar power');
    await Promise.resolve();
    const req = http.expectOne('/api/chat');
    expect(req.request.body).toEqual({ topic: 'Solar power' });
    req.flush({ text: 'Subtopics: ...' });

    expect(await reply).toBe('Subtopics: ...');
  });
});
