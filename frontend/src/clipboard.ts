import { ClipboardSchema } from './validation.ts';

export class ClipboardSync {
  private token: string | null = null;
  private csrfToken = '';
  private txtArea: HTMLTextAreaElement;
  private btnSend: HTMLButtonElement;
  private btnRecv: HTMLButtonElement;

  constructor() {
    this.txtArea = document.getElementById('txt-clipboard') as HTMLTextAreaElement;
    this.btnSend = document.getElementById('btn-clipboard-send') as HTMLButtonElement;
    this.btnRecv = document.getElementById('btn-clipboard-recv') as HTMLButtonElement;

    this.btnSend.addEventListener('click', () => this.pushToHost());
    this.btnRecv.addEventListener('click', () => this.pullFromHost());
  }

  /**
   * Updates authorization token for requests.
   */
  public setToken(token: string | null) {
    this.token = token;
  }

  /**
   * Updates CSRF session token.
   */
  public setCsrfToken(csrfToken: string) {
    this.csrfToken = csrfToken;
  }

  /**
   * Sends client textarea text contents to the remote host.
   */
  public async pushToHost() {
    if (!this.token) {
      return;
    }
    const val = this.txtArea.value;

    const parsed = ClipboardSchema.safeParse({ data: val });
    if (!parsed.success) {
      alert('Sync aborted: content length exceeds 100KB buffer.');
      return;
    }

    try {
      this.btnSend.disabled = true;
      const originalText = this.btnSend.textContent;
      this.btnSend.textContent = 'Syncing...';

      const res = await fetch('/api/clipboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': this.csrfToken
        },
        credentials: 'same-origin',
        body: JSON.stringify(parsed.data)
      });

      if (!res.ok) {
        throw new Error('Host rejected clipboard payload');
      }

      this.btnSend.textContent = 'Synchronized!';
      setTimeout(() => {
        this.btnSend.textContent = originalText;
        this.btnSend.disabled = false;
      }, 1200);
    } catch (err) {
      console.error('[ClipboardSync] Push failed:', err);
      alert('Failed to update host clipboard');
      this.btnSend.disabled = false;
      this.btnSend.textContent = 'Push To Host';
    }
  }

  /**
   * Fetches remote clipboard contents and populates local elements.
   */
  public async pullFromHost() {
    if (!this.token) {
      return;
    }

    try {
      this.btnRecv.disabled = true;
      const originalText = this.btnRecv.textContent;
      this.btnRecv.textContent = 'Fetching...';

      const res = await fetch('/api/clipboard', {
        method: 'GET',
        credentials: 'same-origin'
      });

      if (!res.ok) {
        throw new Error('Host rejected clipboard query');
      }

      const payload = await res.json();
      const text = payload.data || '';
      
      this.txtArea.value = text;

      // Attempt web-native clipboard override
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        console.debug('[ClipboardSync] Browser permission blocked native copy. Content stored in text area:', err);
      }

      this.btnRecv.textContent = 'Retrieved!';
      setTimeout(() => {
        this.btnRecv.textContent = originalText;
        this.btnRecv.disabled = false;
      }, 1200);
    } catch (err) {
      console.error('[ClipboardSync] Pull failed:', err);
      alert('Failed to retrieve host clipboard data');
      this.btnRecv.disabled = false;
      this.btnRecv.textContent = 'Pull From Host';
    }
  }
}
