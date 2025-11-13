import { TestServer } from '../test-utils/test-server.js';

describe('UI Routing', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = new TestServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /', () => {
    it('should serve messenger.html by default', async () => {
      const response = await fetch(`${server.url}/`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('messenger.js');
      expect(html).toContain('Messenger'); // Title or content specific to messenger UI
    });
  });

  describe('GET /legacy', () => {
    it('should always serve index.html', async () => {
      const response = await fetch(`${server.url}/legacy`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('app.js');
      expect(html).not.toContain('messenger.js');
    });
  });

  describe('GET /messenger', () => {
    it('should always serve messenger.html', async () => {
      const response = await fetch(`${server.url}/messenger`);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(html).toContain('messenger.js');
    });
  });
});
