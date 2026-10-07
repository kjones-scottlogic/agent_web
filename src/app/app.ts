import { Component } from '@angular/core';
import { Chat } from './chat/chat';

@Component({
  imports: [Chat],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {}
