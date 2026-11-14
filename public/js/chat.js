// Chattruta för ett rum: ett parti ("game:<id>"), en turnering ("tournament:<id>") eller en klubb ("club:<id>").
import { h, state, titleEl, userLink } from './util.js';
import { net, send, on } from './net.js';

export function chatBox(room, { readonly = false } = {}) {
  const log = h('div.chatlog');
  const input = h('input', { placeholder: readonly ? 'Bara spelarna kan skriva här' : 'Skriv ett meddelande…', maxlength: 200, disabled: readonly || !state.user });
  const el = h('div.chat', h('h3', 'Chatt'), log,
    h('form.inline', {
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (text) send({ t: 'chat', room, text });
        input.value = '';
      },
    }, input, h('button', { type: 'submit', disabled: readonly || !state.user }, 'Skicka')));
  const line = (m) => h('p', titleEl(m.title), ' ', userLink(m.user), ': ', m.text);
  const empty = () => { if (!log.children.length) log.append(h('p.muted', 'Inga meddelanden ännu.')); };
  const sub = () => send({ t: 'sub', room });
  const off = on((m) => {
    if (m.t === 'conn' && net.connected) sub();
    if (m.room !== room) return;
    if (m.t === 'chatlog') { log.replaceChildren(...m.messages.map(line)); empty(); }
    if (m.t === 'chat') {
      if (log.querySelector('.muted')) log.replaceChildren();
      log.append(line(m.message));
    }
    log.scrollTop = log.scrollHeight;
  });
  empty();
  sub();
  return { el, destroy() { off(); send({ t: 'unsub', room }); } };
}
