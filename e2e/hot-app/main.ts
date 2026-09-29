import { mount } from 'thane';
import { HotApp } from './app.js';

mount({ component: HotApp, target: document.getElementById('app')! });
